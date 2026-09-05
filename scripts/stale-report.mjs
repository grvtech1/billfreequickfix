// scripts/stale-report.mjs — which records go "stale" (6-month rule) and when.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const recs = JSON.parse(readFileSync(join(ROOT, 'kb', 'billfree-kb.json'), 'utf8')).records;
const STALE_MONTHS = 6;
const now = new Date(); const nowM = now.getFullYear() * 12 + now.getMonth();
const rows = recs.map((r) => {
  if (!r.last_verified) return { id: r.id, lv: '(none)', age: 999, left: -999 };
  const [y, m] = r.last_verified.split('-').map(Number);
  const age = nowM - (y * 12 + (m - 1));
  return { id: r.id, lv: r.last_verified, age, left: STALE_MONTHS - age };
}).sort((a, b) => b.age - a.age);
const byLv = {};
rows.forEach((x) => { byLv[x.lv] = (byLv[x.lv] || 0) + 1; });
console.log('Records by last_verified:', JSON.stringify(byLv));
const stale = rows.filter((x) => x.left <= 0);
const soon = rows.filter((x) => x.left > 0 && x.left <= 3);
console.log(`\nALREADY STALE (>${STALE_MONTHS} mo): ${stale.length}`);
stale.forEach((x) => console.log(`  ${x.id}  (${x.lv})`));
console.log(`\nGO STALE WITHIN 3 MONTHS: ${soon.length}`);
soon.forEach((x) => console.log(`  ${x.id}  (${x.lv}, ${x.left} mo left)`));
if (stale.length + soon.length > recs.length * 0.5) {
  console.log(`\n⚠ ${stale.length + soon.length}/${recs.length} records stale or expiring — when everything is flagged, nothing is. Plan a verification sweep.`);
}
