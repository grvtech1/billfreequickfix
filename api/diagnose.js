// /api/diagnose.js — Anthropic proxy. Key stays server-side.
// Set ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables.
// Optional: KB_SHARED_SECRET (gate the endpoint), KV (logs diagnose volume).
import { kv, kvReady } from './_kv.js';

const WINDOW_MS = 60000;
const MAX_PER_WINDOW = 20;          // per-IP, per minute (per warm instance)
const hits = new Map();             // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > MAX_PER_WINDOW;
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

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'Server missing ANTHROPIC_API_KEY' });

  try {
    const { system, messages, max_tokens = 1000, model = 'claude-sonnet-4-20250514' } = req.body || {};
    if (!messages) return res.status(400).json({ error: 'messages required' });

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens, system, messages }),
    });
    const data = await upstream.json();

    if (kvReady && max_tokens > 50) {
      const day = new Date().toISOString().slice(0, 10);
      kv.hincr('stats:diagnose', day, 1).catch(() => {});
    }
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Upstream failed: ' + err.message });
  }
}
