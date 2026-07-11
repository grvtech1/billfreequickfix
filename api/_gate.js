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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-kb-secret, x-kb-client');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

// Enforce the shared secret. Returns true if the request was rejected (caller
// should stop). Uses a length-safe compare.
//
// Fail-closed opt-in: set KB_REQUIRE_SECRET=1 to assert "this deployment MUST be
// gated". If the secret is then missing (e.g. env accidentally cleared), paid/
// write endpoints refuse to serve rather than silently running wide open. Without
// that flag, a missing secret leaves the endpoint open (dev / intentionally-open
// deployments) — unchanged behaviour.
export function denySecret(req, res) {
  const secret = process.env.KB_SHARED_SECRET;
  if (!secret) {
    if (isTruthy(process.env.KB_REQUIRE_SECRET)) {
      res.status(503).json({ error: 'endpoint not configured (KB_SHARED_SECRET missing)' });
      return true;
    }
    return false; // gate disabled → allow (dev / open deployments)
  }
  const got = req.headers['x-kb-secret'];
  if (typeof got !== 'string' || !timingSafeEqual(got, secret)) {
    res.status(401).json({ error: 'unauthorized' });
    return true;
  }
  return false;
}

const isTruthy = (v) => v === '1' || v === 'true' || v === 'yes';

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

// Redact likely PII before anything is logged or stored: runs of 6+ digits are
// almost always a mobile number, MID, or license/dongle number. Real search
// tokens ("0x709", "a4", "net 4.5") are shorter and survive. Applied to search
// queries and feedback notes so raw customer numbers never land in logs or KV.
export function redactPII(s) {
  if (typeof s !== 'string') return s;
  // 6+ digit runs (optionally spaced/dashed): mobile numbers, MIDs, licenses.
  return s.replace(/\d[\d\s-]{4,}\d/g, '[redacted]');
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

// A stable per-agent id the client persists in localStorage and sends as
// x-kb-client. Lets us rate-limit an individual agent rather than a whole
// office NAT — several agents behind ONE public IP no longer starve each
// other's budget. Falls back to IP when absent. Format-validated so it can't
// be used to inject a weird KV key.
export function clientKey(req) {
  const c = req.headers['x-kb-client'];
  if (typeof c === 'string' && /^[a-z0-9]{6,40}$/i.test(c)) return 'c:' + c;
  return 'ip:' + clientIp(req);
}

// One fixed-window counter. KV-backed (shared across instances) when configured;
// per-instance Map otherwise so dev still has a guard.
const memWindows = new Map();
async function overLimit(key, max, windowSec) {
  if (kvReady) {
    const bucket = Math.floor(Date.now() / 1000 / windowSec);
    const k = `rate:${key}:${bucket}`;
    try {
      const n = await kv.incr(k);
      if (n === 1) await kv.expire(k, windowSec * 2).catch(() => {});
      return n > max;
    } catch {
      return false; // KV hiccup → fail open, don't lock everyone out
    }
  }
  const now = Date.now();
  const winMs = windowSec * 1000;
  const arr = (memWindows.get(k(key, windowSec)) || []).filter((t) => now - t < winMs);
  arr.push(now);
  memWindows.set(k(key, windowSec), arr);
  return arr.length > max;
}
const k = (key, w) => `${key}:${Math.floor(Date.now() / 1000 / w)}`;

// Two-tier limiter. Pass the REQUEST (not an ip string):
//   • per-agent  (x-kb-client, or IP fallback) at `max`/window — the real limit
//   • per-IP backstop at `ipMax`/window — only when a client id is present, so
//     someone rotating client ids can't exceed a sane whole-IP ceiling.
export async function rateLimited(req, { max = 20, windowSec = 60, ipMax = 120 } = {}) {
  const agent = clientKey(req);
  if (await overLimit(agent, max, windowSec)) return true;
  const ipTier = 'ip:' + clientIp(req);
  if (agent !== ipTier && (await overLimit(ipTier, ipMax, windowSec))) return true;
  return false;
}
