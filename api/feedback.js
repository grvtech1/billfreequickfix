// /api/feedback.js — records "did this fix work?" per KB record.
// Body: { id, vote: "up"|"down", note?: string }
// Stores counters in KV when configured; always console.logs as a fallback signal.
import { kv, kvReady } from './_kv.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { id, vote, note } = req.body || {};
    if (!id || !['up', 'down'].includes(vote)) return res.status(400).json({ error: 'id and vote(up|down) required' });

    console.log(JSON.stringify({ kind: 'feedback', t: Date.now(), id, vote, note: (note || '').slice(0, 200) }));

    if (kvReady) {
      await kv.hincr(`fb:${id}`, vote, 1).catch(() => {});
      if (vote === 'down') {
        // down-votes (esp. with a note) are the re-authoring queue
        await kv.lpush('queue:reauthor', JSON.stringify({ t: Date.now(), id, note: (note || '').slice(0, 300) })).catch(() => {});
        await kv.ltrim('queue:reauthor', 0, 199).catch(() => {});
      }
    }
    return res.status(200).json({ ok: true, stored: kvReady });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
