'use strict';
// GATE (2026-07-25 incident → check, not memory): any column introduced by a
// MANUAL/out-of-band migration must be referenced DEFENSIVELY on server.js query
// paths until that migration is confirmed applied in prod. An unguarded reference
// to a not-yet-existing column errors the query — and on a hot path (dispatch,
// status) that took prod down (the demo-column incident) or 500'd every job (the
// ask-column latent bug).
//
// Enforcement: every Supabase FILTER (.eq/.neq/.gt/.gte/.lt/.lte/.in/.is) or
// .select() reference to a PENDING column in server.js must carry a
// `migration-guarded[<col>]` marker within 10 lines — the marker sits next to the
// actual fallback/flag-gate. Add a column to PENDING when you author its migration;
// REMOVE it (and its now-dead fallbacks) once the migration is confirmed applied.
//
// This is deliberately conservative (filters + selects only, not object-key writes)
// to stay false-positive-free on common words like "demo"/"ask".

const fs = require('fs');
const path = require('path');

// Columns whose migration is authored but NOT yet confirmed live in prod.
// Add a column here the moment you author its migration (the gate then forces a
// `migration-guarded[<col>]` marker + fallback on every server.js reference); REMOVE
// it once the migration is confirmed applied AND the fallbacks are cleaned up.
// (demo/ask/post_package applied + cleaned 2026-07-26.)
//   preview — §5 worker-owned JSONB column (add-preview-to-video-jobs). Applied
//   (being corrected boolean→JSONB, 2026-07-26). server.js never references it (the
//   capability flows via the Modal payload; the worker writes the column), so it's
//   off the gate. The gate stays armed for the next server-referenced manual column.
const PENDING = [];

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').split('\n');
const filterRe = (c) => new RegExp(`\\.(eq|neq|gt|gte|lt|lte|in|is|contains|match)\\(\\s*['"\`]${c}['"\`]`);
const selectRe = (c) => new RegExp(`\\.select\\(\\s*[\`'"][^\`'"]*\\b${c}\\b`);
const marker = (c) => `migration-guarded[${c}]`;

const violations = [];
for (const col of PENDING) {
  const fr = filterRe(col);
  const sr = selectRe(col);
  for (let i = 0; i < src.length; i++) {
    if (!fr.test(src[i]) && !sr.test(src[i])) continue;
    const lo = Math.max(0, i - 10);
    const hi = Math.min(src.length, i + 11);
    if (!src.slice(lo, hi).join('\n').includes(marker(col))) {
      violations.push(`  server.js:${i + 1}  unguarded '${col}': ${src[i].trim().slice(0, 78)}`);
    }
  }
}

if (violations.length) {
  console.error('pending-migration-columns: unguarded references (add fallback + marker, or drop from PENDING once applied):');
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log(PENDING.length
  ? `pending-migration guard OK — ${PENDING.join(', ')} refs all carry a migration-guarded marker`
  : 'pending-migration guard OK — no columns pending (gate armed for the next manual migration)');
