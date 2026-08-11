#!/usr/bin/env node
'use strict';
/**
 * LANE 1 / JUDGE — Step 3: the daily scoreboard. One row per UTC day.
 *
 * Four numbers:
 *   1. fulfillment  — honor rate + dropped-silently rate over yesterday's judged
 *                     completions (judge runs incrementally first if a key is present)
 *   2. latency      — e2e p50/p90/p99 (completed_at - created_at, THE USER'S WAIT),
 *                     premium-only p50, callback-gap count (e2e - worker_total > 120s)
 *   3. export/conv  — exports, result_views, export/viewed, purchases
 *   4. defect rate  — placeholder column until Lane 2's harness emits it
 *
 * Persistence: upsert into daily_scoreboard. If the table does not exist yet
 * (migration pending with TRUTH), the row is appended to out/daily_scoreboard.jsonl
 * and printed — LOUDLY marked. Read-only against all existing tables.
 *
 * Usage: node scripts/scoreboard.js [--day YYYY-MM-DD]   (default: yesterday UTC)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), quiet: true });
if (!process.env.SUPABASE_URL) require('dotenv').config({ path: '/Users/zaclibman/content-studio/.env.local', quiet: true });
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const dayArgIx = process.argv.indexOf('--day');
const DAY = dayArgIx >= 0 ? process.argv[dayArgIx + 1]
  : new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10); // yesterday UTC
const T0 = `${DAY}T00:00:00Z`, T1 = `${DAY}T23:59:59.999Z`;

async function pageAll(pathq) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${URL_}/rest/v1/${pathq}&limit=1000&offset=${off}`, { headers: H });
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error(JSON.stringify(rows).slice(0, 200));
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
const pctl = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1); };

// ── SENTINEL: outage detection vs a trailing 7-day baseline ─────────────
// Built + backtested against the 2026-08-08 route-collapse window (moodreel's
// last completion 08-08T11:18Z, hype 10:58Z [MEASURED]; both absent since).
// Day-level share misses a PARTIAL outage day (08-08 was healthy all morning),
// so route_collapse keys on the SECOND HALF of the day (12:00Z→24:00Z).
// Signals (v1): route_collapse, completion_rate_drop, volume_collapse.
// callback-gap + fulfillment-crash deltas are visible as columns; wiring them
// into the sentinel needs scoreboard history and lands after 7 table days.
async function computeSentinel(day) {
  const d0 = new Date(`${day}T00:00:00Z`);
  const t0 = new Date(d0 - 7 * 86400e3).toISOString();
  const t1 = `${day}T23:59:59.999Z`;
  const jobs = await pageAll(
    `video_jobs?created_at=gte.${t0}&created_at=lte.${t1}` +
    `&select=created_at,status,route:result->>route&order=created_at.asc`
  );
  const dayJobs = jobs.filter(j => j.created_at.slice(0, 10) === day);
  const baseJobs = jobs.filter(j => j.created_at.slice(0, 10) < day);
  const baseDays = [...new Set(baseJobs.map(j => j.created_at.slice(0, 10)))].length || 1;
  const flags = [], notes = [];
  // baseline route shares (completed only)
  const baseDone = baseJobs.filter(j => j.status === 'completed');
  const baseShare = {};
  baseDone.forEach(j => { const r = j.route || 'std'; baseShare[r] = (baseShare[r] || 0) + 1; });
  Object.keys(baseShare).forEach(r => baseShare[r] = baseShare[r] / (baseDone.length || 1));
  // 1. route_collapse — second-half absence of any baseline-share>=5% route
  const secondHalf = dayJobs.filter(j => j.status === 'completed' && j.created_at.slice(11, 13) >= '12');
  const shCounts = {};
  secondHalf.forEach(j => { const r = j.route || 'std'; shCounts[r] = (shCounts[r] || 0) + 1; });
  if (secondHalf.length >= 15) {
    for (const [r, share] of Object.entries(baseShare)) {
      if (share >= 0.05 && !shCounts[r]) {
        flags.push(`route_collapse:${r}`);
        notes.push(`route ${r} (baseline ${(100 * share).toFixed(0)}% of completions) absent from the day's second half`);
      }
    }
  }
  // 2. completion_rate_drop — >=15 points below trailing
  const dayRate = dayJobs.length ? dayJobs.filter(j => j.status === 'completed').length / dayJobs.length : null;
  const baseRate = baseJobs.length ? baseDone.length / baseJobs.length : null;
  if (dayRate != null && baseRate != null && baseRate - dayRate >= 0.15) {
    flags.push('completion_rate_drop');
    notes.push(`completion ${(100 * dayRate).toFixed(0)}% vs trailing ${(100 * baseRate).toFixed(0)}%`);
  }
  // 3. volume_collapse — <40% of trailing per-day mean
  const baseMean = baseJobs.length / baseDays;
  if (baseMean >= 20 && dayJobs.length < 0.4 * baseMean) {
    flags.push('volume_collapse');
    notes.push(`volume ${dayJobs.length} vs trailing mean ${baseMean.toFixed(0)}/day`);
  }
  return {
    outage: flags.length > 0,
    outage_note: notes.length ? notes.join('; ') : null,
    sentinel: { flags, baseline_days: baseDays, day_n: dayJobs.length, day_completion: dayRate, base_completion: baseRate, second_half_n: secondHalf.length },
  };
}

(async () => {
  // --backtest D1 D2: evaluate the sentinel over a date range, print, no writes
  const btIx = process.argv.indexOf('--backtest');
  if (btIx >= 0) {
    const from = process.argv[btIx + 1], to = process.argv[btIx + 2];
    console.log(`SENTINEL BACKTEST ${from} → ${to}`);
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(+d + 86400e3)) {
      const day = d.toISOString().slice(0, 10);
      const s = await computeSentinel(day);
      console.log(`  ${day}  ${s.outage ? '🚨 OUTAGE' : 'clean   '}  ${s.sentinel.flags.join(', ') || '-'}${s.outage_note ? `  (${s.outage_note})` : ''}`);
    }
    return;
  }
  // ── 1. fulfillment: incremental judge, then aggregate the day ─────────
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY) {
    try {
      execFileSync('node', [path.join(__dirname, 'fulfillment-judge.js'), '--since', T0], { stdio: 'inherit', timeout: 20 * 60 * 1000 });
    } catch (e) { console.error(`[scoreboard] judge incremental run failed (continuing): ${e.message.slice(0, 120)}`); }
  } else console.error('[scoreboard] no LLM key in env — skipping incremental judge; fulfillment fields will reflect existing judgments only');

  let fRows = [];
  const fr = await fetch(`${URL_}/rest/v1/fulfillment_scores?select=*&created_at=gte.${T0}&created_at=lte.${T1}`, { headers: H });
  const fbody = await fr.json();
  if (Array.isArray(fbody)) fRows = fbody;
  else {
    // table not created yet — fall back to JSONL (local runs only)
    const jl = path.join(__dirname, '..', 'out', 'fulfillment_scores.jsonl');
    if (fs.existsSync(jl)) {
      fRows = fs.readFileSync(jl, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
        .filter(r => r.created_at >= T0 && r.created_at <= T1);
      console.error('[scoreboard] fulfillment_scores TABLE MISSING — read from JSONL fallback');
    }
  }
  const asks = fRows.flatMap(r => (r.asks || []));
  const fulfillment = {
    fulfillment_n_jobs: fRows.length,
    fulfillment_honor_rate: asks.length ? +(asks.filter(a => a.verdict === 'HONORED').length / asks.length).toFixed(3) : null,
    fulfillment_dropped_silently_rate: asks.length ? +(asks.filter(a => a.verdict === 'DROPPED_SILENTLY').length / asks.length).toFixed(3) : null,
  };

  // ── 2. latency (the user's wait; jobs COMPLETED on the day) ───────────
  const jobs = await pageAll(
    `video_jobs?status=eq.completed&completed_at=gte.${T0}&completed_at=lte.${T1}` +
    `&select=id,created_at,completed_at,route:result->>route,total:result->stage_timings->>total`
  );
  const e2e = [], prem = []; let gap = 0;
  for (const j of jobs) {
    const w = (new Date(j.completed_at) - new Date(j.created_at)) / 1000;
    if (w <= 0 || w > 7200) continue;
    e2e.push(w);
    if (!j.route) prem.push(w);
    const tot = parseFloat(j.total);
    if (Number.isFinite(tot) && w - tot > 120) gap++;
  }
  const latency = {
    latency_n_jobs: e2e.length,
    latency_p50_s: pctl(e2e, 0.5), latency_p90_s: pctl(e2e, 0.9), latency_p99_s: pctl(e2e, 0.99),
    latency_premium_p50_s: pctl(prem, 0.5),
    callback_gap_jobs: gap,
  };

  // ── 3. export / conversion ────────────────────────────────────────────
  const evCount = async (ev) => {
    const r = await fetch(`${URL_}/rest/v1/analytics_events?event=eq.${ev}&created_at=gte.${T0}&created_at=lte.${T1}&select=id`,
      { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
    const cr = r.headers.get('content-range');
    return cr ? parseInt(cr.split('/')[1], 10) : null;
  };
  const exports_ = await evCount('export_completed');
  const views = await evCount('result_viewed');
  // PINNED purchases definition (2026-08-11): purchase_started MINUS
  // purchase_failed that day — a client-side NET-ATTEMPT proxy. The
  // purchase_completed event is broken (6 all-time vs 291 started [MEASURED]),
  // so completion cannot be event-counted. RevenueCat server truth lives in
  // profiles.rc_* and is captured as a LEVEL below (active_pro_subs).
  const purchases = (await evCount('purchase_started') || 0) - (await evCount('purchase_failed') || 0);
  // PINNED active_pro_subs: RC-fed truth snapshot — production, non-comp,
  // unexpired pro. Day-over-day delta = net conversions (minus churn).
  const nowIso = new Date().toISOString();
  const rPro = await fetch(
    `${URL_}/rest/v1/profiles?tier=eq.pro&comp_pro=not.is.true&rc_product_id=not.is.null&pro_until=gt.${nowIso}&select=id`,
    { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
  const proCr = rPro.headers.get('content-range');
  const active_pro_subs = proCr ? parseInt(proCr.split('/')[1], 10) : null;
  // PER-SKU FUNNEL (2026-08-11): wall_view -> start -> paid, daily — so an
  // offer/paywall change is measurable the morning it flips. wall has no SKU
  // (it shows all plans; context=manual|limit); starts/abandons/paid cut by
  // props.plan. "paid" = purchase_completed events (fires 6/6 for event-era
  // payers [MEASURED]; RC profiles stay the LEVEL check via active_pro_subs).
  const wallViews = await evCount('upgrade_wall_viewed');
  const wallCtx = {};
  const pev = [];
  for (const ev of ['upgrade_wall_viewed', 'purchase_started', 'purchase_failed', 'purchase_completed']) {
    const rows = await pageAll(`analytics_events?event=eq.${ev}&created_at=gte.${T0}&created_at=lte.${T1}&select=event,props`);
    if (ev === 'upgrade_wall_viewed') rows.forEach(r => { const c = (r.props || {}).context || '?'; wallCtx[c] = (wallCtx[c] || 0) + 1; });
    else pev.push(...rows);
  }
  const bySku = {};
  for (const e of pev) {
    const sku = (e.props || {}).plan || 'unknown';
    const s = (bySku[sku] = bySku[sku] || { starts: 0, abandons: 0, errors: 0, paid: 0 });
    if (e.event === 'purchase_started') s.starts++;
    else if (e.event === 'purchase_completed') s.paid++;
    else if ((e.props || {}).billing_error === 'user_cancelled') s.abandons++;
    else s.errors++;
  }
  const purchase_funnel = { wall_views: wallViews, wall_by_context: wallCtx, by_sku: bySku };
  const exportConv = {
    exports: exports_, result_views: views,
    export_per_viewed: views ? +((exports_ || 0) / views).toFixed(3) : null,
    purchases, active_pro_subs, purchase_funnel,
  };

  // ── 4. defect rate placeholder + sentinel annotation ─────────────────
  const sent = await computeSentinel(DAY);
  const row = { day: DAY, ...fulfillment, ...latency, ...exportConv, ...sent, defect_rate: null, defect_n: null };

  // ── persist: upsert into daily_scoreboard; JSONL+print fallback ──────
  const up = await fetch(`${URL_}/rest/v1/daily_scoreboard?on_conflict=day`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (up.ok) console.log(`[scoreboard] row upserted for ${DAY}`);
  else {
    const err = await up.text();
    fs.mkdirSync(path.join(__dirname, '..', 'out'), { recursive: true });
    fs.appendFileSync(path.join(__dirname, '..', 'out', 'daily_scoreboard.jsonl'), JSON.stringify(row) + '\n');
    console.error(`[scoreboard] TABLE WRITE FAILED (${up.status}: ${err.slice(0, 120)}) — row appended to out/daily_scoreboard.jsonl. Apply supabase/migrations/20260810_daily_scoreboard.sql.`);
  }

  // ── digest (four numbers, one line each, 7-day delta when history exists) ──
  const hist = await fetch(`${URL_}/rest/v1/daily_scoreboard?select=*&order=day.desc&limit=8`, { headers: H });
  const hb = await hist.json();
  const prev = Array.isArray(hb) ? hb.find(r => r.day === new Date(new Date(DAY) - 7 * 86400e3).toISOString().slice(0, 10)) : null;
  const d = (cur, old, unit = '') => (cur == null ? 'n/a' : `${cur}${unit}${old != null ? ` (7d ${cur > old ? '+' : ''}${+(cur - old).toFixed(3)}${unit})` : ''}`);
  console.log(`\n══ PROMPTLY SCOREBOARD ${DAY} ══${row.outage ? `\n🚨 OUTAGE-ANNOTATED: ${row.outage_note} — treat this day's numbers as outage-distorted, not organic` : ''}`);
  console.log(`FULFILLMENT  honor ${d(row.fulfillment_honor_rate, prev && prev.fulfillment_honor_rate)} · dropped-silently ${d(row.fulfillment_dropped_silently_rate, prev && prev.fulfillment_dropped_silently_rate)} · n=${row.fulfillment_n_jobs}`);
  console.log(`LATENCY      p50 ${d(row.latency_p50_s, prev && prev.latency_p50_s, 's')} · p90 ${row.latency_p90_s}s · p99 ${row.latency_p99_s}s · premium p50 ${row.latency_premium_p50_s}s · callback-gap ${row.callback_gap_jobs} · n=${row.latency_n_jobs}`);
  console.log(`EXPORT/CONV  exports ${d(row.exports, prev && prev.exports)} · views ${row.result_views} · export/viewed ${d(row.export_per_viewed, prev && prev.export_per_viewed)} · purchases(net-attempts) ${row.purchases} · active-pro ${row.active_pro_subs}`);
  console.log(`DEFECTS      ${row.defect_rate == null ? 'awaiting Lane 2 harness (column wired)' : row.defect_rate}`);
  const fn = row.purchase_funnel || {};
  const skuLine = Object.entries(fn.by_sku || {}).map(([k, v]) => `${k} ${v.starts}→${v.paid}${v.abandons ? ` (${v.abandons} bail)` : ''}`).join(' · ') || 'no purchase activity';
  console.log(`FUNNEL       wall ${fn.wall_views ?? 'n/a'} (${Object.entries(fn.wall_by_context || {}).map(([c, n]) => `${c}:${n}`).join(',') || '-'}) · ${skuLine}`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
