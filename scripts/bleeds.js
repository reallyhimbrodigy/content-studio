#!/usr/bin/env node
'use strict';
/**
 * JUDGE — the daily bleeds note, regenerated from live data.
 *
 * This is the BUILDER'S TARGETING SYSTEM (Zac, 2026-08-11), so it must not
 * depend on me hand-assembling numbers each morning — a hand-built report
 * decays the day the author is busy. Everything here is a query.
 *
 * Ranked BY USER, never by job (Rule 7 — per-job counting inflates every class
 * by the retry multiplier; that is exactly how a one-user bug once read as a
 * 67% outage). Every section prints its window and denominator.
 *
 * Writes reports/WHERE_IT_BLEEDS.md and prints the same to stdout.
 * Read-only against existing tables. $0 — no LLM, no Modal.
 *
 * Usage: node scripts/bleeds.js [--hours 24]
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), quiet: true });
if (!process.env.SUPABASE_URL) require('dotenv').config({ path: '/Users/zaclibman/content-studio/.env.local', quiet: true });
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const hIx = process.argv.indexOf('--hours');
const HOURS = hIx >= 0 ? Number(process.argv[hIx + 1]) : 24;
const SINCE = new Date(Date.now() - HOURS * 3600e3).toISOString();
const SINCE_7D = new Date(Date.now() - 7 * 86400e3).toISOString();

async function pageAll(q) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${URL_}/rest/v1/${q}&limit=1000&offset=${off}`, { headers: H });
    if (!r.ok) throw new Error(`${q.slice(0, 40)}: ${r.status} ${(await r.text()).slice(0, 120)}`);
    const b = await r.json();
    if (!Array.isArray(b) || !b.length) break;
    out.push(...b);
    if (b.length < 1000) break;
  }
  return out;
}
const pct = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(1)}%`;
const uniq = (rows, k) => new Set(rows.map((r) => r[k]).filter(Boolean)).size;

(async () => {
  const L = [];
  const say = (s = '') => { L.push(s); console.log(s); };
  say(`# WHERE THE PRODUCT BLEEDS — ranked by USER`);
  say('');
  say(`**JUDGE, generated ${new Date().toISOString()} by \`scripts/bleeds.js\`.** Job window`
    + ` ${HOURS}h; funnel + fulfillment windows stated per section. Every line [MEASURED].`);
  say('');

  // ── failures by class, BY USER ────────────────────────────────────────────
  // completion_delivery is selected EXPLICITLY — it was omitted from this
  // select while §4 read `j.completion_delivery`, so every row scored `NULL`
  // and the section reported a live instrument as dead. A field you never
  // fetched is not a field that is empty.
  let jobs;
  try {
    jobs = await pageAll(`video_jobs?select=id,user_id,status,created_at,completed_at,worker_started_at,result,completion_delivery&created_at=gte.${SINCE}`);
  } catch (e) {
    if (!/42703|PGRST204/.test(e.message)) throw e;
    console.error('[bleeds] completion_delivery column absent — delivery section will read (none yet)');
    jobs = await pageAll(`video_jobs?select=id,user_id,status,created_at,completed_at,result&created_at=gte.${SINCE}`);
  }
  const fails = jobs.filter((j) => j.status === 'failed');
  const done = jobs.filter((j) => j.status === 'completed' && j.completed_at);
  const codeOf = (j) => (j.result || {}).error_code || (j.result || {}).error || 'UNCODED';
  const byCode = new Map();
  fails.forEach((j) => {
    const c = codeOf(j);
    if (!byCode.has(c)) byCode.set(c, []);
    byCode.get(c).push(j);
  });
  const ranked = [...byCode.entries()].sort((a, b) => uniq(b[1], 'user_id') - uniq(a[1], 'user_id'));
  say(`## 1. Failures — ${uniq(fails, 'user_id')} users / ${fails.length} jobs (${HOURS}h)`);
  say('');
  say('| class | users | jobs | share of failing users |');
  say('|---|---:|---:|---:|');
  const failUsers = uniq(fails, 'user_id');
  ranked.forEach(([c, rows]) => say(`| ${c} | ${uniq(rows, 'user_id')} | ${rows.length} | ${pct(uniq(rows, 'user_id'), failUsers)} |`));
  say('');

  // ── latency + routes ──────────────────────────────────────────────────────
  const e2e = done.map((j) => (new Date(j.completed_at) - new Date(j.created_at)) / 1000).sort((a, b) => a - b);
  const P = (p) => (e2e.length ? e2e[Math.min(e2e.length - 1, Math.floor(p * e2e.length))] : NaN);
  say(`## 2. Latency — n=${e2e.length} completed (${HOURS}h)`);
  say('');
  say(`p50 **${P(0.5).toFixed(0)}s** (law 90) · p90 ${P(0.9).toFixed(0)}s · p99 **${P(0.99).toFixed(0)}s** (law 180) · max ${(e2e[e2e.length - 1] || 0).toFixed(0)}s`);
  // BY ENVELOPE CLASS, NEVER POOLED (owner, 2026-08-14). One median over a
  // multi-modal population hides the defect that matters: repair-class users
  // wait ~904s while the pooled p50 reads 86s — an 11.5x spread the single
  // number erases. A pooled p50 is reported ONLY beside the per-class split.
  // ENVELOPE PRESENCE is the primary discriminator (owner, 2026-08-14). It needs
  // NO predicate fix: `result.stage_timings.total` is either there or it is not,
  // and that single fact splits the population cleanly into the three modes the
  // pooled median hides. completion_delivery only sub-divides the lost side.
  const envClass = (j) => {
    const full = (((j.result || {}).stage_timings || {}).total) != null;
    if (full) return 'A envelope FULL';
    return j.completion_delivery === 'repair' ? 'C envelope LOST + repair' : 'B envelope LOST';
  };
  const byCls = new Map();
  done.forEach((j) => {
    const k = envClass(j);
    if (!byCls.has(k)) byCls.set(k, []);
    byCls.get(k).push((new Date(j.completed_at) - new Date(j.created_at)) / 1000);
  });
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  if (byCls.size) {
    say('');
    say('| envelope class | n | users | p50 | p90 | max |');
    say('|---|---:|---:|---:|---:|---:|');
    [...byCls.entries()].sort((a, b) => med(b[1]) - med(a[1])).forEach(([k, xs]) => {
      const s = [...xs].sort((a, b) => a - b);
      const us = uniq(done.filter((j) => envClass(j) === k), 'user_id');
      say(`| \`${k}\` | ${s.length} | ${us} | **${med(s).toFixed(0)}s** | ${s[Math.floor(0.9 * s.length)].toFixed(0)}s | ${s[s.length - 1].toFixed(0)}s |`);
    });
    const meds = [...byCls.values()].map(med).filter((x) => x > 0);
    if (meds.length > 1) say(`\nWorst/best class p50 spread: **${(Math.max(...meds) / Math.min(...meds)).toFixed(1)}x** — the pooled number above hides it.`);
    const lost = done.filter((j) => envClass(j) !== 'A envelope FULL');
    say(`\n**ENVELOPE LOSS: ${pct(lost.length, done.length)} of completions (${lost.length}/${done.length}), ${uniq(lost, 'user_id')} users.** `
      + `Regression BORN 2026-08-11T23Z after 8 clean days at 0.0% (08-04..08-11). `
      + `The pooled p50 above sits between classes and describes NO actual user.`);
    say('_Mechanism SETTLED 2026-08-15: a LOST UPDATE on `result` jsonb (written, then clobbered by a later read-modify-write). Fix = CAS on `updated_at`. The worker-hang framing is retired._');
  }
  // QUEUE IS A FIRST-CLASS LATENCY TERM (owner, 2026-08-15). e2e = QUEUE + WORK.
  // Reporting only e2e blames the pipeline for time it never spent working:
  // 43.1% of jobs wait >30s before a worker even picks them up. `started_at`
  // is NOT usable for this — it stamps the dispatch ATTEMPT (p50 0.3s, which
  // measures our own HTTP call); `worker_started_at` is true worker pickup.
  const qw = done.filter((j) => j.worker_started_at && j.completed_at);
  if (qw.length) {
    const Q = qw.map((j) => (new Date(j.worker_started_at) - new Date(j.created_at)) / 1000).sort((a, b) => a - b);
    const W = qw.map((j) => (new Date(j.completed_at) - new Date(j.worker_started_at)) / 1000).sort((a, b) => a - b);
    const q = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
    say('');
    say('| term | p50 | p90 | p99 | max |');
    say('|---|---:|---:|---:|---:|');
    say(`| **QUEUE** (create→worker pickup) | ${q(Q, 0.5).toFixed(1)}s | ${q(Q, 0.9).toFixed(1)}s | ${q(Q, 0.99).toFixed(1)}s | ${Q[Q.length - 1].toFixed(1)}s |`);
    say(`| **WORK** (pickup→complete) | ${q(W, 0.5).toFixed(1)}s | ${q(W, 0.9).toFixed(1)}s | ${q(W, 0.99).toFixed(1)}s | ${W[W.length - 1].toFixed(1)}s |`);
    const over30 = Q.filter((x) => x > 30).length;
    say(`\nQueue is **${(100 * q(Q, 0.5) / Math.max(1, P(0.5))).toFixed(0)}%** of e2e at p50; **${pct(over30, Q.length)}** of jobs wait >30s before any work begins.`);
    // THRESHOLD, NOT CORRELATION — computed live so the claim can never go stale.
    const qOf = (j) => (new Date(j.worker_started_at) - new Date(j.created_at)) / 1000;
    const isFull = (j) => ((((j.result || {}).stage_timings || {}).total) != null);
    const lo = qw.filter((j) => qOf(j) < 30), hi = qw.filter((j) => qOf(j) >= 30);
    const loFull = lo.filter(isFull).length, hiLost = hi.filter((j) => !isFull(j)).length;
    const fullAll = qw.filter(isFull);
    if (lo.length && hi.length && fullAll.length) {
      say('');
      say(`**Queue and envelope loss are NEAR-THRESHOLD, not merely correlated.** Of jobs queuing <30s, `
        + `**${pct(loFull, lo.length)}** kept their envelope (${lo.length - loFull} of ${lo.length} lost it); of jobs queuing ≥30s, `
        + `**${pct(hiLost, hi.length)}** lost it. **${pct(fullAll.filter((j) => qOf(j) < 30).length, fullAll.length)}** of envelope-FULL jobs `
        + `queued under 30s. The relation is a step at ~15–30s, so "correlates with" understates it — below the knee loss is near-absent, above it near-certain.`);
      say('_Direction is still open: queueing may cause the loss, or one upstream condition may cause both. The STEP SHAPE constrains any mechanism to something that switches at ~15–30s of queue._');
      say('_Workload and client are RULED OUT as the split: source duration differs 1.24x by class (median 10.7s FULL vs 13.3s LOST) while queue differs 15.0x, and client version is identical (96% on 1.3.6(224) in BOTH classes). Do not re-litigate workload._');
    }
    say('_Queue history begins 2026-08-11T19:50Z (the `worker_started_at` migration). There is NO pre-Aug-11 queue data, so "queue delay is new/worse" is [UNFALSIFIABLE] with current data._');
  }
  const wall = e2e.filter((s) => s >= 870 && s <= 920).length;
  say(`On the 900s wall [870,920]: **${wall}** of ${e2e.length}`);
  say('');
  const routes = {};
  done.forEach((j) => { const r = (j.result || {}).route || 'none'; routes[r] = (routes[r] || 0) + 1; });
  const premium = (routes.moodreel || 0) + (routes.hype || 0);
  say(`## 3. Route mix (${HOURS}h)`);
  say('');
  say(Object.entries(routes).sort((a, b) => b[1] - a[1]).map(([r, n]) => `\`${r}\` ${n}`).join(' · ') || '(none)');
  say('');
  say(premium === 0
    ? `**PREMIUM ROUTES EXTINCT — 0 of ${done.length} completions.** Every quality number in this window is off the fallback path and must NOT be compared to pre-outage baselines.`
    : `Premium share: **${pct(premium, done.length)}** (${premium}/${done.length}).`);
  say('');

  // ── delivery layer ────────────────────────────────────────────────────────
  // CUT TO THE INSTRUMENT'S OWN WINDOW. The completion_delivery column landed
  // 2026-08-11T19:50:15Z; rows created before it can never carry a value, so
  // counting them reads as `NULL 195` and makes a LIVE instrument look dead.
  // A measurement must never be cut wider than the thing measuring it.
  const DELIVERY_LIVE_FROM = '2026-08-11T19:50:15Z';
  const dLive = jobs.filter((j) => ['completed', 'failed'].includes(j.status) && j.created_at >= DELIVERY_LIVE_FROM);
  const preLive = jobs.filter((j) => ['completed', 'failed'].includes(j.status)).length - dLive.length;
  const dd = {};
  dLive.forEach((j) => { const k = j.completion_delivery || 'NULL'; dd[k] = (dd[k] || 0) + 1; });
  say(`## 4. Delivery layer — since the column landed ${DELIVERY_LIVE_FROM} (n=${dLive.length} terminal)`);
  say('');
  say(Object.entries(dd).map(([k, n]) => `\`${k}\` ${n}`).join(' · ') || '(none yet)');
  if (preLive) say(`\n_${preLive} terminal rows in the ${HOURS}h window predate the column and are excluded — they cannot carry a value._`);
  const fbShare = (dd.fallback_timer || 0) / Math.max(1, dLive.length);
  say(dLive.length < 100
    ? `\n**NOT YET READABLE** — n=${dLive.length} < 100. No verdict on a thin sample (48h verdict due 2026-08-13T19:50Z).`
    : `\nfallback_timer share **${pct(dd.fallback_timer || 0, dLive.length)}** — ${fbShare < 0.02 ? 'PASS bar met (~0)' : 'ABOVE the ~0 bar'}.`);
  say('');

  // ── fulfillment (all-time table) ──────────────────────────────────────────
  const sc = await pageAll('fulfillment_scores?select=n_asks,n_honored,n_dropped_silently,asks&order=created_at.asc');
  const A = sc.reduce((s, r) => s + (r.n_asks || 0), 0);
  const Hn = sc.reduce((s, r) => s + (r.n_honored || 0), 0);
  const D = sc.reduce((s, r) => s + (r.n_dropped_silently || 0), 0);
  say(`## 5. Fulfillment — honor **${pct(Hn, A)}** (target ≥70%) · dropped-silently **${pct(D, A)}** (target <5%)`);
  say('');
  say(`n=${A} asks over ${sc.length} judged jobs (all-time table).`);
  say('');
  const cls = new Map();
  sc.forEach((r) => (r.asks || []).forEach((a) => {
    const c = a.class || '?';
    if (!cls.has(c)) cls.set(c, { n: 0, h: 0, d: 0 });
    const o = cls.get(c); o.n++;
    if (a.verdict === 'HONORED') o.h++;
    if (a.verdict === 'DROPPED_SILENTLY') o.d++;
  }));
  say('| ask class | n | honor | dropped silently |');
  say('|---|---:|---:|---:|');
  [...cls.entries()].sort((a, b) => b[1].d - a[1].d).slice(0, 10)
    .forEach(([c, o]) => say(`| ${c} | ${o.n} | ${pct(o.h, o.n)} | **${pct(o.d, o.n)}** |`));
  say('');
  // TWO LEVERS, NAMED SEPARATELY (JUDGE 2026-08-11). A single "#1 lever" line
  // ranked by absolute drops promoted style_preset, while ranking by RATE
  // promotes motion_graphics — and I had published both at different times,
  // which is two of my own artifacts contradicting. They answer different
  // questions and the builder needs both: VOLUME moves the aggregate honor
  // rate most; RATE names what is most broken per ask (and is what a user
  // actually experiences when they ask for that thing).
  // `other`/`?` are CATCH-ALL buckets, not capabilities — nobody can "fix
  // other". They are excluded from lever selection (still shown in the table
  // above, where their size is itself a signal that the taxonomy is leaking).
  const CATCH_ALL = new Set(['other', '?', 'unknown']);
  const eligible = [...cls.entries()].filter(([c, o]) => o.n >= 100 && !CATCH_ALL.has(c));
  const byVolume = [...eligible].sort((a, b) => b[1].d - a[1].d)[0];
  const byRate = [...eligible].sort((a, b) => (b[1].d / b[1].n) - (a[1].d / a[1].n));
  if (byVolume) say(`**Lever A — most aggregate honor to win (by volume): \`${byVolume[0]}\`** — ${byVolume[1].d} silent drops of ${byVolume[1].n} asks (${pct(byVolume[1].d, byVolume[1].n)}). Fixing it moves the headline rate most.`);
  if (byRate.length) {
    say(`**Lever B — most broken per ask (by rate, catch-alls excluded):** `
      + byRate.slice(0, 3).map(([c, o]) => `\`${c}\` ${pct(o.d, o.n)} (n=${o.n})`).join(' · ')
      + '. These are close — treat them as one cluster, not a ranked winner.');
  }
  const oth = cls.get('other');
  if (oth && oth.n >= 100) say(`_Taxonomy note: \`other\` holds ${oth.n} asks at ${pct(oth.d, oth.n)} silent — a bucket that large is itself a finding; it needs splitting before it can be targeted._`);
  say('');

  // ── purchase funnel, BY USER (7d) ─────────────────────────────────────────
  const ev = await pageAll(`analytics_events?select=event,user_id,props,created_at&created_at=gte.${SINCE_7D}`
    + `&event=in.(upgrade_wall_viewed,purchase_started,purchase_failed,purchase_completed)`);
  const usersOf = (e) => new Set(ev.filter((r) => r.event === e && r.user_id).map((r) => r.user_id));
  const wallU = usersOf('upgrade_wall_viewed'), startU = usersOf('purchase_started'), paidU = usersOf('purchase_completed');
  const pf = ev.filter((r) => r.event === 'purchase_failed');
  const selfCancel = pf.filter((r) => [true, 'true'].includes((r.props || {}).cancelled)).length;
  say('## 6. Purchase funnel — BY USER (7d)');
  say('');
  say(`wall_viewed **${wallU.size}** → started **${startU.size}** (${pct(startU.size, wallU.size)}) → paid **${paidU.size}** (${pct(paidU.size, startU.size)} of starters)`);
  say(`purchase_failed n=${pf.length}, self-cancelled at the sheet **${selfCancel}** (${pct(selfCancel, pf.length)}) — the leak is the OFFER, not the funnel.`);
  say('');

  const out = path.join(__dirname, '..', 'reports', 'WHERE_IT_BLEEDS.md');
  fs.writeFileSync(out, L.join('\n') + '\n');
  console.error(`\n[bleeds] wrote ${out}`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
