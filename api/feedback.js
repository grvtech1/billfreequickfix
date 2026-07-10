// /api/feedback.js — records "did this fix work?" per KB record.
// Body: { id, vote: "up"|"down", note?: string }
// Stores counters in KV when configured; always console.logs as a fallback signal.
import { kv, kvReady } from './_kv.js';
import { applyCors, denySecret, rateLimited, redactPII } from './_gate.js';

const ID_RE = /^[a-z0-9-]{1,64}$/; // KB ids are lowercase kebab slugs

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (denySecret(req, res)) return;
  if (await rateLimited(req, { max: 60, windowSec: 60 })) {
    return res.status(429).json({ error: 'rate limit' });
  }

  try {
    const { id, vote, note } = req.body || {};
    if (typeof id !== 'string' || !ID_RE.test(id) || !['up', 'down'].includes(vote)) {
      return res.status(400).json({ error: 'valid id and vote(up|down) required' });
    }

    const safeNote = redactPII((note || '').slice(0, 300)); // strip phone/MID from staff notes
    console.log(JSON.stringify({ kind: 'feedback', t: Date.now(), id, vote, note: safeNote.slice(0, 200) }));

    if (kvReady) {
      await kv.hincr(`fb:${id}`, vote, 1).catch(() => {});
      if (vote === 'down') {
        // down-votes (esp. with a note) are the re-authoring queue
        await kv.lpush('queue:reauthor', JSON.stringify({ t: Date.now(), id, note: safeNote })).catch(() => {});
        await kv.ltrim('queue:reauthor', 0, 199).catch(() => {});
      }
    }
    return res.status(200).json({ ok: true, stored: kvReady });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
