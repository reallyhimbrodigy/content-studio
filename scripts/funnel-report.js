#!/usr/bin/env node
'use strict';
// 1.3.3 conversion-campaign funnel instrumentation (server-authoritative).
//
// The north star: signup → first COMPLETED render → felt success. Monetization
// converts downstream of that, so this measures activation first, revenue second.
//
// Computed from the AUTHORITATIVE tables (profiles, video_jobs) plus
// analytics_events for the paywall/purchase leg — NOT from the client funnel
// events (upload_started/result_viewed fire ~once; they're not trustworthy until
// build 219 instruments them). Run daily; paste the [REPORT] line into the report.
//
//   node scripts/funnel-report.js            # all-time + last 7d/30d
//   node scripts/funnel-report.js 7          # window in days for the event leg
//
// Reads SUPABASE creds from the environment (.env.local locally).
require('dotenv').config({ path: '.env.local' });
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: key, Authorization: `Bearer ${key}` };
const windowDays = Number(process.argv[2]) || 30;
const pct = (n, d) => (d ? (100 * n / d).toFixed(1) : '0.0') + '%';
// POST-FLIP cohort cut: measure the NEW product on its own, not blended into the
// old product's lifetime average. Signups after 2026-07-25 00:00 UTC + jobs
// dispatched after the v356 zero-reject flip. Override the flip instant with
// COHORT_FLIP_ISO once the backend confirms the exact v356 deploy time.
const FLIP = process.env.COHORT_FLIP_ISO || '2026-07-25T00:00:00Z';

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
async function count(table, filter = '') {
  const r = await fetch(`${url}/rest/v1/${table}?select=id${filter}&limit=1`, { headers: { ...H, Prefer: 'count=exact' } });
  return Number((r.headers.get('content-range') || '/0').split('/')[1]);
}
// Fetch video_jobs demo-aware. Selecting a column that doesn't exist yet (the
// add-demo migration not yet applied) 400s the whole query, so on an empty return
// we retry WITHOUT `demo` and treat every row as real — the funnel never breaks
// during the deploy→migration window.
async function pageJobs() {
  const withDemo = await page('video_jobs?select=user_id,status,created_at,demo');
  if (withDemo.length) return withDemo;
  const plain = await page('video_jobs?select=user_id,status,created_at');
  return plain.map((j) => ({ ...j, demo: false }));
}

(async () => {
  const nowIso = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();

  // ── ACTIVATION (authoritative) ──
  const totalUsers = await count('profiles');
  // §4: the sample-clip DEMO renders on the pre-hosted official clip, not real
  // footage — they must NOT inflate activation or the error budget. Split them
  // out: `jobs` below is REAL renders only (every activation/failure line uses it);
  // demo jobs get their own counter. `demo` column is backfilled false, so a
  // pre-migration DB (column absent) safely falls back to all-real.
  const allJobs = await pageJobs();
  const demoJobs = allJobs.filter((j) => j.demo === true);
  const jobs = allJobs.filter((j) => j.demo !== true);   // REAL renders only, everywhere below
  const dispatchedU = new Set(jobs.map((j) => j.user_id)).size;
  const completedU = new Set(jobs.filter((j) => j.status === 'completed').map((j) => j.user_id)).size;
  const jobsDone = jobs.filter((j) => j.status === 'completed').length;
  const jobsFail = jobs.filter((j) => j.status === 'failed').length;

  // ── POST-FLIP COHORT (new product, measured alone) ──
  const newUsers = await page(`profiles?created_at=gte.${FLIP}&select=id`);
  const newUserIds = new Set(newUsers.map((u) => u.id));
  const nUsers = newUserIds.size;
  const nDispatchedU = new Set(jobs.filter((j) => newUserIds.has(j.user_id)).map((j) => j.user_id)).size;
  const nCompletedU = new Set(jobs.filter((j) => newUserIds.has(j.user_id) && j.status === 'completed').map((j) => j.user_id)).size;
  const flipJobs = jobs.filter((j) => j.created_at >= FLIP);          // REAL jobs dispatched after the flip
  const flipDone = flipJobs.filter((j) => j.status === 'completed').length;
  const flipFail = flipJobs.filter((j) => j.status === 'failed').length;

  // ── DEMO (separate — never blended into activation or the error budget) ──
  const demoUsers = new Set(demoJobs.map((j) => j.user_id)).size;
  const demoDone = demoJobs.filter((j) => j.status === 'completed').length;
  const demoFail = demoJobs.filter((j) => j.status === 'failed').length;
  const demoFlip = demoJobs.filter((j) => j.created_at >= FLIP).length;

  // ── REVENUE (server truth) ──
  // rc_environment ('SANDBOX'|'PRODUCTION'|null) tags each RC-linked profile with
  // the environment of the entitlement CURRENTLY granting Pro. Sandbox/TestFlight
  // testers still get Pro in-app — they must NOT count as real paid conversions.
  // Selecting a not-yet-applied column 400s the query (page() returns []), so
  // retry without it (every row then treated as production — the pre-migration
  // window degrades safely, exactly like pageJobs above).
  let paid = await page('profiles?select=comp_pro,pro_until,rc_app_user_id,rc_period_type,rc_environment&or=(tier.eq.paid,comp_pro.eq.true,pro_until.not.is.null,rc_app_user_id.not.is.null)');
  if (!paid.length) paid = await page('profiles?select=comp_pro,pro_until,rc_app_user_id,rc_period_type&or=(tier.eq.paid,comp_pro.eq.true,pro_until.not.is.null,rc_app_user_id.not.is.null)');
  const notSandbox = (p) => p.rc_environment !== 'SANDBOX';   // null (legacy/comp) counts as production
  const activePaid = paid.filter((p) => p.rc_app_user_id && !p.comp_pro && p.rc_period_type && p.rc_period_type !== 'trial' && notSandbox(p)).length;
  const rcTrials = paid.filter((p) => p.rc_app_user_id && !p.comp_pro && p.rc_period_type === 'trial' && notSandbox(p)).length;
  const sandboxSubs = paid.filter((p) => p.rc_app_user_id && !p.comp_pro && p.rc_environment === 'SANDBOX').length;

  // ── PAYWALL LEG (events, window) ──
  // Include props so the webhook-truth conversion counts can drop SANDBOX
  // (props.environment==='SANDBOX'). Client legacy events carry no environment;
  // null/absent counts as production.
  const ev = await page(`analytics_events?created_at=gte.${since}&select=event,props`);
  const ec = {};
  for (const e of ev) ec[e.event] = (ec[e.event] || 0) + 1;
  const g = (k) => ec[k] || 0;
  // The honest, SANDBOX-excluded "real buy" / "real trial" numbers, straight
  // from the webhook mirror (purchase_result = success_paid, trial_start). NOTE:
  // 'purchase_completed' was the old buy metric and is a DEAD field — the client
  // never emits it (all-time count 0), so "→ buy 0" was never a measurement.
  const isSandbox = (e) => e.props && e.props.environment === 'SANDBOX';
  const realBuys = ev.filter((e) => e.event === 'purchase_result' && !isSandbox(e)).length;
  const realTrials = ev.filter((e) => e.event === 'trial_start' && !isSandbox(e)).length;
  const sandboxConv = ev.filter((e) => (e.event === 'purchase_result' || e.event === 'trial_start') && isSandbox(e)).length;

  console.log(`\n================ FUNNEL — ${nowIso} (events: last ${windowDays}d) ================`);
  console.log('ACTIVATION (all-time, authoritative):');
  console.log(`  signup (users)          ${totalUsers}`);
  console.log(`  ever dispatched         ${dispatchedU}  (${pct(dispatchedU, totalUsers)} of signups)`);
  console.log(`  ever COMPLETED  ★       ${completedU}  (${pct(completedU, totalUsers)} of signups, ${pct(completedU, dispatchedU)} of dispatchers)`);
  console.log(`  render jobs: ${jobs.length} total · ${jobsDone} done · ${jobsFail} failed  (${pct(jobsFail, jobs.length)} job failure rate)`);
  console.log(`POST-FLIP COHORT (since ${FLIP.slice(0, 10)} — the NEW product, alone):`);
  console.log(`  new signups             ${nUsers}`);
  console.log(`  new dispatched          ${nDispatchedU}  (${pct(nDispatchedU, nUsers)} of new signups)`);
  console.log(`  new COMPLETED  ★        ${nCompletedU}  (${pct(nCompletedU, nUsers)} of new signups, ${pct(nCompletedU, nDispatchedU)} of new dispatchers)`);
  console.log(`  post-flip jobs: ${flipJobs.length} · ${flipDone} done · ${flipFail} failed  (${pct(flipFail, flipJobs.length)} job failure rate — vs ${pct(jobsFail, jobs.length)} all-time)`);
  console.log('DEMO (sample-clip, excluded from activation above):');
  console.log(`  demo renders            ${demoJobs.length}  (${demoUsers} users · ${demoDone} done · ${demoFail} failed · ${demoFlip} post-flip)`);
  console.log('REVENUE (server truth, SANDBOX excluded):');
  console.log(`  active paid subs        ${activePaid}   ·   lapsed RC trials ${rcTrials}${sandboxSubs ? `   [+${sandboxSubs} sandbox sub${sandboxSubs === 1 ? '' : 's'}, excluded]` : ''}`);
  console.log(`PAYWALL LEG (last ${windowDays}d events):`);
  console.log(`  paywall_view ${g('paywall_view')} → plan_selected ${g('plan_selected')} → purchase_started ${g('purchase_started')} → completed ${realBuys}  (failed ${g('purchase_failed')})`);
  console.log(`  RC webhook (SANDBOX excluded): purchase_result ${realBuys} · trial_start ${realTrials}${sandboxConv ? `   [+${sandboxConv} sandbox conversion${sandboxConv === 1 ? '' : 's'}, excluded]` : ''}`);
  // Two [REPORT] lines side by side: lifetime (old+new blended) and the post-flip
  // cohort (new product alone). The campaign's success is the POST-FLIP line moving.
  console.log(`\n[REPORT] funnel ${nowIso} ALL-TIME: signup ${totalUsers} → dispatch ${dispatchedU} (${pct(dispatchedU, totalUsers)}) → complete ${completedU} (${pct(completedU, totalUsers)}) | jobfail ${pct(jobsFail, jobs.length)} | paid ${activePaid} | paywall ${g('paywall_view')}→buy ${realBuys}`);
  console.log(`[REPORT] funnel ${nowIso} POST-FLIP: signup ${nUsers} → dispatch ${nDispatchedU} (${pct(nDispatchedU, nUsers)}) → complete ${nCompletedU} (${pct(nCompletedU, nUsers)}) | jobfail ${pct(flipFail, flipJobs.length)} | (new product, since ${FLIP.slice(0, 10)})`);
  console.log(`[REPORT] funnel ${nowIso} DEMO: renders ${demoJobs.length} · users ${demoUsers} · done ${demoDone} · failed ${demoFail} (real-footage metrics above exclude these)`);
})().catch((e) => { console.error('funnel-report failed:', e.message); process.exit(1); });
