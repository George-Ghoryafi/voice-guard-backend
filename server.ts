import express from 'express';
import type { Request, Response } from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { DeepgramClient } from '@deepgram/sdk';
import { checkCompliance } from './compliance.ts';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));

const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = 5050;
let activeCall = false;

const deepgram = new DeepgramClient({ apiKey: process.env['DEEPGRAM_API_KEY']! });

// ── Server-Sent Events (Frontend Broadcaster) ─────────────────────────────────

let frontendClients: Response[] = [];

app.get('/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    frontendClients.push(res);
    console.log('💻 Frontend dashboard connected');

    req.on('close', () => {
        frontendClients = frontendClients.filter(c => c !== res);
        console.log('💻 Frontend dashboard disconnected');
    });
});

function broadcastToFrontend(data: any) {
    frontendClients.forEach(client => {
        client.write(`data: ${JSON.stringify(data)}\n\n`);
    });
}

// ── Twilio Webhook ─────────────────────────────────────────────────────────────
// Responds with TwiML that opens a bi-directional media stream over WebSocket.

app.post('/incoming-call', (req: Request, res: Response) => {
    const host = req.headers.host;
    console.log(`\n📞 Incoming call from ${req.body?.From ?? 'unknown'}`);

    const twiml = `
        <Response>
            <Say>Connecting to Voice Guard. Start speaking now.</Say>
            <Connect>
                <Stream url="wss://${host}/media-stream" />
            </Connect>
            <Pause length="30" />
        </Response>
    `;

    res.type('text/xml');
    res.send(twiml);
});

// ── Twilio Media Stream Handler ────────────────────────────────────────────────
// Each WebSocket connection represents one active phone call. Audio is piped to
// Deepgram for transcription, then each final utterance is run through the
// compliance engine and broadcast to all connected frontend clients via SSE.

wss.on('connection', async (ws) => {
    if (activeCall) {
        console.log('⚠️ Call already active — rejecting');
        ws.close();
        return;
    }
    activeCall = true;
    console.log('🔌 Twilio media stream connected');
    broadcastToFrontend({ type: 'call_start' });

    // Open a live Deepgram transcription session (mulaw 8kHz mono — Twilio's format)
    const dgConnection = await deepgram.listen.v1.connect({
        Authorization: `Token ${process.env['DEEPGRAM_API_KEY']!}`,
        model: 'nova-3',
        encoding: 'mulaw',
        sample_rate: 8000,
        channels: 1,
        punctuate: 'true',
        interim_results: 'true',
        endpointing: 300,
        utterance_end_ms: 1000,
    });

    // Rolling buffer of recent transcripts for cross-chunk PII context
    const recentChunks: string[] = [];
    const MAX_CONTEXT_CHUNKS = 3;

    dgConnection.on('open', () => console.log('🟢 Deepgram connected'));

    dgConnection.on('message', async (data) => {
        if (data.type !== 'Results') return;

        const transcript = data.channel.alternatives[0]?.transcript;
        if (!transcript || transcript.trim().length === 0) return;

        const tag = data.is_final ? '✅ FINAL' : '⏳ INTERIM';
        console.log(`[${tag}]: ${transcript}`);

        if (data.is_final) {
            const result = await checkCompliance(transcript, [...recentChunks]);
            recentChunks.push(transcript);
            if (recentChunks.length > MAX_CONTEXT_CHUNKS) recentChunks.shift();

            console.log(`[COMPLIANCE]: ${JSON.stringify(result, null, 2)}`);
            broadcastToFrontend({ type: 'transcript', ...result });
        } else {
            broadcastToFrontend({ type: 'interim', text: transcript });
        }
    });

    dgConnection.on('error', (err) => console.error('❗ Deepgram error:', err));
    dgConnection.on('close', () => console.log('🔴 Deepgram disconnected'));

    dgConnection.connect();
    await dgConnection.waitForOpen();

    // Forward Twilio audio frames to Deepgram
    ws.on('message', (message: string) => {
        const msg = JSON.parse(message);

        if (msg.event === 'media') {
            dgConnection.sendMedia(Buffer.from(msg.media.payload, 'base64'));
        }

        if (msg.event === 'stop') {
            console.log('🛑 Twilio stopped the media stream');
            dgConnection.close();
        }
    });

    ws.on('close', () => {
        console.log('❌ Call ended');
        activeCall = false;
        dgConnection.close();
        broadcastToFrontend({ type: 'call_end' });
    });
});

// ── Start ──────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});