#!/usr/bin/env node
'use strict';
// Reconcile "the nine" vs the 3 rows matching Zac's exact WHERE. Look across ALL
// statuses for rows that have a real render (result.video_url) but whose
// top-level rendered_video_url is NULL — grouped by status — and also count the
// _isNoDelivery definition (rendered_video_url AND hls_manifest_url both null).
require('dotenv').config({ path: '.env.local' });
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: key, Authorization: `Bearer ${key}` };

async function page(path) {
  let all = [], from = 0;
  for (;;) {
    const r = await fetch(`${url}/rest/v1/${path}&limit=1000&offset=${from}`, { headers: H });
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) break;
    all.push(...j); from += j.length;
    if (j.length < 1000) break;
  }
  return all;
}

(async () => {
  // Every row whose rendered_video_url is NULL, any status, with result + timestamps.
  const rows = await page('video_jobs?rendered_video_url=is.null&select=id,user_id,status,result,rendered_video_url,hls_manifest_url,thumbnail_url,created_at,updated_at,completed_at');
  console.log(`\nrows with rendered_video_url IS NULL (any status): ${rows.length}`);

  const withRender = rows.filter((j) => j.result && j.result.video_url);
  console.log(`  of those, result.video_url PRESENT (a real render exists → recoverable): ${withRender.length}\n`);

  const byStatus = {};
  for (const j of withRender) {
    (byStatus[j.status || 'null'] ||= []).push(j);
  }
  for (const [st, js] of Object.entries(byStatus).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  status=${st}: ${js.length}`);
    for (const j of js) {
      const d = (j.created_at || '').slice(0, 10);
      console.log(`      ${j.id}  user=${(j.user_id || 'NULL').slice(0, 8)}  ${d}  hls=${j.result.hls_manifest_url ? 'Y' : '-'} thumb=${j.result.thumbnail_url ? 'Y' : '-'}`);
    }
  }

  // The _isNoDelivery definition the bleed-meter uses (both top-level cols null).
  const noDelivery = rows.filter((j) => !j.rendered_video_url && !j.hls_manifest_url);
  console.log(`\n_isNoDelivery def (rendered_video_url AND hls_manifest_url both NULL, any status): ${noDelivery.length}`);
  console.log(`  of those completed: ${noDelivery.filter((j) => j.status === 'completed').length}`);
  console.log(`  of those with a recoverable result.video_url: ${noDelivery.filter((j) => j.result && j.result.video_url).length}`);
})();
