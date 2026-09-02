#!/usr/bin/env node
'use strict';
// NO-DELIVERY BACKFILL (Zac 2026-08-02, direct write-access task).
// A completed job whose render SUCCEEDED (result.video_url present) but whose
// top-level delivery columns (rendered_video_url) never got written → the user
// sees a finished job with NO video. The MP4/HLS/thumbnail already exist in
// CloudFront; this is a PROJECTION from result{} onto the columns SSEClient
// reads, NOT a re-render. Equivalent to Zac's SQL:
//
//   UPDATE video_jobs
//   SET rendered_video_url = result->>'video_url',
//       hls_manifest_url   = result->>'hls_manifest_url',
//       thumbnail_url      = result->>'thumbnail_url',
//       completed_at       = COALESCE(completed_at, updated_at)
//   WHERE status='completed' AND rendered_video_url IS NULL
//     AND result->>'video_url' IS NOT NULL;
//
// DRY-RUN by default (prints the cohort + count). Writes ONLY with --commit,
// and per Zac's gate refuses to write unless the count matches --expect.
//
//   node scripts/backfill_no_delivery.js              # dry run
//   node scripts/backfill_no_delivery.js --commit --expect 9
require('dotenv').config({ path: '.env.local' });
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('missing SUPABASE url/service-role key in .env.local'); process.exit(1); }
const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

const COMMIT = process.argv.includes('--commit');
const expectIdx = process.argv.indexOf('--expect');
const EXPECT = expectIdx >= 0 ? Number(process.argv[expectIdx + 1]) : null;

(async () => {
  // Fetch every completed row whose rendered_video_url is NULL. Filter for a
  // present result.video_url in JS so we SEE exactly what we're about to write.
  const sel = 'select=id,user_id,status,result,updated_at,completed_at,rendered_video_url,hls_manifest_url,thumbnail_url';
  const r = await fetch(`${url}/rest/v1/video_jobs?status=eq.completed&rendered_video_url=is.null&${sel}&limit=1000`, { headers: H });
  if (!r.ok) { console.error('fetch failed', r.status, await r.text()); process.exit(1); }
  const rows = await r.json();

  const targets = rows.filter((j) => j.result && j.result.video_url);
  console.log(`\ncompleted + rendered_video_url IS NULL: ${rows.length} rows`);
  console.log(`  of those, result.video_url PRESENT (backfill targets): ${targets.length}`);
  console.log(`  (excluded: ${rows.length - targets.length} completed-null rows with NO result.video_url — genuine no-render, not this class)\n`);

  for (const j of targets) {
    const R = j.result || {};
    console.log(`  ${j.id}  user=${j.user_id || 'NULL'}  video_url=${R.video_url ? 'Y' : '-'} hls=${R.hls_manifest_url ? 'Y' : '-'} thumb=${R.thumbnail_url ? 'Y' : '-'}  completed_at=${j.completed_at ? 'set' : 'NULL→updated_at'}`);
  }

  if (!COMMIT) {
    console.log(`\n[DRY RUN] ${targets.length} rows would be projected. Re-run with:  --commit --expect ${targets.length}`);
    return;
  }
  if (EXPECT === null || EXPECT !== targets.length) {
    console.error(`\n[ABORT] --expect ${EXPECT} != actual ${targets.length}. Zac's gate: count must match before committing. No write performed.`);
    process.exit(1);
  }

  console.log(`\n[COMMIT] projecting ${targets.length} rows...`);
  let ok = 0, fail = 0;
  for (const j of targets) {
    const R = j.result || {};
    const patch = {
      rendered_video_url: R.video_url,
      hls_manifest_url: R.hls_manifest_url ?? null,
      thumbnail_url: R.thumbnail_url ?? null,
      completed_at: j.completed_at || j.updated_at,
    };
    const pr = await fetch(`${url}/rest/v1/video_jobs?id=eq.${encodeURIComponent(j.id)}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(patch),
    });
    if (!pr.ok) { fail++; console.error(`  FAIL ${j.id}: ${pr.status} ${await pr.text()}`); continue; }
    const back = (await pr.json())[0] || {};
    const verified = back.rendered_video_url === R.video_url;
    console.log(`  ${verified ? 'OK  ' : 'WARN'} ${j.id}  rendered_video_url ${verified ? 'now set' : 'MISMATCH'}`);
    verified ? ok++ : fail++;
  }
  console.log(`\n[DONE] ${ok} projected & verified, ${fail} failed / ${targets.length} targets.`);
  process.exit(fail ? 1 : 0);
})();
