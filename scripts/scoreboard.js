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
  // ── THE JUDGE IS OPT-IN NOW (2026-09-24), and off on every automatic path.
  //
  // It was spawned here on every scoreboard run. On Render that meant every
  // ten minutes, on every instance, for five days — and each run walked the
  // whole completed history of video_jobs: the heaviest statement on the
  // table, 652 s of database time in under four hours [MEASURED].
  //
  // What it produced there was NOTHING. The judge persists to
  // out/fulfillment_scores.jsonl on Render's ephemeral disk, and the loader
  // that moves JSONL into the fulfillment_scores table is a hand-run script.
  // The table's newest judgment is 2026-08-11 — 43 days of runs that wrote to
  // a file nobody ever read, and it made LLM calls to do it.
  //
  // It stays runnable BY HAND (`node scripts/scoreboard.js --day X --judge`,
  // or the judge directly), because as a lane analysis tool it is fine. What
  // it may not be is a thing the web service does to itself on a timer.
  if (!process.argv.includes('--judge')) {
    console.error('[scoreboard] incremental judge NOT run (pass --judge to run it). '
      + 'fulfillment_* reflects the fulfillment_scores table as it stands.');
  } else if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY) {
    try {
      execFileSync('node', [path.join(__dirname, 'fulfillment-judge.js'), '--since', T0], { stdio: 'inherit', timeout: 20 * 60 * 1000 });
    } catch (e) { console.error(`[scoreboard] judge incremental run failed (continuing): ${e.message.slice(0, 120)}`); }
  } else console.error('[scoreboard] --judge given but no LLM key in env — skipping incremental judge; fulfillment fields will reflect existing judgments only');

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

  // ── 1b. THE AGENTIC LANE, beside the old pipeline's, never mixed with it ──
  // Four numbers from the agentic run records: honor, silent-drop, negotiated,
  // and UNCHECKED — the last because 54 of this lane's 156 fixture asks are
  // taste or vision questions no timeline read-back decides, and a score that
  // silently drops them from the denominator would flatter itself by 35%.
  //
  // EMPTY IS THE HONEST VALUE, NOT ZERO. The lane has never run on a real
  // request (agentic_plan is NULL on all 12,457 jobs ever), so until the first
  // batch lands every field here is null and the state says ABSENT. A 0.000
  // honor rate would read as "it honored nothing", which is a finding; the
  // truth is "nothing has been measured", which is not. This lane has already
  // paid for that confusion once — a counter nobody could distinguish from a
  // real zero cost a round to diagnose.
  let aRows = [], aState = 'ABSENT', aWhy = 'no agentic run records exist yet';
  const ar = await fetch(`${URL_}/rest/v1/agentic_fulfilment_scores?select=*&judged_at=gte.${T0}&judged_at=lte.${T1}`, { headers: H });
  const abody = await ar.json().catch(() => null);
  if (Array.isArray(abody)) {
    aRows = abody;
    aState = aRows.length ? 'MEASURED' : 'ABSENT';
    if (!aRows.length) aWhy = 'table exists, no judged runs on this day';
  } else {
    const ajl = path.join(__dirname, '..', 'out', 'agentic_fulfilment.jsonl');
    if (fs.existsSync(ajl)) {
      aRows = fs.readFileSync(ajl, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
        .filter(r => (r.judged_at || '') >= T0 && (r.judged_at || '') <= T1);
      aState = aRows.length ? 'MEASURED' : 'ABSENT';
      // A VERDICT WITHOUT ITS INPUT AND ITS CONDITIONS IS NOT A MEASUREMENT
      // (Zac, 2026-09-20). A scored record must carry input_sha and
      // judge_temperature or it cannot be reproduced, compared, or shown to
      // have changed — and a verdict drawn at temperature 1.0 is one sample of
      // a distribution wearing a measurement's clothes.
      //
      // This is not hypothetical: the only record that had ever reached this
      // line was judged at the default temperature, and its run record no
      // longer exists anywhere, so it can never be re-scored. Counting it would
      // have made the first AGENTIC line a number nobody could check.
      const unscorable = aRows.filter(r => !r.input_sha || r.judge_temperature !== 0);
      if (unscorable.length) {
        const kept = aRows.length - unscorable.length;
        aRows = aRows.filter(r => r.input_sha && r.judge_temperature === 0);
        aWhy = kept
          ? `${kept} scored record(s); ${unscorable.length} EXCLUDED (no input_sha, or judged before temperature was pinned)`
          : `${unscorable.length} record(s) EXCLUDED — judged before temperature was pinned and carrying no input_sha, so not a measurement`;
        if (!aRows.length) aState = 'ABSENT';
      } else {
        aWhy = aRows.length ? 'from out/agentic_fulfilment.jsonl (table missing)' : 'JSONL present, no runs on this day';
      }
    } else {
      aWhy = 'no agentic_fulfilment_scores table and no out/agentic_fulfilment.jsonl';
    }
  }
  // ── DENSITY: A NUMBER, NEVER A GATE ──────────────────────────────────
  // Placements per 25s by family, beside the reference corpus's own rates.
  // This is the honest measure of "few and huge": it says how OFTEN a family
  // appears, which no honor rate can, because a run that places one perfect
  // card scores 1.0 and a run that places eight also scores 1.0.
  //
  // THE RATES GRADE AND NEVER INSTRUCT. Standing law: they must never reach the
  // agent as a target, appear in the prompt, or be enforced as a floor at
  // ruling time. A run that places two zooms because two moments deserved them
  // is CORRECT and a rubric calling it short is the rubric's problem. So this
  // block computes and PRINTS and does nothing else — no threshold, no verdict,
  // no exit code, and __smoke_density_is_not_a_gate.js asserts that.
  // TWO CORPORA, BECAUSE ONE YARDSTICK DOES NOT FIT BOTH. The talking-head
  // reference is transcript-derived; holding a screen recording to text 7.28
  // measures one thing against another thing's ruler. The no-speech table was
  // measured over 1,463 shipped jobs and differs by 10x on card alone (0.23 vs
  // 2.35), so the split is not a refinement — an unsplit number is wrong for
  // whichever half it does not describe.
  const REF_BY_ROUTE = {
    speech:    { text: 7.28, cut: 4.75, card: 2.35, sfx: 0.82, zoom: 0.35, transition: 0.00 },
    no_speech: { text: 0.00, cut: 4.26, card: 0.23, sfx: 0.00, zoom: 0.00, transition: 0.27 },
  };
  const REFERENCE_PER_25S = REF_BY_ROUTE.speech;   // the default, named below when used
  // A record carries `route` ('speech' | 'no_speech') when the harness records
  // it. UNTIL IT DOES the line says UNSPLIT and names the table it used, rather
  // than grading a screen recording against a talking head in silence.
  const byRoute = {};
  let unrouted = 0;
  for (const r of aRows) {
    const route = (r.route === 'speech' || r.route === 'no_speech') ? r.route : null;
    if (!route) unrouted++;
    const k = route || 'UNROUTED';
    byRoute[k] = byRoute[k] || { seconds: 0, fam: {} };
    if (typeof r.duration_s === 'number') byRoute[k].seconds += r.duration_s;
    for (const [f, v] of Object.entries(r.families || {})) byRoute[k].fam[f] = (byRoute[k].fam[f] || 0) + v;
  }
  const density = { state: 'ABSENT', routes: {}, unrouted, split: unrouted === 0 && Object.keys(byRoute).length > 0 };
  for (const [k, v] of Object.entries(byRoute)) {
    if (!(v.seconds > 0)) continue;
    density.state = 'MEASURED';
    const table = REF_BY_ROUTE[k] || REF_BY_ROUTE.speech;
    const per25 = {};
    for (const fam of Object.keys(table)) per25[fam] = +((v.fam[fam] || 0) / (v.seconds / 25)).toFixed(2);
    density.routes[k] = { seconds: +v.seconds.toFixed(1), per25,
                          table: REF_BY_ROUTE[k] ? k : 'speech (DEFAULT — route not recorded)' };
  }

  const aAsks = aRows.flatMap(r => (r.asks || []));
  // UNCHECKED is counted from the FIXTURE expectation, not from a verdict: an
  // ask whose `means` could not be gated is unscoreable however it turned out.
  const aUnchecked = aAsks.filter(a => a.unchecked === true || /^UNCHECKED/.test(String(a.means || ''))).length;
  const aScored = aAsks.length - aUnchecked;
  const rate = (pred) => aScored ? +(aAsks.filter(a => !(a.unchecked === true || /^UNCHECKED/.test(String(a.means || ''))) && pred(a)).length / aScored).toFixed(3) : null;
  const agentic = {
    agentic_state: aState,
    agentic_n_runs: aState === 'MEASURED' ? aRows.length : null,
    agentic_n_asks: aState === 'MEASURED' ? aAsks.length : null,
    agentic_unchecked: aState === 'MEASURED' ? aUnchecked : null,
    agentic_honor_rate: aState === 'MEASURED' ? rate(a => a.verdict === 'HONORED') : null,
    agentic_silent_drop_rate: aState === 'MEASURED' ? rate(a => a.verdict === 'DROPPED_SILENTLY') : null,
    agentic_negotiated_rate: aState === 'MEASURED' ? rate(a => a.verdict === 'NEGOTIATED') : null,
    agentic_why: aWhy,
    agentic_density_state: density.state,
    agentic_density_split: density.split,
    agentic_density_routes: density.state === 'MEASURED' ? density.routes : null,
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
  const row = { day: DAY, ...fulfillment, ...agentic, ...latency, ...exportConv, defect_rate: null, defect_n: null };
  let writeFailed = false;

  // ── persist: upsert into daily_scoreboard; JSONL+print fallback ──────
  // --dry-run computes and PRINTS without writing. Added so the fulfilment lane
  // (Supabase read-only) can show the digest line it added without performing
  // the upsert. It skips persistence only — every number above is computed the
  // same way, so a dry run is the real reading, not a mock of one.
  // ── A KEY THE TABLE HAS NO COLUMN FOR REJECTS THE WHOLE ROW ──────────
  //
  // That is what happened on 2026-09-19: nine `agentic_*` keys were added to
  // `row` (a122697) and daily_scoreboard has columns for none of them, so
  // PostgREST 400'd every upsert from that commit onward. The last row the
  // scoreboard ever wrote is 2026-09-18. Because the failure was logged to a
  // stream the parent discarded and this script exited 0 anyway, the in-process
  // scheduler read "missing" forever and re-ran the whole thing every ten
  // minutes for five days.
  //
  // So the row is narrowed to the columns the table actually has, and every
  // dropped key is NAMED. A number that cannot be stored must not be able to
  // take the other twenty with it — and it must not be able to vanish quietly
  // either.
  let writable = row, dropped = [];
  try {
    const sr = await fetch(`${URL_}/rest/v1/`, { headers: { ...H, Accept: 'application/openapi+json' } });
    const schema = await sr.json();
    const cols = Object.keys(((schema.definitions || {}).daily_scoreboard || {}).properties || {});
    if (cols.length) {
      dropped = Object.keys(row).filter((k) => !cols.includes(k));
      writable = Object.fromEntries(Object.entries(row).filter(([k]) => cols.includes(k)));
    } else console.error('[scoreboard] could not read daily_scoreboard columns from the PostgREST schema — writing the full row unfiltered');
  } catch (e) {
    console.error(`[scoreboard] column probe failed (${e.message.slice(0, 80)}) — writing the full row unfiltered`);
  }
  if (dropped.length) {
    console.error(`[scoreboard] ${dropped.length} field(s) HAVE NO COLUMN and were dropped from the write: ${dropped.join(', ')}`
      + ' — apply supabase/migrations/20260924_daily_scoreboard_agentic.sql to store them.');
  }

  if (process.argv.includes('--dry-run')) {
    console.error('[scoreboard] DRY RUN — computed and printed, nothing written');
  } else {
  const up = await fetch(`${URL_}/rest/v1/daily_scoreboard?on_conflict=day`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(writable),
  });
  if (up.ok) console.log(`[scoreboard] row upserted for ${DAY}`);
  else {
    const err = await up.text();
    fs.mkdirSync(path.join(__dirname, '..', 'out'), { recursive: true });
    fs.appendFileSync(path.join(__dirname, '..', 'out', 'daily_scoreboard.jsonl'), JSON.stringify(row) + '\n');
    console.error(`[scoreboard] TABLE WRITE FAILED (${up.status}: ${err.slice(0, 200)}) — row appended to out/daily_scoreboard.jsonl (EPHEMERAL on Render; nothing reads it there).`);
    // EXIT CODE FOLLOWS THE WRITE. Exiting 0 on a failed write is how a caller
    // came to log "written" about a row that does not exist.
    writeFailed = true;
  }

  }

  // ── digest (four numbers, one line each, 7-day delta when history exists) ──
  const hist = await fetch(`${URL_}/rest/v1/daily_scoreboard?select=*&order=day.desc&limit=8`, { headers: H });
  const hb = await hist.json();
  const prev = Array.isArray(hb) ? hb.find(r => r.day === new Date(new Date(DAY) - 7 * 86400e3).toISOString().slice(0, 10)) : null;
  const d = (cur, old, unit = '') => (cur == null ? 'n/a' : `${cur}${unit}${old != null ? ` (7d ${cur > old ? '+' : ''}${+(cur - old).toFixed(3)}${unit})` : ''}`);
  console.log(`\n══ PROMPTLY SCOREBOARD ${DAY} ══`);
  console.log(`FULFILLMENT  honor ${d(row.fulfillment_honor_rate, prev && prev.fulfillment_honor_rate)} · dropped-silently ${d(row.fulfillment_dropped_silently_rate, prev && prev.fulfillment_dropped_silently_rate)} · n=${row.fulfillment_n_jobs}`);
  console.log(`AGENTIC      ${row.agentic_state === 'MEASURED'
    ? `honor ${d(row.agentic_honor_rate, prev && prev.agentic_honor_rate)} · silent-drop ${d(row.agentic_silent_drop_rate, prev && prev.agentic_silent_drop_rate)} · negotiated ${d(row.agentic_negotiated_rate, prev && prev.agentic_negotiated_rate)} · UNCHECKED ${row.agentic_unchecked}/${row.agentic_n_asks} · n=${row.agentic_n_runs}`
    : `EMPTY — ${row.agentic_why}. Not zero: nothing has been measured.`}`);
  if (row.agentic_density_state !== 'MEASURED') {
    console.log(`DENSITY      EMPTY — no agentic output measured. Not zero.   [a number, never a gate]`);
  } else {
    for (const [route, v] of Object.entries(row.agentic_density_routes)) {
      const table = REF_BY_ROUTE[route] || REF_BY_ROUTE.speech;
      const cells = Object.entries(v.per25).map(([f, n]) => `${f} ${n}/${table[f]}`).join(' · ');
      console.log(`DENSITY ${String(route).padEnd(10)} ${cells}  (${v.seconds}s vs ${v.table})   [a number, never a gate]`);
    }
    if (!row.agentic_density_split) {
      console.log(`             UNSPLIT — ${row.agentic_density_routes.UNROUTED ? 'no record carries `route`' : 'some records carry no `route`'}; a no-speech source graded on the talking-head table is measured against the wrong corpus`);
    }
  }
  console.log(`LATENCY      p50 ${d(row.latency_p50_s, prev && prev.latency_p50_s, 's')} · p90 ${row.latency_p90_s}s · p99 ${row.latency_p99_s}s · premium p50 ${row.latency_premium_p50_s}s · callback-gap ${row.callback_gap_jobs} · n=${row.latency_n_jobs}`);
  console.log(`EXPORT/CONV  exports ${d(row.exports, prev && prev.exports)} · views ${row.result_views} · export/viewed ${d(row.export_per_viewed, prev && prev.export_per_viewed)} · purchases ${row.purchases}`);
  console.log(`DEFECTS      ${row.defect_rate == null ? 'awaiting Lane 2 harness (column wired)' : row.defect_rate}`);

  // The digest above is computed either way — a failed WRITE does not make the
  // numbers wrong. But the exit code is the only thing a parent can read, so it
  // says what happened to the row.
  if (writeFailed) process.exit(3);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
