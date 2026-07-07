// _kv.js — tiny Upstash Redis REST helper. No npm dependency.
// Lights up when KV_REST_API_URL + KV_REST_API_TOKEN are set (Vercel → Storage → connect KV/Upstash).
// If not configured, all calls no-op (and callers fall back to console.log), so the app deploys as-is.

const URL = process.env.KV_REST_API_URL;
const TOKEN = process.env.KV_REST_API_TOKEN;
export const kvReady = !!(URL && TOKEN);

async function cmd(args) {
  if (!kvReady) return null;
  const r = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error('kv ' + r.status);
  const j = await r.json();
  return j.result;
}

export const kv = {
  incr: (key) => cmd(['INCR', key]),
  hincr: (key, field, n = 1) => cmd(['HINCRBY', key, field, n]),
  hgetall: async (key) => {
    const flat = await cmd(['HGETALL', key]);
    if (!Array.isArray(flat)) return {};
    const o = {};
    for (let i = 0; i < flat.length; i += 2) o[flat[i]] = flat[i + 1];
    return o;
  },
  lpush: (key, val) => cmd(['LPUSH', key, val]),
  ltrim: (key, a, b) => cmd(['LTRIM', key, a, b]),
  lrange: (key, a, b) => cmd(['LRANGE', key, a, b]),
  zincr: (key, member, n = 1) => cmd(['ZINCRBY', key, n, member]),
  zrevrange: (key, a, b) => cmd(['ZREVRANGE', key, a, b, 'WITHSCORES']),
  expire: (key, seconds) => cmd(['EXPIRE', key, seconds]),
};
