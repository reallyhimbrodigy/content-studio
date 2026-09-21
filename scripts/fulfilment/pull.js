// READ-ONLY corpus pull. No writes, no migrations.
const ENV = require('./env.js')();
const fs = require('fs');
const U = ENV.SUPABASE_URL, K = ENV.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}` };
const OUT = process.argv[2];
const SINCE = new Date(Date.now() - 30 * 864e5).toISOString();

async function pageAll(q) {
  const out = []; let from = 0; const step = 1000;
  for (;;) {
    const r = await fetch(`${U}/rest/v1/${q}`, { headers: { ...H, Range: `${from}-${from + step - 1}` } });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    const b = await r.json();
    out.push(...b);
    if (b.length < step) break;
    from += step;
  }
  return out;
}
(async () => {
  const cols = 'id,created_at,user_id,status,vibe_input,change_request,content_type,source_type,source_duration,pipeline,parent_job_id,reedit_mode,demo';
  const rows = await pageAll(`video_jobs?select=${cols}&created_at=gte.${SINCE}&order=created_at.asc`);
  fs.writeFileSync(OUT, rows.map(r => JSON.stringify(r)).join('\n'));
  // all-time volume, head-count only (no body)
  const r2 = await fetch(`${U}/rest/v1/video_jobs?select=id&limit=1`,
    { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
  const total = (r2.headers.get('content-range') || '').split('/')[1];
  console.log(JSON.stringify({
    since: SINCE, rows_30d: rows.length, all_time_total: total,
    with_vibe: rows.filter(r => r.vibe_input && String(r.vibe_input).trim()).length,
    distinct_users: new Set(rows.map(r => r.user_id)).size,
    statuses: rows.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {}),
    pipelines: rows.reduce((a, r) => (a[r.pipeline || 'null'] = (a[r.pipeline || 'null'] || 0) + 1, a), {}),
  }, null, 1));
})();
