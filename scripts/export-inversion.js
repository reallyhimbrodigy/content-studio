#!/usr/bin/env node
'use strict';
/**
 * LANE 1 / JUDGE — Step 1: kill or confirm the export inversion.
 *
 * Claim under test (QUALITY_FAULT_ROADMAP.md, worker repo): standard editorial
 * exports at 9.9% while near-passthrough moodreel exports at 20%.
 *
 * Method:
 *  - Join export_completed / result_viewed analytics events to video_jobs by
 *    props.job_id (DIRECT join — both events carry job_id [MEASURED]).
 *  - CLEAN COHORT: jobs created >= 2026-08-01T00:00:00Z. export_completed's
 *    earliest event is 2026-08-01 [MEASURED]; jobs older than the event's birth
 *    could never log an export, and route age-mix differs, so an all-time cut
 *    is differentially deflated. Window is stated on every number.
 *  - Route key: result->>route. ABSENCE of the key on a completed job =
 *    standard editorial (the lean routes carry route: minimal |
 *    minimal_speech_uncut | moodreel | hype). Failed jobs have result=NULL ->
 *    route reads null; we only bucket COMPLETED jobs.
 *  - Two denominators reported: export/completed and export/viewed (viewed
 *    removes the "never came back" leg of the funnel).
 *  - Confound cuts: source_duration bucket x route; per-user views.
 *  - PostgREST caps 1000 rows/request -> paginate everything.
 *
 * READ-ONLY: SELECTs only. Zero Modal spend.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local'), quiet: true });
// worktree has no .env.local of its own — fall back to the primary checkout's
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: '/Users/zaclibman/content-studio/.env.local', quiet: true });
}
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const WINDOW_START = '2026-08-01T00:00:00Z';

async function pageAll(path, params) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${URL_}/rest/v1/${path}?${params}&limit=1000&offset=${off}`, { headers: H });
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error(`${path}: ${JSON.stringify(rows).slice(0, 200)}`);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : 'n/a');
const durBucket = (d) => (d == null || d <= 0) ? 'unknown' : d < 20 ? '0-20s' : d < 60 ? '20-60s' : d < 120 ? '60-120s' : '120s+';

(async () => {
  // ── pulls (paginated) ──────────────────────────────────────────────
  const exports_ = await pageAll('analytics_events', `event=eq.export_completed&select=props,user_id,created_at&order=created_at.asc`);
  const views = await pageAll('analytics_events', `event=eq.result_viewed&select=props,created_at&order=created_at.asc`);
  const jobs = await pageAll('video_jobs', `created_at=gte.${WINDOW_START}&select=id,status,user_id,source_duration,created_at,route:result->>route&order=created_at.asc`);

  const exportedJobIds = new Set(), exportMethods = {};
  for (const e of exports_) {
    const jid = e.props && e.props.job_id;
    if (jid) exportedJobIds.add(jid);
    const m = (e.props && e.props.method) || 'unknown';
    exportMethods[m] = (exportMethods[m] || 0) + 1;
  }
  const viewedJobIds = new Set();
  for (const v of views) { const jid = v.props && v.props.job_id; if (jid) viewedJobIds.add(jid); }

  const completed = jobs.filter(j => j.status === 'completed');
  const routeOf = (j) => j.route || 'standard_editorial'; // absence of key = standard editorial

  console.log(`WINDOW: jobs created >= ${WINDOW_START} (export_completed instrumentation birth [MEASURED])`);
  console.log(`pulled: export_completed events=${exports_.length} (distinct jobs=${exportedJobIds.size}), result_viewed events=${views.length} (distinct jobs=${viewedJobIds.size})`);
  console.log(`jobs in window: ${jobs.length} total, ${completed.length} completed`);
  console.log(`export methods (event-level): ${JSON.stringify(exportMethods)}`);

  // exports pointing at jobs OUTSIDE the window or non-completed (sanity)
  const jobById = new Map(jobs.map(j => [j.id, j]));
  let exOutside = 0, exNonCompleted = 0;
  for (const jid of exportedJobIds) {
    const j = jobById.get(jid);
    if (!j) exOutside++;
    else if (j.status !== 'completed') exNonCompleted++;
  }
  console.log(`sanity: exported job_ids not in window cohort=${exOutside}, in-window-but-not-completed=${exNonCompleted}\n`);

  // ── headline: per-route funnel ─────────────────────────────────────
  const byRoute = {};
  for (const j of completed) {
    const r = routeOf(j);
    const b = (byRoute[r] = byRoute[r] || { n: 0, viewed: 0, exported: 0, viewedAndExported: 0, users: new Set(), durs: [] });
    b.n++; b.users.add(j.user_id);
    const v = viewedJobIds.has(j.id), e = exportedJobIds.has(j.id);
    if (v) b.viewed++;
    if (e) b.exported++;
    if (v && e) b.viewedAndExported++;
    b.durs.push(j.source_duration);
  }
  console.log('── EXPORT FUNNEL PER ROUTE (completed jobs, window-clean) ──');
  console.log('route                 n_completed  users  viewed(%of n)   exported(%of n)   exported(%of viewed)');
  for (const [r, b] of Object.entries(byRoute).sort((a, z) => z[1].n - a[1].n)) {
    console.log(
      `${r.padEnd(22)}${String(b.n).padStart(6)}      ${String(b.users.size).padStart(4)}   ` +
      `${String(b.viewed).padStart(5)} (${pct(b.viewed, b.n).padStart(6)})   ` +
      `${String(b.exported).padStart(4)} (${pct(b.exported, b.n).padStart(6)})    ` +
      `${String(b.exported).padStart(4)}/${String(b.viewed).padEnd(5)} (${pct(b.exported, b.viewed)})`
    );
  }

  // ── confound cut 1: source-duration bucket x route ────────────────
  console.log('\n── CONFOUND 1: export/completed by source_duration bucket x route ──');
  const cell = {};
  for (const j of completed) {
    const k = `${routeOf(j)}|${durBucket(j.source_duration)}`;
    const c = (cell[k] = cell[k] || { n: 0, ex: 0 });
    c.n++; if (exportedJobIds.has(j.id)) c.ex++;
  }
  const routes = Object.keys(byRoute).sort((a, z) => byRoute[z].n - byRoute[a].n);
  const buckets = ['0-20s', '20-60s', '60-120s', '120s+', 'unknown'];
  console.log('route                 ' + buckets.map(b => b.padStart(16)).join(''));
  for (const r of routes) {
    let line = r.padEnd(22);
    for (const b of buckets) {
      const c = cell[`${r}|${b}`];
      line += (c ? `${c.ex}/${c.n} (${pct(c.ex, c.n)})` : '—').padStart(16);
    }
    console.log(line);
  }

  // ── confound cut 2: per-user (do the same users export differently by route?) ──
  console.log('\n── CONFOUND 2: per-user ──');
  const userRoutes = {};
  for (const j of completed) {
    const u = (userRoutes[j.user_id] = userRoutes[j.user_id] || { routes: new Set(), jobs: 0, exported: 0 });
    u.routes.add(routeOf(j)); u.jobs++; if (exportedJobIds.has(j.id)) u.exported++;
  }
  const users = Object.values(userRoutes);
  const multi = users.filter(u => u.routes.size > 1);
  console.log(`users with completed jobs: ${users.length}; multi-route users: ${multi.length}`);
  // among multi-route users: export rate on standard vs lean jobs (same-user control)
  let sN = 0, sE = 0, lN = 0, lE = 0;
  for (const j of completed) {
    const u = userRoutes[j.user_id];
    if (!u || u.routes.size < 2) continue;
    if (routeOf(j) === 'standard_editorial') { sN++; if (exportedJobIds.has(j.id)) sE++; }
    else { lN++; if (exportedJobIds.has(j.id)) lE++; }
  }
  console.log(`SAME-USER control (multi-route users only): standard ${sE}/${sN} (${pct(sE, sN)}) vs lean ${lE}/${lN} (${pct(lE, lN)})`);

  // per-user export rate by dominant route
  const domCell = {};
  for (const [uid, u] of Object.entries(userRoutes)) {
    void uid;
    const dom = u.routes.size === 1 ? [...u.routes][0] : 'multi';
    const c = (domCell[dom] = domCell[dom] || { users: 0, exportedUsers: 0 });
    c.users++; if (u.exported > 0) c.exportedUsers++;
  }
  console.log('\nusers by (single) route: users  users-who-exported(%)');
  for (const [r, c] of Object.entries(domCell).sort((a, z) => z[1].users - a[1].users)) {
    console.log(`  ${r.padEnd(24)}${String(c.users).padStart(5)}   ${c.exportedUsers} (${pct(c.exportedUsers, c.users)})`);
  }

  // ── the original claim's cohort (all-time, for reference against 9.9%/20%) ──
  console.log('\n── REFERENCE: all-time completed jobs (INCLUDES pre-instrumentation jobs — deflated, shown only to locate the 9.9%/20% claim) ──');
  const allJobs = await pageAll('video_jobs', `status=eq.completed&select=id,route:result->>route`);
  const allCell = {};
  for (const j of allJobs) {
    const r = j.route || 'standard_editorial';
    const c = (allCell[r] = allCell[r] || { n: 0, ex: 0 });
    c.n++; if (exportedJobIds.has(j.id)) c.ex++;
  }
  for (const [r, c] of Object.entries(allCell).sort((a, z) => z[1].n - a[1].n)) {
    console.log(`  ${r.padEnd(24)}${String(c.n).padStart(5)}  exported ${c.ex} (${pct(c.ex, c.n)})`);
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
