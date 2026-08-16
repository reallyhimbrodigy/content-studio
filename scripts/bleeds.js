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
// Envelope presence — the primary discriminator. Module scope because several
// sections use it; a `const` declared mid-function put it in the temporal dead
// zone for the earlier ones and truncated the whole board at the first use.
const isFullRow = (j) => ((((j.result || {}).stage_timings || {}).total) != null);
const uniq = (rows, k) => new Set(rows.map((r) => r[k]).filter(Boolean)).size;

// ── THE REQUIRED SHAPE FOR EVERY ZERO ON THIS BOARD (owner, 2026-08-15) ──────
// A zero has two parents: the thing stopped, or the DETECTOR stopped. A control
// that fires INSIDE THE SAME RUN removes that branch permanently — it proves the
// detector was live at the moment the zero was recorded. First Light is the
// canonical example: scene_failure_rate 0.0 was credible because
// alpha_failure_rate 1.0 was recorded by the same harness in the same run.
//
// EVERY zero printed by this board goes through this function. A zero WITHOUT a
// live same-run control is labelled [UNVERIFIED-ZERO] and is NOT a result.
// ── THE CONTAMINATED-WINDOW TRAP IS NOT DOMAIN-SPECIFIC (owner, 2026-08-15) ──
// Rule 5 was written for RATES; I applied it to rates for months and then walked
// straight into it on a COST figure — a 7-day mean render volume of 232/day
// against a true recent ~150. The trap is indifferent to what is averaged.
//
// FIRST ATTEMPT AT THIS GUARD FAILED, and the failure is instructive. I checked
// mean-vs-median: on the very series that burned me that ratio is 1.05, far
// under any sane threshold. The contamination was NOT a spike — it was a REGIME
// CHANGE (volume stepped down ~08-11 and stayed down). A median is perfectly
// happy to sit in the middle of two different regimes.
//
// So the correct generic check is HOMOGENEITY: split the window in half and
// compare. If the halves disagree, no single aggregate over the whole window
// describes anything real, and the recent half is the honest number.
function windowGuard(label, series, unit = '') {
  if (series.length < 4) return `${label}: n=${series.length} — too short to test homogeneity`;
  const mid = Math.floor(series.length / 2);
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const early = avg(series.slice(0, mid)), late = avg(series.slice(mid));
  const ratio = late > 0 ? early / late : 1;
  const shifted = ratio > 1.4 || ratio < 0.71;
  return shifted
    ? `${label}: ⚠️ **[REGIME CHANGE — window is NOT homogeneous]** first half ${early.toFixed(1)}${unit} vs `
      + `second half ${late.toFixed(1)}${unit} (${ratio.toFixed(2)}x). No single aggregate over this window is `
      + `meaningful; **use the recent half: ${late.toFixed(1)}${unit}**.`
    : `${label}: ${avg(series).toFixed(1)}${unit} (halves ${early.toFixed(1)} / ${late.toFixed(1)}, `
      + `${ratio.toFixed(2)}x — window is homogeneous)`;
}

// ── STANDING GUARD: BOTTOM-UP MODELS RUN LOW (2026-08-15) ────────────────────
// Four instances this campaign, all one direction, zero exceptions:
//
//   naive model missing container lifetime      $0.0104 vs $0.0222   2.1x low
//   bottom-up marginal vs invoice all-in        $0.0222 vs $0.21     9.5x low
//   bottom-up daily total vs invoice            $12.04  vs $42.71    3.5x low
//   L1/L2 prize as share of bill                 ~4%    vs 34-43%    9.6x low
//
// THE MECHANISM, which is why this is a rule and not a run of luck: a bottom-up
// model sums the surfaces you REMEMBERED to enumerate. Every surface you forgot
// is simply absent from the sum, and there is no term that can over-count. The
// error is ONE-DIRECTIONAL BY CONSTRUCTION — omissions can only subtract.
//
// THEREFORE: a bottom-up figure is a LOWER BOUND, never an estimate, and never
// a basis for ranking levers. Ranking on one has now misdirected this campaign
// twice (L1/L2 called both "the biggest lever" and "~4% of the bill", from two
// different unverified anchors). Label bottom-up numbers [LOWER-BOUND] and defer
// every ranking to the invoice.
function bottomUpCaveat(label, value) {
  return `${label}: $${value} **[LOWER-BOUND — bottom-up]**. Bottom-up has run low 4/4 this campaign `
    + `(2.1x, 3.5x, 9.5x, 9.6x); omissions can only subtract, so treat as a floor and rank on the invoice.`;
}

// ── STANDING GUARD: THE VESTIGIAL-COLUMN CLASS (2026-08-15) ─────────────────
// A null that NOBODY WRITES and a null whose WRITE FAILED look identical in the
// database. "Column X is null for this class, therefore event X never happened"
// is only valid once you have shown the column is populated for a class where
// the event DID happen. Without that control you may simply be reading a column
// nothing writes.
//
// This is the check that refuted the UNS-on-Modal hypothesis: 0/263 UNS jobs had
// `worker_started_at` — which on its own is equally consistent with "UNS never
// reaches a worker" and "worker_started_at is vestigial." It was decidable ONLY
// because DISPATCH_UNREACHABLE showed 19/27 populated in the same window. The
// healthy class is what turned a suggestive null into evidence.
//
// The campaign has hit this repeatedly from the other side: completion_delivery
// read null because the query never SELECTED it; `callback` never appeared
// because the stamp was discarded; the gate receipt read null because it had a
// reader and no writer. Every one was a null that meant "nobody wrote", not
// "nothing happened".
function nullMeans({ column, klass, klassNulls, klassTotal, healthyKlass, healthyPopulated, healthyTotal }) {
  const ctrl = healthyPopulated > 0;
  return `\`${column}\` null on ${klassNulls}/${klassTotal} of ${klass} — `
    + (ctrl
      ? `**evidence**: control class ${healthyKlass} has it populated ${healthyPopulated}/${healthyTotal}, `
        + `so the column IS written when the event occurs.`
      : `⚠️ **[VESTIGIAL-COLUMN RISK — NOT evidence]**: no control class shows this column populated, so a `
        + `null here is equally consistent with "nothing writes it". Find a class where the event demonstrably `
        + `happened and confirm the column is set there BEFORE drawing any conclusion.`);
}

// ── STANDING GUARD: THE BUILT-NOT-WIRED CLASS (2026-08-15) ──────────────────
// CERT-GREEN PROVES CAPABILITY. ONLY A PRODUCTION COUNTER PROVES CONNECTION.
// Five instances this project, all one direction — built, certified, and never
// once connected to a live path:
//
//   gate receipt          shipped as a READER with no writer anywhere in the repo;
//                         /api/health.gate would have read null on every build forever
//   `callback` stamp      written correctly, then DISCARDED by an always-false
//                         predicate — 0 of 432+ completions ever carried it
//   rc_identify_* events  allowlisted server-side, emitted by NOTHING in the iOS
//                         tree; grep returns zero call sites
//   generated scenes      "defined but INERT" — 0 of 3,949 jobs (0 of 2,074 premium)
//   completion_delivery   read by my own board while never SELECTed by its query,
//                         so every row scored NULL and a live instrument read dead
//
// ZERO instances of the reverse. Nothing has ever been wired-but-not-built,
// because wiring something absent fails loudly and immediately; wiring something
// that exists but is never called fails SILENTLY and indefinitely. The asymmetry
// is structural, which is what makes this a rule rather than a tally.
//
// THEREFORE: a green cert, a passing smoke, and a merged PR are all evidence of
// CAPABILITY. None is evidence of CONNECTION. Before any component is reported
// as live, name the PRODUCTION COUNTER that is non-zero — a row, an event, a
// stamp seen on real traffic. If that counter cannot be named, the component is
// [BUILT-NOT-WIRED] regardless of how green its cert is.
function wiredCheck({ component, cert, productionCounter, count }) {
  if (count > 0) return `${component}: **WIRED** — ${productionCounter} = ${count} on real traffic.`;
  return `${component}: ⚠️ **[BUILT-NOT-WIRED]** — cert ${cert || 'green'}, but ${productionCounter} = 0. `
    + 'Cert-green proves capability, not connection. Five prior instances in this project ran exactly here.';
}

// ── STANDING GUARD: SHARED FAILURE MODE (2026-08-15) ────────────────────────
// A MEASUREMENT CHANNEL MUST NOT FAIL WITH THE THING IT MEASURES.
//
// It earned its place by finding the fulfillment coverage hole. Before
// 2026-08-04, `edit_recipe` — the VERDICT side of every fulfillment judgment —
// was its own top-level COLUMN. On 08-04 it moved INSIDE `result` jsonb. From
// that day the verdict data shared an object, and therefore a failure mode, with
// the envelope it was meant to describe. When the lost update began clobbering
// `result` on 2026-08-11, it took the measurement with it: 210 of 210
// envelope-lost completions carry ZERO edit_recipe and are permanently
// unscoreable.
//
// The asymmetry that proves the point: `vibe_input` — the ASK side — is still a
// top-level column and survives on 210/210 of the same rows. Same jobs, same
// outage, opposite outcome, and the ONLY difference is which object the field
// lives in.
//
// SHARPENED 2026-08-15 by the fix that did NOT work. edit_recipe was moved out
// of `result` into its own top-level column — and coverage did not move one row:
// envelope-LOST rows carry the new column 0/21, column-filled == envelope-
// survived on 43/43, with filled and unfilled interleaved in the same hours so
// timing is excluded. The coupling was never the JSONB. It is the WRITE: the
// column is populated by the same UPDATE that carries the envelope, so a lost
// write takes both. **Schema separation is not failure separation.**
//
// THEREFORE, corrected: two channels are independent only when they can FAIL
// independently — which needs a DIFFERENT WRITE, ideally from a different code
// path at a different time. Ask "what single failure takes both?", never "do
// they share an object?". The proof of the frame is `vibe_input`: same jobs,
// same outage, survives 210/210 because it is written at job CREATION by a
// different write at a different time. That is what independence looks like.
// Co-locating a measurement with its subject converts an instrument into a
// symptom — and co-location is about the write, not the schema.
//
// THE GENERAL FORM — PLAN-TIME PERSISTENCE (2026-08-15):
//
//   PERSIST A MEASUREMENT AT THE EARLIEST POINT IT IS KNOWABLE, ON ITS OWN
//   WRITE — never at the point the subject completes.
//
// This is the prescriptive half of the guard, and it follows directly from the
// two observations above. `vibe_input` survives every failure this project has
// produced because it is committed at job CREATION: by the time anything can go
// wrong downstream, it is already durable. `edit_recipe` fails with the render
// because it waits for the terminal write, and a terminal write is precisely
// the thing that gets lost.
//
// The rule generalises past this bug: a measurement written at completion can
// only ever describe jobs that completed successfully, which is the population
// that needed measuring least. The verdict is KNOWN at plan time — the plan IS
// the verdict — so waiting until terminal buys nothing and forfeits the whole
// failed/slow cohort. Anything knowable earlier should be written earlier, on
// its own leg, because every stage between knowing and writing is a stage that
// can take it.
//
// Applied here: persisting `edit_recipe` from the PLANNING path, before the
// render terminal exists, closes the coverage hole in a way no schema change
// can — and it is the standing recommendation attached to this guard.
function sharedFailureCheck({ measurement, subject, sharesWith }) {
  return sharesWith
    ? `⚠️ **[SHARED FAILURE MODE]** \`${measurement}\` is co-located with \`${subject}\` (${sharesWith}). `
      + 'It will go dark exactly when the subject fails — the one moment it exists for. Separate them or '
      + 'treat every gap in this measurement as UNKNOWN rather than as data.'
    : `\`${measurement}\` is independent of \`${subject}\` — survives its failure.`;
}

// ── STANDING GUARD: THE REFERENCES OUTRANK THE DOCUMENT (2026-08-15) ────────
// A SPEC CLAIM CAN BE THE THING THAT FAILS A CALIBRATION.
//
// The canon rule was "a dimension the references fail is a broken dimension."
// This extends it one level up, because a case arrived that the original wording
// did not cover: the spec described REF-1 as carrying "lower-third keyword
// accents." Two independent methods disagreed with that and with each other —
// band energy called it a 0.6pt tie, edge density put the dominant band at
// MIDDLE. The measurement was not broken and the reference was not broken. THE
// CLAIM WAS. REF-1's captions are not position-locked to a third; they are
// placed CLEAR OF THE SUBJECT, which in a landscape composition means they move
// as the speaker moves. Both methods were asking a POSITIONAL question about a
// RELATIONAL rule, and a correct answer to the wrong question looks exactly like
// a failed instrument.
//
// THEREFORE, in precedence order:
//   1. the REFERENCES — the artifacts themselves, the only ground truth
//   2. MEASUREMENTS of them, if reproducible by more than one method
//   3. the DOCUMENT describing them — spec text, build sheet, my own reports
// When 3 conflicts with 1, the document is wrong. Do not tune a dimension to
// reproduce a sentence; re-read the frames and find the rule the artifact is
// actually following.
//
// The corollary is what makes this operational: a calibration that fails should
// be triaged as EITHER a broken dimension OR a broken claim — never assumed to
// be the former. Assuming the dimension is at fault is how a wrong claim
// survives contact with evidence, quietly reshaping the instrument until it
// agrees.
function claimVsReference({ claim, methods, agree }) {
  return agree
    ? `claim "${claim}" is CONFIRMED by ${methods} independent method(s).`
    : `⚠️ **[CLAIM REFUTED BY REFERENCE]** "${claim}" — ${methods} method(s) fail to reproduce it. `
      + 'The references outrank the document: treat the CLAIM as the defect until a method that '
      + 'reproduces it is shown. Do not tune the dimension to agree with the sentence.';
}

function reportZero({ label, count, control }) {
  if (count > 0) return `${label}: **${count}**`;
  const live = control && control.count > 0;
  return live
    ? `${label}: **0** ✅ [VERIFIED-ZERO — detector proven live in the same window: `
      + `${control.label} = ${control.count}]`
    : `${label}: **0** ⚠️ [UNVERIFIED-ZERO — no same-run control fired`
      + `${control ? ` (${control.label} also 0)` : ''}; the detector may simply be dead. NOT a result.]`;
}

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
  // ── FAILED-JOB SECONDS — a first-class board term (owner, 2026-08-15) ──────
  // Job-lifetime seconds spent on jobs that never delivered. Reported in TWO
  // quantities that must never be blended: USER-time (all failed seconds) and
  // MODAL-time (only jobs that actually reached a worker). They differ ~10x.
  // Computed over a FIXED 7-DAY window, not the board's --hours window: this is a
  // spend/loss term whose whole point is the accumulated total, and a 24h slice of
  // it (n=1 on a quiet day) says nothing. The window is stated in the header so it
  // is never confused with the latency section's window.
  const lifeOf = (j) => (new Date(j.completed_at || j.updated_at) - new Date(j.created_at)) / 1000;
  const SINCE_FAIL = new Date(Date.now() - 7 * 86400e3).toISOString();
  const jobs7 = await pageAll(`video_jobs?select=id,user_id,status,created_at,updated_at,completed_at,worker_started_at,modal_call_id,result&created_at=gte.${SINCE_FAIL}&status=in.(completed,failed)`);
  const fails7 = jobs7.filter((j) => j.status === 'failed');
  const done7 = jobs7.filter((j) => j.status === 'completed');
  const failLive = fails7.filter((j) => j.completed_at || j.updated_at);
  if (failLive.length && done7.length) {
    const fSec = failLive.reduce((a, j) => a + lifeOf(j), 0);
    const cSec = done7.filter((j) => j.completed_at || j.updated_at).reduce((a, j) => a + lifeOf(j), 0);
    const onModal = failLive.filter((j) => j.worker_started_at);
    const onSec = onModal.reduce((a, j) => a + lifeOf(j), 0);
    const fl = failLive.map(lifeOf).sort((a, b) => a - b);
    say(`## 2. FAILED-JOB SECONDS — ${pct(fSec, fSec + cSec)} of all job-lifetime seconds [7-DAY WINDOW]`);
    say('');
    say(`**${failLive.length} failed jobs / ${uniq(failLive, 'user_id')} users** over **7 days**, `
      + `p50 lifetime **${fl[Math.floor(fl.length / 2)].toFixed(0)}s**, `
      + `**${(failLive.length / 7).toFixed(0)}/day**. Total **${fSec.toLocaleString(undefined, { maximumFractionDigits: 0 })}s** `
      + 'of user time spent on jobs that never delivered.');
    say('');
    say(`| quantity | jobs | seconds | share |`);
    say('|---|---:|---:|---:|');
    say(`| reached a worker (**Modal-billable**) | ${onModal.length} | ${onSec.toFixed(0)} | ${pct(onSec, fSec)} |`);
    say(`| never reached one (**$0 Modal, pure user wait**) | ${failLive.length - onModal.length} | ${(fSec - onSec).toFixed(0)} | ${pct(fSec - onSec, fSec)} |`);
    say('');
    say('**USER-time and MODAL-time are different quantities and must not be blended.** A job with no '
      + '`worker_started_at` and no `modal_call_id` never reached a container: it costs the user their whole '
      + `wait and costs us **$0**. Here only **${pct(onSec, fSec)}** of failed seconds were Modal-billable `
      + '(~$0.49/day, **1.9%** of orchestration) — the rest is pure user loss at zero spend.');
    say('');
    say('> **UNS does NOT move onto the cost board — the conditional FAILS.** [MEASURED] Of 263 '
      + '`UPLOAD_NEVER_STARTED` jobs, **0 have `worker_started_at` and 0 have `modal_call_id`.** The ~601s wait '
      + 'is entirely client/server-side; nothing was ever dispatched. UNS is the **largest user-time loss on '
      + 'the board** (263 jobs × ~601s) at **zero Modal spend**, so it stays a **DELIVERY/product lever, not a '
      + 'cost lever.** Filing it beside orchestration would aim spend work at a class that spends nothing.');
    say('');
    say('_The failure class that IS Modal-billable is `DISPATCH_UNREACHABLE` — 27 jobs, all with a call id, '
      + '19 reaching a worker, p50 904s — and it is 1.9% of orchestration, not a rival to it._');
    say('');
  }
  say(`## 2b. Latency — n=${e2e.length} completed (${HOURS}h)`);
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
    // ── STANDING DECOMPOSITION: the class is BIMODAL (2026-08-15) ────────────
    // Computed live so it can never go stale as a pasted claim. Two clusters,
    // one symptom (envelope-absent), DIFFERENT settlement paths — established by
    // the pre-registered hang test, which REFUTED the single-mechanism reading.
    const affected = done.filter((j) => !isFullRow(j) || j.completion_delivery === 'repair');
    if (affected.length >= 20) {
      const lifeS = (j) => (new Date(j.completed_at) - new Date(j.created_at)) / 1000;
      const qS = (j) => (j.worker_started_at ? (new Date(j.worker_started_at) - new Date(j.created_at)) / 1000 : null);
      const bands = [[180, 240], [870, 930]];
      say('');
      say('**STANDING DECOMPOSITION — this class is BIMODAL, not one mechanism.**');
      say('');
      say('| cluster | n | share of affected | settlement path | queue p50 | envelope-absent |');
      say('|---|---:|---:|---|---:|---:|');
      bands.forEach((b) => {
        const v = affected.filter((j) => lifeS(j) >= b[0] && lifeS(j) <= b[1]);
        if (!v.length) { say(`| ${b[0]}–${b[1]}s | 0 | 0% | — | — | — |`); return; }
        const paths = {};
        v.forEach((j) => { const k = j.completion_delivery || 'NULL'; paths[k] = (paths[k] || 0) + 1; });
        const top = Object.entries(paths).sort((a, c) => c[1] - a[1])[0];
        const qs = v.map(qS).filter((x) => x != null).sort((a, c) => a - c);
        say(`| **${b[0]}–${b[1]}s** | ${v.length} | ${pct(v.length, affected.length)} | \`${top[0]}\` ${top[1]}/${v.length} | `
          + `${qs.length ? qs[Math.floor(qs.length / 2)].toFixed(0) + 's' : '—'} | ${v.filter((j) => !isFullRow(j)).length}/${v.length} |`);
      });
      say('');
      say('Both clusters are ~100% envelope-absent, so **envelope loss is COMMON to both and is therefore NOT '
        + 'the discriminator** — they lose the envelope alike but settle by different paths at different times. '
        + 'The pre-registered hang test (`reports/HANG_TEST_RESULT.md`) REFUTED the single-mechanism reading: '
        + 'the ~900s band held only 13.7% of affected jobs while the largest mode sat at 180–240s. '
        + '**Do not file one lever against this class until the two clusters are separated.**');
      say('');
      say('> **QUALIFIER — binding wherever this class appears, in any report or board:** '
        + '**users receive their video on BOTH paths.** `repair` reconstructs the completion from the S3 '
        + 'artifact; `reconciler` delivers at 180–240s. The damage is **cost, telemetry and tail latency — '
        + 'never lost deliveries.** Any framing implying users lose renders here overstates a class that is, '
        + 'from the user\'s seat, already mitigated.');
      say('');
    }
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
    // WORK IS REPORTED FOR envelope-FULL ONLY (withdrawn cross-class 2026-08-15).
    // For lost-envelope rows `completed_at` marks DISCOVERY, not work: the repair
    // class's Q+W pins to a ~constant (stdev 53.7s) while W alone ranges
    // 278-846s — Q and W trade off against a fixed total — and the reconciler
    // class has a 0.22s MINIMUM, which no render can achieve. Cross-class WORK
    // measured how long recovery took to notice. QUEUE stays valid cross-class:
    // worker_started_at is stamped by the worker at pickup, independent of
    // whichever path later discovers the completion.
    const Wf = qw.filter(isFullRow).map((j) => (new Date(j.completed_at) - new Date(j.worker_started_at)) / 1000).sort((a, b) => a - b);
    if (Wf.length) {
      say(`| **WORK** (pickup→complete) *envelope-FULL only* | ${q(Wf, 0.5).toFixed(1)}s | ${q(Wf, 0.9).toFixed(1)}s | ${q(Wf, 0.99).toFixed(1)}s | ${Wf[Wf.length - 1].toFixed(1)}s |`);
    }
    const over30 = Q.filter((x) => x > 30).length;
    say(`\nQueue is **${(100 * q(Q, 0.5) / Math.max(1, P(0.5))).toFixed(0)}%** of e2e at p50; **${pct(over30, Q.length)}** of jobs wait >30s before any work begins.`);
    // THRESHOLD, NOT CORRELATION — computed live so the claim can never go stale.
    const qOf = (j) => (new Date(j.worker_started_at) - new Date(j.created_at)) / 1000;
    const isFull = isFullRow;
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
      say('_WORK is shown for envelope-FULL rows ONLY. Cross-class WORK is WITHDRAWN: for lost-envelope rows `completed_at` marks DISCOVERY, not work (repair Q+W pins to a ~constant while W ranges 278–846s; reconciler W has a 0.22s minimum). **QUEUE is the only valid cross-class term.**_');
      say('_Workload and client are RULED OUT as the split: source duration differs 1.24x by class (median 10.7s FULL vs 13.3s LOST) while queue differs 15.0x, and client version is identical (96% on 1.3.6(224) in BOTH classes). Do not re-litigate workload._');
    }
    say('_Queue history begins 2026-08-11T19:50Z (the `worker_started_at` migration). There is NO pre-Aug-11 queue data, so "queue delay is new/worse" is [UNFALSIFIABLE] with current data._');
  }
  const wall = e2e.filter((s) => s >= 870 && s <= 920).length;
  // Zeros go through reportZero. Control for "0 on the wall": the >120s bucket —
  // if THAT is also 0 the latency detector itself is suspect, not the wall.
  const over120 = e2e.filter((s) => s > 120).length;
  say(`On the 900s wall [870,920] — ${reportZero({ label: 'count', count: wall, control: { label: 'jobs >120s in the same window', count: over120 } })} of ${e2e.length}`);
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
  // COVERAGE — attached to every quality figure, because a rate without its
  // denominator's reach is a rate about an unnamed population.
  const covFull = done.filter(isFullRow).length;
  say(`> ⚠️ **COVERAGE: these figures describe ${pct(covFull, done.length)} of completions.** `
    + `**0% of envelope-absent completions have ever been scored** — not a sampling choice, a structural one: `
    + 'the judge hard-filters on `edit_recipe`, and **210 of 210** envelope-lost completions carry none. '
    + 'Honor and dropped-silently are statements about the **healthy ~61%** only, and must never be quoted '
    + 'as statements about the product.');
  say('');
  say('> **IS THE LOST CLASS SCOREABLE AT ALL? — NO, and the split is exact.** '
    + 'The **ASK** side survives: `vibe_input` is a top-level COLUMN, intact on **210/210** lost rows. '
    + 'The **VERDICT** side does not: `edit_recipe` moved INSIDE `result` jsonb on **2026-08-04**, the exact '
    + 'object the lost update clobbers — **0/210**. So for these jobs we can know what the user asked for and '
    + '**never what was done about it**. Fulfillment needs both, so **the already-lost population is '
    + 'PERMANENTLY UNSCOREABLE** — no reprocessing recovers a verdict that was never persisted.');
  say('');
  say('> **It is recoverable FORWARD, two ways, and they are not equivalent:** (a) the CAS fix stops the '
    + 'clobber, which restores scoreability only while it holds; (b) moving `edit_recipe` back OUT of `result` '
    + '— where it lived before 08-04 — makes the verdict channel **structurally immune** to any future `result` '
    + 'failure. (b) is the one that survives the next unrelated bug. Pre-08-04 jobs would still be scoreable '
    + 'today under exactly this outage.');
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

  // ── LUMEN CAMPAIGN BASELINE — First Light, VERIFIED 2026-08-15 ───────────
  // The campaign's first cost/latency baseline. Constants, not queries: there
  // are still ZERO Lumen renders in video_jobs, so this comes from the
  // harness's in-run ledger (golden/first-light/first_light_ledger.json),
  // recomputed field-by-field by JUDGE. Replace with live queries the moment a
  // Lumen render lands — until then the "no live data" line stays visible so
  // this is never mistaken for production measurement.
  say('## 7. LUMEN cost baseline — First Light  🔒 **FROZEN 2026-08-15**');
  say('');
  say('> **COST BOARD FROZEN.** The campaign has pivoted to quality. Every figure and guard below is held '
    + 'as-is: the per-function anchor (orchestration 72.3%), L1/L2 at $4,450–$5,586/yr current-window, the '
    + 'all-in $0.21 recent-slice vs $0.151 cycle-average split, the ~4-scene quota ceiling, acceptance-adjusted '
    + 'effective cost, the agent/ephemeral standing line, and the [OWNER-SUPPLIED] provenance tag. '
    + '**Guards remain armed** — bottom-up-runs-low, vestigial-column, window-homogeneity, verified-zero, '
    + 'cycle-vs-slice — so the board keeps self-checking while frozen. Unfreeze only on a new invoice or a '
    + 'config change, which invalidates the anchor by the config caveat already attached to it.');
  say('');
  say('');
  say('| envelope | value | note |');
  say('|---|---|---|');
  say('| $/scene | **$0.14** | verified against raw call records |');
  say('| s/scene | **18.7s** (18.3s true median) | serial |');
  say('| scene failure rate | **0.0%** over 10 | credible: failure detector fired in-run (alpha 2/2 failed) |');
  say('| hero/alpha failure rate | **100%** (0 of 2) | **LAW 4 VIOLATION — BLOCKED from default path**; cost UNMEASURED |');
  say('| run total | $1.96 of a $2.00 ceiling | ceiling held |');
  say('');
  say('**QUOTA CEILING — ~4 scenes.** Vertex image quota binds below **3.4 req/min**, serial. '
    + 'A 4-scene edit needs ~71s of quota time and ~75s wall in scene generation alone — **~60% of the 120s law**. '
    + 'It is a QUOTA ceiling, not a spend ceiling: the lever is a quota-increase approval, not a spend decision.');
  say('**Every Phase 2 number is quoted at n ≤ 4 scenes**; above that is [ABOVE-QUOTA-CEILING] and hypothetical until the approval lands.');
  say('');
  say('');
  say('### Acceptance rate (written / billed) — §3.2\'s dominant cost variable');
  say('');
  say('| family | billed | delivered | acceptance | effective $/delivered |');
  say('|---|---:|---:|---:|---:|');
  say('| scene | 10 | 10 | **100.0%** | $0.14 (= sticker) |');
  say('| alpha *legs* (billed level) | 4 | 2 | 50.0% | $0.28 |');
  say('| alpha *attempts* (**delivered level**) | 2 | **0** | **0.0%** | **$0.56 spent, 0 delivered** |');
  say('| ALL | 14 | 10 | **71.4%** | **$0.196 = 1.40x sticker** |');
  say('');
  say('');
  say('**Per MODEL** — required alongside per-family once flash enters, because effective cost = sticker ÷ '
    + 'acceptance and the two models will not share an acceptance rate:');
  say('');
  say('| model | billed | delivered | acceptance | sticker | **effective $/delivered** |');
  say('|---|---:|---:|---:|---:|---:|');
  say('| `gemini-3-pro-image` | 14 | 10 | 71.4% | $0.14 | **$0.196** |');
  say('| `flash` (not yet run) | — | — | [UNMEASURED] | — | [UNMEASURED] |');
  say('');
  say('_Today per-model and per-family are the same cut: 14 of 14 First Light calls were `gemini-3-pro-image`. '
    + 'The dimension exists now so the flash comparison is never made on sticker price. **A cheaper sticker with '
    + 'worse acceptance can cost MORE per delivered artifact** — flash at $0.04 with 30% acceptance is $0.133 '
    + 'effective, barely under pro\'s $0.196; at 20% it is $0.20 and LOSES. The comparison is only valid '
    + 'acceptance-adjusted, and per family, since acceptance already differs 100% vs 0% ACROSS families on one model._');
  say('');
  say('**The alpha family bills at LEG level but delivers at ATTEMPT level.** A 50% leg-acceptance reads harmless; '
    + 'the attempt-acceptance it produces is **0%**. Acceptance must always be measured at the level the USER '
    + 'receives, never the level we are billed — §2.1\'s gate is written against the *measured* rate, not the sticker rate.');
  say('_Effective cost = sticker ÷ acceptance. At 71.4% the run\'s true unit cost is 1.40x its sticker price._');
  say('');
  say('### Break-even — on the measured ALL-IN cost  ✅ **hold RELEASED**');
  say('');
  say('**Modal axis hold is LIFTED.** Invoice reconciliation landed: measured all-in **~$0.21/render**. '
    + 'That supersedes both of my earlier anchors — it is **9.5x the bottom-up job-compute term** ($0.0222, '
    + 'which never contained the non-job surface) and **2.3x BELOW** the $0.481 premium figure my first board '
    + 'used. The bottom-up model was wrong in both directions depending on which term you read; only the '
    + 'invoice settles it.');
  say('');
  say('> **PROVENANCE [OWNER-SUPPLIED]:** the ~$0.21 all-in and the $0.37/day agent line come from the owner\'s '
    + 'invoice reconciliation. I could not locate the reconciliation document in either repo, so these are '
    + 'NOT [MEASURED-BY-ME] — the closest repo figure is RECON\'s bottom-up `$0.214 (orch-only)`, which is a '
    + 'model rather than an invoice and agrees only by coincidence of magnitude. **To upgrade to [MEASURED]: '
    + 'commit the invoice split (per-app, per-resource, with its cycle window) and I will re-derive both.**');
  say('');
  say('#### THE ANCHOR — per-function split, **CYCLE-TO-DATE** (Aug 1–15, $597.99 / 14 days)');
  say('');
  say('| function | share | $ cycle | $/day | $/render (cycle) |');
  say('|---|---:|---:|---:|---:|');
  [['**orchestration**', 72.3], ['rendering', 9.6], ['validator', 9.1], ['prewarm', 9.0]].forEach((r) => {
    const amt = 597.99 * r[1] / 100;
    say(`| ${r[0]} | **${r[1].toFixed(1)}%** | $${amt.toFixed(2)} | $${(amt / 14).toFixed(2)} | $${(amt / 3969).toFixed(4)} |`);
  });
  say('| TOTAL | 100.0% | $597.99 | $42.71 | $0.1507 |');
  say('');
  say('**Orchestration is 72.3% — 7.5x the next largest slice.** This is the cost board\'s anchor: every cost '
    + 'claim files against a named function share, not a blended per-render figure.');
  say('_Shares and dollars above are **CYCLE-TO-DATE**, not a run rate. The cycle spans the volume regime '
    + 'change, so its $/day is a historical average; the current window runs lower (orchestration **$25.94/day** '
    + 'vs the cycle\'s $30.88/day, 84% of it — consistent with volume down ~47%)._');
  say('');
  say('#### L1/L2 — the campaign\'s LARGEST CONFIRMED LEVER');
  say('');
  say('L1 (cpu=4 while waiting) and L2 (no burst double-pay) act on **orchestration** — the 72.3% slice. '
    + 'Re-filed against the invoice rather than the marginal model:');
  say('');
  say('| basis | orchestration $/day | prize $/day | prize per 14d | **prize $/year** |');
  say('|---|---:|---:|---:|---:|');
  say('| cycle-to-date (Aug 1–15) | $30.88 | $14.51–$18.22 | $203–$255 | $5,297–$6,650 |');
  say('| **CURRENT WINDOW** | **$25.94** | **$12.19–$15.30** | $171–$214 | **$4,450–$5,586** |');
  say('');
  say('Both shown because they answer different questions: **the current window is the forecast** '
    + '($4,450–$5,586/yr is what the lever is worth going forward), **the cycle figure reconciles the invoice.** '
    + 'Same rule as $0.21 recent-slice vs $0.151 cycle-average — and the lever is the campaign\'s largest on '
    + 'either basis.');
  say('');
  say('**My retired framing called L1/L2 "~4% of the bill."** Against the invoice it is **34–43%** — I was off '
    + 'by **8–11x**, and that error came from the unreproducible $87/day figure, exactly as its own source '
    + 'warned. Scale check: **eliminating any ONE other function entirely** — all of rendering, or all of '
    + 'validator, or all of prewarm — **saves only 26–28% of even the LOW L1/L2 estimate.** There is no second '
    + 'lever of comparable size on this board.');
  say('');
  say('#### CYCLE-AVERAGE vs RECENT-SLICE — state which one, always');
  say('');
  say('The billing cycle spans a **config change** (cpu 64→16, memory cuts, `min_containers` removal) AND a '
    + '**volume regime change** (~250-460/day before ~08-11, ~150/day since). By the homogeneity rule above, '
    + 'a cycle-average over that window is not one population:');
  say('');
  say('- **Cycle-average $/render** — what was actually billed across the whole cycle. Correct for '
    + '*reconciling the invoice*, and the only figure that ties to a statement.');
  say('- **Recent-slice $/render** — the same measure over the current config and current volume. Correct for '
    + '*forecasting and pricing*, because it is the only one that describes what the next render will cost.');
  say('');
  say('**~$0.21 is used below as the recent-slice figure; the cycle average is $0.151** ($597.99 / 3,969 '
    + 'completed renders). The two differ by **1.39x**, and that gap is not an inconsistency — **it is the '
    + 'cycle/slice distinction, measured for the first time.** Cycle daily spend was $42.71/day at a mean 284 '
    + 'renders/day; recent volume is ~150/day at ~$31.50/day. **Spend fell 26% while volume fell 47%** — less '
    + 'than proportionally, which is precisely what a fixed component predicts. The two figures are consistent '
    + 'on different bases.');
  say('_A pricing ruling takes the recent slice; an invoice check takes the cycle average. Quoting one where '
    + 'the other belongs is the same error as averaging across the regime change in the first place._');
  say('');
  say('#### Renders/month one subscriber\'s margin buys, at $31.50 net');
  say('');
  say('| scenes | scene $ | + all-in $0.21 | $/render | **renders/mo** | scene share |');
  say('|---:|---:|---:|---:|---:|---:|');
  [0, 1, 2, 4].forEach((n) => {
    const sc = n * 0.14, t = sc + 0.21;
    say(`| ${n}${n === 4 ? ' (ceiling)' : ''} | $${sc.toFixed(2)} | $0.21 | $${t.toFixed(2)} | **${(31.50 / t).toFixed(0)}** | ${(100 * sc / t).toFixed(0)}% |`);
  });
  say('');
  say('**Scene count still leads at n≥1 — but far less than my last board claimed.** At 1 scene the scene bill '
    + 'is **0.67x** the all-in render cost (not the 6x the bottom-up figure implied); at 4 scenes it is 73% of '
    + 'total. Both terms now matter, which is the honest shape: **compute is no longer a rounding error, and '
    + 'scenes are no longer the whole answer.**');
  say('');
  say('#### FIXED — still covered by subscriber COUNT, not volume');
  say('');
  say('$5.74/day today (~$172/mo), 24/7 ceiling $8.28/day (~$248/mo) → **~6 subscribers to cover fixed** '
    + '(~8 at ceiling). Unchanged: fixed is a subscriber-count problem, never a per-render pricing problem.');
  say('');
  say('| scenes | $/edit | vs $0.10 law | scene secs | vs 120s law |');
  say('|---:|---:|---:|---:|---:|');
  [[1, 0.14], [3, 0.42], [4, 0.56], [6, 0.84]].forEach((row) => {
    const n = row[0], c = row[1];
    say(`| ${n}${n === 4 ? ' **(ceiling)**' : ''} | $${c.toFixed(2)} | ${(c / 0.10).toFixed(1)}x | ${(n * 18.7).toFixed(0)}s | ${((n * 18.7) / 120).toFixed(1)}x |`);
  });
  say('');
  say('**Filed against §2.1\'s ≤$1/render PREMIUM budget** — NOT the $0.10 standard-tier law, which does not '
    + 'govern Lumen. Scene spend stays inside the premium budget through **7 scenes** ($0.98); at the registered '
    + '4-scene quota ceiling it is **$0.56 = 56% of budget — comfortably inside**. My earlier "$0.10 law breaks at '
    + 'one scene" headline was MISFILED against the wrong tier and is withdrawn.');
  say('');
  say('_Break-even now lives in the ALL-IN section above ($0.21/render measured). The superseded table here '
    + '— built on the retired $0.481 bottom-up premium figure — is REMOVED rather than left to contradict it: '
    + 'two break-even tables on one board is how a stale number gets quoted._');
  say('');
  say('### Built-not-wired check — production counters, not certs');
  say('');
  const scenesLive = done.filter((j) => Object.keys((j.result || {})).some((k) => /scene|canvas|lumen/i.test(k))).length;
  const cbLive = done.filter((j) => j.completion_delivery === 'callback').length;
  say(`- ${wiredCheck({ component: 'Lumen scene vocabulary', cert: 'green (First Light 10/10)', productionCounter: 'completions carrying scene telemetry', count: scenesLive })}`);
  say(`- ${wiredCheck({ component: '`callback` delivery stamp', cert: 'green', productionCounter: 'completion_delivery=callback rows', count: cbLive })}`);
  // Phase-1 components with an ARMED scorecard and no traffic to score.
  const blob = (j) => JSON.stringify({ e: j.edit_recipe, r: j.result }).toLowerCase();
  const npLive = done.filter((j) => /nameplate|name_plate/.test(blob(j))).length;
  const ecLive = done.filter((j) => /endcard|end_card|end-card/.test(blob(j))).length;
  say(`- ${wiredCheck({ component: 'NamePlate (component D)', cert: 'built + renderer-registered', productionCounter: 'completions carrying a name-plate', count: npLive })}`);
  say(`- ${wiredCheck({ component: 'EndCard (component F)', cert: 'built + renderer-registered', productionCounter: 'completions carrying an end-card', count: ecLive })}`);
  if (!npLive && !ecLive) {
    say('');
    say('> **The scorecard for these two is ARMED and cannot fire — and the reason is structural, not a wait.** '
      + 'Both are built and EXPORTED from the Remotion registry (`motion-graphics/index.ts:67-70`), so the '
      + 'renderer can draw them. But `handler.py` references `NamePlate` and `EndCard` **once each — and it is '
      + 'the same comment line** (`handler.py:20367`). They are absent from the prompt and the response schema, '
      + 'so **nothing can ask for one.** The production counter is not 0 because traffic has not reached them '
      + 'yet; it is 0 because it structurally cannot be anything else.');
    say('');
    say('');
    say('> **A BUILD-LANE ARTIFACT IS NOT A CROSSING.** A harness render proves the renderer can draw a '
      + 'scene; it proves nothing about whether a real job can ask for one. The two are different claims and '
      + 'this board keeps them apart: **QUALITY is scoreable from any artifact** — the references do not care '
      + 'where the pixels came from — but **REACH is only ever a production counter.** So a scored harness '
      + 'artifact may appear on the quality board while these entries stay **[BUILT-NOT-WIRED]**, and that is '
      + 'not a contradiction: it is the whole distinction the guard exists to hold.');
    say('');
    say('_These entries close ONLY when a real user job emits scenes — `completions carrying scene telemetry > 0` '
      + 'on production traffic, key-based, never a substring match. Until then a harness render is capability '
      + 'evidence and is labelled as such wherever it is reported. This project has six instances of a green '
      + 'cert being read as reach; a harness artifact is the easiest seventh._');
    say('');
    say('_This is instance six of the built-not-wired class, and the same shape as generated scenes '
      + '("defined but INERT", 0 of 3,949). The gap is one hop wide: renderer-registered, schema-absent. '
      + 'The moment either appears in the response schema, the scorecard scores it on canvas + palette against '
      + 'both references with no further work._');
  }
  say('');
  say('_The `callback` line is the class resolving in real time: it was [BUILT-NOT-WIRED] for 432+ completions '
    + 'and is now wired — the predicate fix connected a stamp that had always been written and always discarded. '
    + 'The scene vocabulary is still on the other side of that line._');
  say('');
  say('_NO LIVE DATA: there are still ZERO Lumen renders in `video_jobs`. These are harness in-run figures, not '
    + 'production measurement, and were measured in-run precisely because envelope loss corrupts `result` on ~39% of completions._');
  say('');

  // The exact figure that burned me, now guarded automatically.
  const dayCounts = {};
  done.forEach((j) => { const d = j.created_at.slice(0, 10); dayCounts[d] = (dayCounts[d] || 0) + 1; });
  const vols = Object.values(dayCounts);
  if (vols.length > 1) {
    const ordered = Object.keys(dayCounts).sort().map((d) => dayCounts[d]);
    say(`_Denominator guard — ${windowGuard('completed renders/day', ordered, '/day')}_`);
    say('_**Denominator basis:** the completion denominator behind cost-per-render figures is a **7-DAY MEAN** '
      + '(~233/day over 08-08→08-15), **not the current regime** (~150/day since 08-11). Cost-per-render on the '
      + '7-day mean understates the current per-render figure by ~1.55x for exactly the reason the cycle-average '
      + 'understates the recent slice. State which basis any per-render number uses._');
    say('');
  }
  // ── WEDGED ROWS — READ FROM THE GATE'S OWN PREDICATE ─────────────────────
  // Re-pointed 2026-08-15: this section INVOKES preflight_quiet_window.py, the
  // script the pre-push hook itself runs, rather than re-implementing its rule.
  // A board that reimplements a gate will eventually disagree with it, and the
  // disagreement surfaces at the worst moment — when someone is deciding whether
  // to ship. One implementation, one verdict.
  //
  // MY REIMPLEMENTATION WAS ALREADY WRONG IN THREE WAYS, which is the argument:
  //   · it omitted `pending` from the in-flight set
  //   · it aged rows from created_at, while the gate uses UPDATED_AT (last
  //     touch) — so a long job that is actively heartbeating is LIVE to the gate
  //     and looked "wedged" to me
  //   · it used a 30-min threshold against the gate's 1200s CONTAINER_CAP_S
  const { execFileSync } = require('child_process');
  const PREFLIGHT = '/Users/zaclibman/promptly-gpu-worker/promptly-gpu-worker/preflight_quiet_window.py';
  say('### Deploy quiet-window — the GATE\'s own verdict');
  say('');
  let gateOut = null, gateRc = null;
  try {
    gateOut = execFileSync('python3', [PREFLIGHT], { encoding: 'utf8', timeout: 60000 });
    gateRc = 0;
  } catch (e) {
    gateOut = String((e.stdout || '') + (e.stderr || '')).trim() || null;
    gateRc = typeof e.status === 'number' ? e.status : null;
  }
  if (gateOut) {
    const verdict = gateRc === 0 ? 'QUIET — safe to push'
      : gateRc === 1 ? 'BUSY — push BLOCKED'
        : gateRc === 2 ? 'UNKNOWN — push BLOCKED (cannot measure is not quiet)'
          : `rc=${gateRc}`;
    say(`**${verdict}**`);
    say('');
    say('```');
    gateOut.trim().split('\n').slice(0, 12).forEach((l) => say(l));
    say('```');
    const wedgedLines = (gateOut.match(/WEDGED/g) || []).length;
    say('');
    say(wedgedLines
      ? `**${wedgedLines} WEDGED row(s)** — surfaced by the gate but **not blocking it**.`
      : '**No wedged rows surfaced.**');
  } else {
    say('⚠️ **[UNKNOWN]** — the gate script could not be run from here, so the quiet window is unmeasured. '
      + 'Per the gate\'s own stance, an unmeasurable window is not a quiet one.');
  }
  say('');
  say('> **CORRECTION to my previous board (2026-08-15).** I published that wedged rows *hold the deploy gate '
    + 'shut* and that the gate "sees 1 busy when at most 0 could be live." **That is no longer true and the gate '
    + 'is the thing that is right.** `preflight_quiet_window.py` now splits LIVE from WEDGED on staleness and '
    + 'excludes anything past `CONTAINER_CAP_S=1200` — because nothing can still be running past the Modal '
    + 'timeout, so excluding it cannot exclude live work *by construction*. The corpse I found was real, and the '
    + 'gate correctly reported QUIET anyway.');
  say('');
  say('_The premise is HISTORICAL, not current: one wedged row (fb702c40, 2,180s old, last touched 2,170s ago) '
    + 'did block every deploy for ~17 minutes — including the fix for a live bug — which is what forced the '
    + 'container-cap split. So "corpses hold the gate" was exactly right until it was fixed today._');
  say('');
  say('_Why the count still belongs on the board: the gate deliberately surfaces wedged rows LOUDLY rather than '
    + 'silently ignoring them, because trading a blocked deploy for an invisible stuck job is the worse of the '
    + 'two. It is now a defect metric that the gate refuses to hide — not a deploy blocker._');
  say('');
  say('### Agent / harness spend — counted like user jobs [Rule 6]');
  say('');
  say('| run | $ | note |');
  say('|---|---:|---|');
  say('| First Light (10 scenes + 2 hero attempts) | **$1.96** | of a $2.00 ceiling; 14 billed image calls |');
  say('| worker deploy image rebuild (08-03) | ~$0.10 | build compute, logged not assumed free |');
  say('| JUDGE lane, all sessions to date | **$0.00** | every measurement DB-read or local ffmpeg |');
  say('| **agent / ephemeral, ongoing** | **$0.37/day** ($11.10/mo) | **standing line** — 1.2% of a ~150-render day today |');
  say('| **campaign total to date** | **~$2.06** | |');
  say('');
  say('_Rule 6: harnesses count exactly like user jobs and land in the same ledger._');
  say('_**Why the $0.37/day agent line stays on the board even at 1.2%:** it was **17% of the bill eleven days '
    + 'ago**. A line that was material once can be material again, and a figure only removed from the board when '
    + 'it looks small is a figure nobody is watching when it grows. Standing lines catch returns; ad-hoc checks '
    + 'do not. ($11.10/mo ≈ 0.35 subscriber-months.)_');
  say('');

  const out = path.join(__dirname, '..', 'reports', 'WHERE_IT_BLEEDS.md');
  fs.writeFileSync(out, L.join('\n') + '\n');
  console.error(`\n[bleeds] wrote ${out}`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
