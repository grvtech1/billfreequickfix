import { kv, kvReady } from './_kv.js';

// _gate.js — shared CORS + auth for every /api function.
// The front-end is served from the SAME Vercel origin as these functions, so
// same-origin calls need no CORS header at all. We therefore default to
// NOT emitting `Access-Control-Allow-Origin: *` (which previously let any page
// on the internet call these endpoints from a staff member's browser).
//
// If you ever host the client on a different origin, set ALLOWED_ORIGINS to a
// comma-separated allow-list; only a matching Origin is reflected back.

const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Apply CORS + preflight handling. Returns true if the request was a preflight
// (already answered) and the caller should stop.
export function applyCors(req, res, methods = 'POST, OPTIONS') {
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-kb-secret');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

// Enforce the shared secret when KB_SHARED_SECRET is configured. Returns true if
// the request was rejected (caller should stop). Uses a length-safe compare.
export function denySecret(req, res) {
  const secret = process.env.KB_SHARED_SECRET;
  if (!secret) return false; // gate disabled → allow (dev / open deployments)
  const got = req.headers['x-kb-secret'];
  if (typeof got !== 'string' || !timingSafeEqual(got, secret)) {
    res.status(401).json({ error: 'unauthorized' });
    return true;
  }
  return false;
}

// Soft check (no response written): true when a secret is configured AND the
// caller presents the matching value. Used by /api/kb to decide whether to
// include internal-only records, without 401-ing unauthenticated callers.
export function hasValidSecret(req) {
  const secret = process.env.KB_SHARED_SECRET;
  if (!secret) return false;
  const got = req.headers['x-kb-secret'];
  return typeof got === 'string' && timingSafeEqual(got, secret);
}

// Whether a secret gate is configured at all.
export function secretConfigured() {
  return !!process.env.KB_SHARED_SECRET;
}

// Constant-time string compare to avoid leaking the secret via timing.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Best-effort client IP that is NOT spoofable via a client-supplied header.
// Vercel sets x-vercel-forwarded-for to the real edge-observed client IP.
export function clientIp(req) {
  const vercel = req.headers['x-vercel-forwarded-for'];
  if (typeof vercel === 'string' && vercel) return vercel.split(',')[0].trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',').pop().trim(); // last hop
  return 'local';
}

// Distributed fixed-window rate limiter. When KV is configured the counter is
// shared across all serverless instances (the in-memory Map it replaces only
// limited per warm instance, so N instances = N× the intended ceiling).
// Falls back to a per-instance Map when KV is absent so dev still has a guard.
const memWindows = new Map(); // ip -> [timestamps]  (fallback only)

export async function rateLimited(ip, { max = 20, windowSec = 60 } = {}) {
  if (kvReady) {
    const bucket = Math.floor(Date.now() / 1000 / windowSec);
    const key = `rate:${ip}:${bucket}`;
    try {
      const n = await kv.incr(key);
      if (n === 1) await kv.expire(key, windowSec * 2).catch(() => {});
      return n > max;
    } catch {
      // KV hiccup → fail open rather than lock everyone out
      return false;
    }
  }
  const now = Date.now();
  const winMs = windowSec * 1000;
  const arr = (memWindows.get(ip) || []).filter((t) => now - t < winMs);
  arr.push(now);
  memWindows.set(ip, arr);
  return arr.length > max;
}
