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

(async () => {
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
  const purchases = await evCount('purchase_started');
  const exportConv = {
    exports: exports_, result_views: views,
    export_per_viewed: views ? +((exports_ || 0) / views).toFixed(3) : null,
    purchases,
  };

  // ── 4. defect rate placeholder ───────────────────────────────────────
  const row = { day: DAY, ...fulfillment, ...latency, ...exportConv, defect_rate: null, defect_n: null };

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
  console.log(`\n══ PROMPTLY SCOREBOARD ${DAY} ══`);
  console.log(`FULFILLMENT  honor ${d(row.fulfillment_honor_rate, prev && prev.fulfillment_honor_rate)} · dropped-silently ${d(row.fulfillment_dropped_silently_rate, prev && prev.fulfillment_dropped_silently_rate)} · n=${row.fulfillment_n_jobs}`);
  console.log(`LATENCY      p50 ${d(row.latency_p50_s, prev && prev.latency_p50_s, 's')} · p90 ${row.latency_p90_s}s · p99 ${row.latency_p99_s}s · premium p50 ${row.latency_premium_p50_s}s · callback-gap ${row.callback_gap_jobs} · n=${row.latency_n_jobs}`);
  console.log(`EXPORT/CONV  exports ${d(row.exports, prev && prev.exports)} · views ${row.result_views} · export/viewed ${d(row.export_per_viewed, prev && prev.export_per_viewed)} · purchases ${row.purchases}`);
  console.log(`DEFECTS      ${row.defect_rate == null ? 'awaiting Lane 2 harness (column wired)' : row.defect_rate}`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
