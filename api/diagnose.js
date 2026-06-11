// /api/diagnose.js — Google Gemini proxy/adapter. Key stays server-side.
// Set GEMINI_API_KEY in Vercel → Settings → Environment Variables.
// Optional: GEMINI_MODEL (default gemini-2.5-flash), KB_SHARED_SECRET (gate the
// endpoint), KV (logs diagnose volume).
//
// This is an adapter: it accepts the same {system, messages, max_tokens} shape the
// client already sends (Anthropic-style), translates it to Gemini's generateContent
// format, then reshapes Gemini's reply back into {content:[{type:'text',text}]} so the
// front-end's parsing, multi-turn flow and offline fallback keep working unchanged.
import { kv, kvReady } from './_kv.js';

const WINDOW_MS = 60000;
const MAX_PER_WINDOW = 20;          // per-IP, per minute (per warm instance)
const hits = new Map();             // ip -> [timestamps]
const DEFAULT_MODEL = 'gemini-2.5-flash';

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > MAX_PER_WINDOW;
}

// Anthropic-style messages -> Gemini "contents" (assistant -> model).
function toGeminiContents(messages) {
  return (messages || []).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
  }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-kb-secret');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // optional shared-secret gate
  const secret = process.env.KB_SHARED_SECRET;
  if (secret && req.headers['x-kb-secret'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const ip = (req.headers['x-forwarded-for'] || 'local').split(',')[0].trim();
  if (rateLimited(ip)) return res.status(429).json({ error: 'rate limit — slow down a moment' });

  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });

  try {
    const { system, messages, max_tokens = 1000 } = req.body || {};
    if (!messages) return res.status(400).json({ error: 'messages required' });

    const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    const generationConfig = { maxOutputTokens: max_tokens, temperature: 0.2 };
    // Only force strict JSON when there's a system prompt (the real diagnosis path);
    // the lightweight capability probe sends no system and just checks for a 2xx.
    if (system) generationConfig.responseMimeType = 'application/json';
    // 2.5 models enable "thinking" by default, which spends the output-token budget
    // and can truncate the JSON. This is a fast KB matcher, not a reasoning task —
    // disable thinking (only 2.5 supports thinkingConfig; older models would 400).
    if (model.includes('2.5')) generationConfig.thinkingConfig = { thinkingBudget: 0 };

    const body = {
      contents: toGeminiContents(messages),
      generationConfig,
      // Support troubleshooting text occasionally trips default safety filters
      // (registry edits, "kill" the process, etc.) — don't let that block a fix.
      safetySettings: [
        'HARM_CATEGORY_HARASSMENT',
        'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        'HARM_CATEGORY_DANGEROUS_CONTENT',
      ].map((category) => ({ category, threshold: 'BLOCK_NONE' })),
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
    const g = await upstream.json();

    if (!upstream.ok) {
      const msg = (g && g.error && g.error.message) || ('Gemini error ' + upstream.status);
      return res.status(upstream.status).json({ error: msg });
    }

    // Reshape Gemini -> the {content:[{type:'text',text}]} shape the client parses.
    const cand = (g.candidates && g.candidates[0]) || null;
    const text = cand && cand.content && cand.content.parts
      ? cand.content.parts.map((p) => p.text || '').join('')
      : '';
    if (!text) {
      const reason = (cand && cand.finishReason)
        || (g.promptFeedback && g.promptFeedback.blockReason)
        || 'empty response';
      return res.status(502).json({ error: 'Gemini returned no text (' + reason + ')' });
    }

    if (kvReady && max_tokens > 50) {
      const day = new Date().toISOString().slice(0, 10);
      kv.hincr('stats:diagnose', day, 1).catch(() => {});
    }
    return res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (err) {
    return res.status(502).json({ error: 'Upstream failed: ' + err.message });
  }
}
