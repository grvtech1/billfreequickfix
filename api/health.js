// /api/health.js — cheap capability probe for the front-end status line.
// Reports whether the AI and KV are *configured* WITHOUT calling the paid Gemini
// upstream. The old probe fired a real generateContent request on every page
// load, which burned quota and consumed a rate-limit slot per load.
import { applyCors } from './_gate.js';

export default function handler(req, res) {
  if (applyCors(req, res, 'GET, OPTIONS')) return;
  const ai = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  const kv = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ai, kv });
}
