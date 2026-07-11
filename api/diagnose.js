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
import { applyCors, denySecret, rateLimited, redactPII } from './_gate.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_OUTPUT_TOKENS = 1500;     // server ceiling — client cannot exceed this
const UPSTREAM_TIMEOUT_MS = 25000;  // leave headroom under the 30s function limit

// Anthropic-style messages -> Gemini "contents" (assistant -> model).
// PII (mobile numbers, MIDs) is redacted before the text leaves for Google —
// those digits are never diagnostic, so the AI loses nothing useful.
function toGeminiContents(messages) {
  return (messages || []).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: redactPII(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) }],
  }));
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (denySecret(req, res)) return;

  if (await rateLimited(req, { max: 20, windowSec: 60 })) {
    return res.status(429).json({ error: 'rate limit — slow down a moment' });
  }

  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });

  try {
    const { system, messages, max_tokens } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages required' });
    }
    // Clamp the output budget: the client requests it, but the server sets the ceiling.
    const outTokens = Math.min(Math.max(Number(max_tokens) || 1000, 1), MAX_OUTPUT_TOKENS);

    const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    const generationConfig = { maxOutputTokens: outTokens, temperature: 0.2 };
    // Only force strict JSON when there's a system prompt (the real diagnosis path);
    // the lightweight capability probe sends no system and just checks for a 2xx.
    if (system) generationConfig.responseMimeType = 'application/json';
    // 2.5 models enable "thinking" by default, which spends the output-token budget
    // and can truncate the JSON. This is a fast KB matcher, not a reasoning task —
    // disable thinking (only 2.5 supports thinkingConfig; older models would 400).
    if (model.startsWith('gemini-2.5')) generationConfig.thinkingConfig = { thinkingBudget: 0 };

    const body = {
      contents: toGeminiContents(messages),
      generationConfig,
      // Support-troubleshooting text (registry edits, "kill" the process, terminal
      // commands) occasionally trips the default safety filters. We relax only to
      // BLOCK_ONLY_HIGH — enough to let legitimate fixes through, but NOT the
      // blanket BLOCK_NONE this endpoint used to run with.
      safetySettings: [
        'HARM_CATEGORY_HARASSMENT',
        'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        'HARM_CATEGORY_DANGEROUS_CONTENT',
      ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream, g;
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      // Gemini can return HTML on some 5xx responses; guard the JSON parse so a
      // parse error doesn't mask the real upstream status.
      const raw = await upstream.text();
      try { g = JSON.parse(raw); } catch { g = null; }
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok) {
      // Log the detailed upstream error server-side; return a generic status to
      // the client so we don't leak key/quota state (403/429 specifics).
      console.error(JSON.stringify({ kind: 'gemini_error', status: upstream.status, detail: g && g.error && g.error.message }));
      return res.status(502).json({ error: 'AI service error (' + upstream.status + ')' });
    }
    if (!g) return res.status(502).json({ error: 'AI service returned an unreadable response' });

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

    if (kvReady && outTokens > 50) {
      const day = new Date().toISOString().slice(0, 10);
      kv.hincr('stats:diagnose', day, 1).catch(() => {});
    }
    return res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    console.error(JSON.stringify({ kind: 'diagnose_fail', aborted, detail: err && err.message }));
    return res.status(aborted ? 504 : 502).json({ error: aborted ? 'AI service timed out' : 'AI service unavailable' });
  }
}
