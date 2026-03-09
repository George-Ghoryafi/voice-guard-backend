import Groq from 'groq-sdk';
import dotenv from 'dotenv';

dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Spoken-Word Number Normalizer ──────────────────────────────────────────────
// Transcription engines emit digit words ("five five five") instead of numerals.
// These helpers convert spoken digits for internal pattern matching only.

const WORD_TO_DIGIT: Record<string, string> = {
    zero: '0', oh: '0', o: '0',
    one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9',
};

function isSpokenDigitSequence(text: string): boolean {
    const words = text.replace(/[.,!?]/g, '').trim().split(/\s+/);
    return words.length >= 2 && words.every(w => WORD_TO_DIGIT[w.toLowerCase()] !== undefined);
}

function wordsToDigitString(text: string): string {
    return text.replace(/[.,!?]/g, '').trim().split(/\s+/)
        .map(w => WORD_TO_DIGIT[w.toLowerCase()] ?? w)
        .join('');
}

// ── Regex Shield ───────────────────────────────────────────────────────────────
// Three-layer deterministic redaction that runs before the LLM, ensuring PII
// is stripped even if inference is slow or unavailable.

function applyRegexShield(transcript: string): string {
    let text = transcript;

    // Layer 1 — Same-chunk spoken-digit anchors (e.g. "My SSN is five five five")
    const digitWord = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)';

    const ssnSpoken = new RegExp(
        `((?:ssn|social security|social)\\s+(?:is|number is|number)?\\s*)((?:${digitWord}\\s*){3,})`, 'gi'
    );
    text = text.replace(ssnSpoken, (_m, prefix) => `${prefix}[SSN REDACTED]`);

    const cardSpoken = new RegExp(
        `((?:card|card number|visa|mastercard|credit card|debit card)\\s+(?:is|number is|number)?\\s*)((?:${digitWord}\\s*){3,})`, 'gi'
    );
    text = text.replace(cardSpoken, (_m, prefix) => `${prefix}[CREDIT CARD REDACTED]`);

    // Layer 2 — Anchor + numeric digits (e.g. "SSN 123456789")
    text = text.replace(
        /(?:ssn|social security|social)[^\d]{0,25}?((?:\d\s*){9,11})/gi,
        (m, p1) => m.replace(p1, '[SSN REDACTED]')
    );
    text = text.replace(
        /(?:card|card number|visa|mastercard)[^\d]{0,25}?((?:\d\s*){13,16})/gi,
        (m, p1) => m.replace(p1, '[CREDIT CARD REDACTED]')
    );

    // Layer 3 — Structural fallback (no anchor required)
    const fallbacks = [
        { tag: 'PHONE',        re: /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g },
        { tag: 'EMAIL',        re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g },
        { tag: 'SSN_FALLBACK', re: /\b(?:\d[\s-]*){9}\b/g },
    ];
    for (const { tag, re } of fallbacks) {
        text = text.replace(re, `[${tag} REDACTED]`);
    }

    return text;
}

// ── Cross-Chunk PII Detector ───────────────────────────────────────────────────
// Deepgram may split an utterance across chunks (e.g. "My SSN is" | "five five five").
// This function checks whether a digit-only chunk is the continuation of a PII
// anchor that appeared in a recent prior chunk.

function detectCrossChunkPII(current: string, priorChunks: string[]): string | null {
    if (!isSpokenDigitSequence(current)) return null;

    const context = priorChunks.join(' ');

    if (/\b(?:ssn|social security(?: number)?|social)\b/i.test(context)) return '[SSN REDACTED]';
    if (/\b(?:card number|card|visa|mastercard|credit card|debit card)\b/i.test(context)) return '[CREDIT CARD REDACTED]';

    // 9+ spoken digits with no anchor — redact conservatively
    if (wordsToDigitString(current).length >= 9) return '[SSN_FALLBACK REDACTED]';

    return null;
}

// ── LLM System Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are a real-time compliance and telemetry proxy for an enterprise debt collection AI.
Analyze the user's transcribed sentence and output a STRICT JSON object.

RULE 1: DATA REDACTION & PRESERVATION
- Your primary job for the "redacted_text" field is to COPY the user's exact sentence word-for-word.
- ONLY replace First, Middle and Last Names, Addresses, and Dates of Birth with [REDACTED]. 
- CRITICAL: If the sentence already contains a tag like [SSN_FALLBACK REDACTED], [PHONE REDACTED], or [CREDIT CARD REDACTED], YOU MUST PRESERVE THAT TAG EXACTLY AS IS. Do not alter it or collapse the sentence.
- CRITICAL: Do NOT truncate, summarize, or delete any non-sensitive words.
- If there is no sensitive data, the "redacted_text" MUST exactly match the "original_text".

RULE 2: COMPLIANCE VIOLATIONS (FDCPA)
Set "is_violation" to true IF the caller uses:
- Threats of physical violence or harm.
- Profane, obscene, or abusive language.
- Threats of jail time, arrest, or police involvement.
- Threats to contact the caller's employer or family regarding the debt.

RULE 3: CALLER INTENT & LEGAL TRIGGERS
Evaluate the caller's intent and set the following booleans to true if applicable:
- "disputing_debt": The caller claims they do not owe the money or it is fraud.
- "promise_to_pay": The caller agrees to make a payment now or in the future.
- "cease_and_desist": The caller explicitly tells you to stop calling them.
- "attorney_represented": The caller states they have a lawyer handling this.
- "bankruptcy": The caller mentions they have filed for bankruptcy.

STRICT JSON OUTPUT FORMAT:
{
  "original_text": "string",
  "redacted_text": "string",
  "compliance": {
    "is_violation": boolean,
    "violation_reason": "string or null"
  },
  "intents": {
    "disputing_debt": boolean,
    "promise_to_pay": boolean,
    "cease_and_desist": boolean,
    "attorney_represented": boolean,
    "bankruptcy": boolean
  }
}
`;

// ── Public API ─────────────────────────────────────────────────────────────────

const DEFAULT_INTENTS = {
    disputing_debt: false, promise_to_pay: false, cease_and_desist: false,
    attorney_represented: false, bankruptcy: false,
};

export async function checkCompliance(transcript: string, priorChunks: string[]) {
    // 1. Cross-chunk PII: anchor in a prior chunk + spoken digits in this chunk
    const crossChunkTag = detectCrossChunkPII(transcript, priorChunks);
    if (crossChunkTag) {
        return {
            original_text: transcript,
            redacted_text: crossChunkTag,
            compliance: { is_violation: false, violation_reason: null },
            intents: { ...DEFAULT_INTENTS },
            skipped_llm: true,
        };
    }

    // 2. Single-chunk regex shield
    const shielded = applyRegexShield(transcript);

    // Short utterances skip LLM inference
    if (shielded.split(' ').length < 4) {
        return {
            original_text: transcript,
            redacted_text: shielded,
            compliance: { is_violation: false, violation_reason: null },
            intents: { ...DEFAULT_INTENTS },
            skipped_llm: true,
        };
    }

    // 3. LLM pass — handles names, addresses, DOBs, compliance, and intents
    try {
        const response = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: shielded },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.1,
        });

        return response.choices[0]
            ? JSON.parse(response.choices[0].message.content || '{}')
            : {};
    } catch (error) {
        console.error('Groq inference error:', error);
        return null;
    }
}