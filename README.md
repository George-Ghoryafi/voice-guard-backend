# VoiceGuard Backend — Real-Time Telephony Compliance Server

The backend is a Node.js orchestration server that sits between Twilio's telephony infrastructure and the frontend dashboard. It receives live phone call audio, transcribes it in real-time, runs every utterance through a multi-layer compliance engine, and streams the results to connected clients.

## Architecture

```
Twilio (Phone Call)
  │  WebSocket (mulaw audio frames)
  ▼
server.ts ──── Deepgram Nova-3 (Speech-to-Text)
  │                  │
  │                  ▼  is_final transcript
  │            compliance.ts
  │              ┌──────────┐
  │              │ Regex    │ ← Deterministic PII stripping
  │              │ Shield   │   (SSNs, cards, phones, emails)
  │              ├──────────┤
  │              │ Groq LLM │ ← Semantic analysis
  │              │ (Llama 3)│   (names, addresses, FDCPA, intents)
  │              └──────────┘
  │                  │
  ▼                  ▼
Frontend Clients (SSE)
```

## File Overview

### `server.ts`

The central orchestration layer. Responsibilities:

- **Twilio webhook** (`POST /incoming-call`) — responds with TwiML that opens a bi-directional media stream over WebSocket
- **Media stream handler** (`wss.on('connection')`) — receives base64-encoded mulaw audio frames from Twilio, decodes them, and forwards the raw bytes to Deepgram
- **Utterance buffering** — accumulates finalized transcript chunks into a buffer, then flushes and processes them as a single cohesive sentence once Deepgram signals an `utterance_end` (a pause in speech). This produces clean, complete thoughts instead of fragmented chunks
- **SSE broadcaster** (`GET /events`) — maintains a list of connected frontend clients and pushes typed events (`call_start`, `call_end`, `transcript`, `interim`) to all of them in real-time
- **Single-call enforcement** — only one call is processed at a time; concurrent connections are rejected

### `compliance.ts`

A two-stage compliance pipeline that guarantees PII is redacted even if LLM inference is slow or fails.

**Stage 1 — Regex Shield** (deterministic, zero-latency)

Three layers of pattern matching run synchronously before the LLM:

| Layer | Detection Method | Targets |
|-------|-----------------|---------|
| Spoken-digit anchors | Anchor keyword + spoken number words (`"five five five"`) | SSNs, credit cards spoken aloud |
| Numeric anchors | Anchor keyword + digit characters | SSNs, credit cards typed/dictated |
| Structural fallback | Pattern matching without anchors | Phone numbers, emails, 9-digit sequences |

A **cross-chunk detector** handles cases where the transcription engine splits PII across utterance boundaries (e.g., `"My SSN is"` in one chunk, `"five five five"` in the next) by maintaining a rolling context buffer of prior chunks.

**Stage 2 — LLM Inference** (semantic, ~150ms via Groq)

Utterances that pass the regex shield are sent to Groq's Llama 3.1 8B model for deeper analysis:

- **PII redaction** — names, addresses, dates of birth (entities that regex can't reliably catch)
- **FDCPA compliance** — flags threats, profanity, and intimidation as violations
- **Intent classification** — detects disputing debt, promise to pay, cease and desist, attorney representation, and bankruptcy signals

## Third-Party Services

| Service | Purpose | Protocol |
|---------|---------|----------|
| **Twilio** | Telephony gateway — answers calls and streams audio via the Media Streams API | WebSocket (mulaw 8kHz mono) |
| **Deepgram** | Speech-to-text — Nova-3 model with interim results, punctuation, and utterance endpointing | WebSocket |
| **Groq** | LLM inference — Llama 3.1 8B with structured JSON output for compliance analysis | REST API |

## SSE Event Types

| Event | Payload | When |
|-------|---------|------|
| `call_start` | `{}` | Twilio media stream connects |
| `call_end` | `{}` | Twilio media stream disconnects |
| `transcript` | `{ original_text, redacted_text, compliance, intents }` | Utterance fully processed |
| `interim` | `{ text }` | Partial transcription (live typing effect) |

## Demo Tradeoffs vs Production

This project is built as a technical demo optimized for zero cost and minimal infrastructure. Below are the deliberate tradeoffs made and what a production deployment would look like.

### 1. The Brain Upgrade: Llama 3.3 70B on Groq

| | Demo | Production |
|--|------|-----------|
| **Model** | `llama-3.1-8b-instant` | `llama-3.3-70b-versatile` |
| **Provider** | Groq (free tier) | Groq (paid) — still the fastest option due to their custom LPU hardware |
| **Latency** | ~150ms | ~300ms |

Even with an unlimited budget, Groq would likely remain the inference provider of choice — their custom LPU silicon is purpose-built for sequential token generation and consistently outperforms GPU-based alternatives on latency benchmarks.

The model upgrade is where the real gains are. An 8B parameter model is fast and handles straightforward cases well, but it can be easily confused by sarcasm, double negatives, or convoluted legal language:

> *"I'm not saying I won't pay, but my lawyer said if you guys don't stop calling my mom, I'm going to have to file Chapter 7, even though I don't want to."*

This single sentence contains an **attorney representation** signal, a **cease and desist** demand, a **bankruptcy** intent, and a potential **FDCPA violation** (contacting family). A 70B model has near GPT-4 level reasoning — it untangles all four signals correctly and produces near-zero false positives, while still returning structured JSON in roughly 300ms.

### 2. The Acoustic Upgrade: Emotion AI

The current pipeline only analyzes **transcribed text** — it has no awareness of vocal tone, pitch, or emotional state. In real-world telephony, *how* something is said matters just as much as *what* is said.

A caller calmly stating *"I will find where you live"* and a caller **screaming** it at the top of their lungs have completely different risk profiles, but the text transcript is identical.

With an unlimited budget, the raw WebSocket audio would be piped directly into a multimodal audio model (GPT-4o Realtime API, Gemini Multimodal Live API, or a specialized engine like Hume AI). Instead of just outputting `is_violation: true`, the system would return an enriched telemetry payload:

```json
{
  "is_violation": true,
  "violation_reason": "Threat of physical harm",
  "anger_score": 0.98,
  "stress_level": "high",
  "recommended_action": "route_to_de_escalation_agent"
}
```

This enables real-time intelligent call routing — furiously angry callers are instantly transferred to trained de-escalation agents, improving both safety outcomes and caller experience.

### 3. The Security Upgrade: Private VPC Deployment

In the current architecture, transcript data travels over the public internet to Groq's API. This is acceptable for a demo, but an enterprise client (a bank, a large debt buyer) operating under SOC 2 or PCI-DSS would never allow PII to leave their network perimeter.

The production approach: rent dedicated hardware (bare-metal GPU or LPU clusters) and host the 70B model entirely inside a private Virtual Private Cloud.

Because the AI lives behind the organization's firewall, the **Regex Shield is completely deleted**. There is no need to pre-strip PII before inference — the LLM processes the raw transcript, logs it securely to an internal database, and handles redaction as post-processing. This is faster (one pass instead of two), perfectly secure, and passes the strictest compliance audits automatically.

| Concern | Demo | Production (VPC) |
|---------|------|-----------------|
| **PII exposure** | Sent to Groq over public internet (regex shield required) | Never leaves the private network |
| **Compliance** | Best-effort | SOC 2, PCI-DSS, HIPAA ready |
| **Regex Shield** | Required as a safety net | Eliminated — LLM handles everything |
| **Cost** | Free | Significant hardware investment |

### Concurrency

The server currently enforces **single-call processing** — a deliberate simplification so the frontend doesn't need session management. In production:

- A message queue (Redis Streams, SQS) would decouple call ingestion from compliance processing
- Each call would have a unique session ID, with transcripts routed to per-session SSE channels
- Horizontal scaling via container orchestration (ECS, Kubernetes) to handle hundreds of concurrent calls

### Authentication & Authorization

There is no auth on any endpoint. In production:

- The `/events` SSE endpoint would require a JWT or API key scoped to specific call sessions
- The Twilio webhook (`/incoming-call`) would validate the `X-Twilio-Signature` header to prevent spoofed requests
- The dashboard would sit behind an SSO provider (Okta, Auth0)

### Data Persistence

Transcripts are currently ephemeral — they exist only in the frontend's React state and are lost on page refresh. In production:

- Every compliance result would be written to a database (Supabase/PostgreSQL) with the call SID, timestamp, and agent ID
- Redacted and original transcripts would be stored separately, with access to originals restricted by role-based permissions
- Call recordings would be archived to S3/GCS with configurable retention policies

### Infrastructure

| Concern | Demo | Production |
|---------|------|-----------|
| **Hosting** | Local + ngrok tunnel | Cloud VPC with private subnets |
| **TLS** | ngrok provides HTTPS | Managed certificates (ACM, Let's Encrypt) |
| **Monitoring** | Console logs | Structured logging (Datadog, CloudWatch) with latency percentile dashboards |
| **Failover** | None — single process | Multi-AZ deployment with health checks and auto-restart |
