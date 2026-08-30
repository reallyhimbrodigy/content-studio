'use strict';
// step-dropoff.js — the ordered funnel, per-step, keyed on install_id.
// Companion to joined-read.js: that one measures wall-view → money, this one
// measures how far into the flow an install actually gets.
//
// ── TWO THINGS DISCOVERY CHANGED, both load-bearing ──────────────────────────
//
// 1. THE VIDEO-TYPE STEP HAS TWO SPELLINGS. `onboarding_v2_step` emits both
//    `videoType` (67 events) and `video_type` (40), from the SAME builds, for
//    the same beat. Keying on either alone splits one step into two and invents
//    a drop-off that is pure naming. They are merged here. This is a client bug
//    worth fixing at the emitter, but the read must not lie in the meantime.
//
// 2. SKIP IS A SEPARATE STEP VALUE, NOT A FLAG. The skip of a question arrives
//    as its own step (`audience_skip`, `video_type_skip`) rather than a
//    `skipped: true` prop, and those values appear ONLY on 1.3.19 (237) —
//    skip instrumentation landed in that build. So skip-vs-answer is only
//    measurable on 237+, and any earlier build shows 0 skips because it could
//    not report them, NOT because nobody skipped. The report says so rather
//    than printing a flattering zero.
//
//    There is NO `attribution_skip` in any build. Q3's skip is unmeasurable.
//
// ── WHAT CANNOT BE CUT ───────────────────────────────────────────────────────
// LANGUAGE. There is no language or locale field on any event in the entire
// table — `language_selected` has 0 rows and no prop key matches /lang|locale/.
// The app's UI language is therefore NOT recoverable from analytics today. The
// language cut is reported as UNINSTRUMENTED rather than approximated from
// territory, which would be a different variable wearing its name.
//
// ── ABANDONMENT ──────────────────────────────────────────────────────────────
// Absence IS the signal. An install whose last funnel event is step N dropped
// AT step N. Incomplete journeys are never excluded — excluding them is what
// makes drop-off vanish and every step look like it converts.
const fs = require('fs');

const ENV = process.env.PROMPTLY_ENV_FILE || '/Users/zaclibman/content-studio/.env.local';
for (const l of fs.readFileSync(ENV, 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: key, Authorization: `Bearer ${key}` };

async function all(event, since) {
  let out = [], from = 0;
  for (;;) {
    const r = await fetch(
      `${url}/rest/v1/analytics_events?select=created_at,user_id,territory,app_version,props&event=eq.${event}&created_at=gte.${since}&limit=1000&offset=${from}`,
      { headers: H });
    if (!r.ok) { console.error(`READ FAILED ${r.status} on ${event} — not a zero.`); process.exit(1); }
    const j = await r.json();
    if (!j.length) break;
    out.push(...j); from += j.length;
    if (j.length < 1000) break;
  }
  return out;
}

// Ordered funnel. `match` maps an event row to this step, or null.
const STEPS = [
  { key: 'session_started',    ev: 'session_started' },
  { key: 'onboarding:start',   ev: 'onboarding_v2_step', step: ['start'] },
  { key: 'Q1 audience',        ev: 'onboarding_v2_step', step: ['audience', 'audience_skip'],
    answer: ['audience'], skip: ['audience_skip'] },
  { key: 'Q2 video_type',      ev: 'onboarding_v2_step', step: ['videoType', 'video_type', 'video_type_skip'],
    answer: ['videoType', 'video_type'], skip: ['video_type_skip'] },
  { key: 'Q3 attribution',     ev: 'onboarding_v2_step', step: ['attribution'],
    answer: ['attribution'], skip: [] },            // no attribution_skip exists in any build
  { key: 'reveal',             ev: 'onboarding_v2_step', step: ['reveal'] },
  { key: 'offer_reveal_viewed', ev: 'offer_reveal_viewed' },
  { key: 'plan_selected',      ev: 'plan_selected' },
  { key: 'purchase_started',   ev: 'purchase_started' },
  { key: 'purchase_completed', ev: 'purchase_completed' },
];
const TAIL = [
  { key: 'picker_opened', ev: 'picker_opened' },
  { key: 'picker_result', ev: 'picker_result' },
];

const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const idOf = (r) => (r.props && r.props.install_id) || r.user_id || null;

function report(title, steps, journeys) {
  console.log(`\n── ${title} ──`);
  console.log('  step                    entered   exited  drop-off   median-on-step   notes');
  let prev = null;
  for (const s of steps) {
    const ent = journeys.filter((j) => j.at[s.key] !== undefined);
    const entered = ent.length;
    // exited = reached ANY later step; the rest abandoned here.
    const later = steps.slice(steps.indexOf(s) + 1).map((x) => x.key);
    const exited = ent.filter((j) => later.some((k) => j.at[k] !== undefined)).length;
    const drop = entered ? (100 * (entered - exited) / entered) : 0;
    // median time from entering this step to entering the next reached step
    const times = [];
    for (const j of ent) {
      const t0 = j.at[s.key];
      const nxt = later.map((k) => j.at[k]).filter((t) => t !== undefined && t > t0).sort((a, b) => a - b)[0];
      if (nxt !== undefined) times.push((nxt - t0) / 1000);
    }
    const m = med(times);
    // ORPHANS: installs at this step that never hit the PREVIOUS step. A step
    // with orphans is not strictly downstream — plan_selected fires on the
    // standalone paywall as well as after the reveal, so treating it as a link
    // in one chain produces a drop-off percentage that describes nothing. Shown
    // rather than smoothed away.
    const orphan = prev ? ent.filter((j) => j.at[prev.key] === undefined).length : 0;
    console.log(`  ${s.key.padEnd(22)} ${String(entered).padStart(7)} ${String(exited).padStart(8)}` +
      `  ${drop.toFixed(1).padStart(6)}%   ${m === null ? '     —' : (m.toFixed(1) + 's').padStart(9)}` +
      `   ${orphan ? 'ORPHANS ' + orphan + ' (arrived without ' + prev.key + ')' : ''}`);
    prev = s;
  }
}

function skipReport(steps, journeys, label) {
  console.log(`\n── SKIP vs ANSWER per question ${label} ──`);
  for (const s of steps) {
    if (!s.answer) continue;
    const a = journeys.filter((j) => j.kinds[s.key] && j.kinds[s.key].answered).length;
    const k = journeys.filter((j) => j.kinds[s.key] && j.kinds[s.key].skipped).length;
    const tot = a + k;
    if (!s.skip.length) { console.log(`  ${s.key.padEnd(22)} answered ${String(a).padStart(5)}   skip NOT INSTRUMENTED (no *_skip step value exists)`); continue; }
    console.log(`  ${s.key.padEnd(22)} answered ${String(a).padStart(5)}   skipped ${String(k).padStart(5)}` +
      `   skip-rate ${tot ? (100 * k / tot).toFixed(1) + '%' : '—'}`);
  }
  console.log('  NOTE: *_skip step values are emitted ONLY by 1.3.19 (237) and later.');
  console.log('        Earlier builds report 0 skips because they cannot report one, not because none happened.');
}

(async () => {
  const SINCE = process.argv[2] || '2026-08-20T00:00:00Z';
  console.log(`step-dropoff — since ${SINCE}, keyed on install_id, absence = abandonment`);

  const evNames = [...new Set([...STEPS, ...TAIL].map((s) => s.ev))];
  const raw = {};
  for (const e of evNames) raw[e] = await all(e, SINCE);

  // Build one journey per install: earliest timestamp at each step.
  const J = new Map();
  const touch = (id) => { if (!J.has(id)) J.set(id, { at: {}, kinds: {}, build: null, terr: null }); return J.get(id); };
  for (const s of [...STEPS, ...TAIL]) {
    for (const r of raw[s.ev] || []) {
      if (s.step) {
        const v = (r.props || {}).step;
        if (!s.step.includes(v)) continue;
      }
      const id = idOf(r); if (!id) continue;
      const j = touch(id);
      const t = Date.parse(r.created_at);
      if (j.at[s.key] === undefined || t < j.at[s.key]) j.at[s.key] = t;
      if (!j.build) j.build = r.app_version;
      if (!j.terr) j.terr = r.territory;
      if (s.answer) {
        const v = (r.props || {}).step;
        j.kinds[s.key] = j.kinds[s.key] || { answered: false, skipped: false };
        if (s.answer.includes(v)) j.kinds[s.key].answered = true;
        if (s.skip.includes(v)) j.kinds[s.key].skipped = true;
      }
    }
  }
  const journeys = [...J.values()];
  console.log(`distinct installs seen: ${journeys.length}`);

  report('FULL FUNNEL (all builds)', STEPS, journeys);
  report('ACTIVATION TAIL', TAIL, journeys);
  skipReport(STEPS, journeys, '(all builds)');

  // ── Cuts ────────────────────────────────────────────────────────────────────
  const cut = (name, keyFn, min) => {
    const g = new Map();
    for (const j of journeys) { const k = keyFn(j) || 'unknown'; if (!g.has(k)) g.set(k, []); g.get(k).push(j); }
    console.log(`\n══ BY ${name} ══`);
    for (const [k, arr] of [...g].sort((a, b) => b[1].length - a[1].length)) {
      if (arr.length < min) continue;
      const start = arr.filter((j) => j.at['onboarding:start'] !== undefined).length;
      const rev = arr.filter((j) => j.at['reveal'] !== undefined).length;
      const buy = arr.filter((j) => j.at['purchase_completed'] !== undefined).length;
      console.log(`  ${String(k).padEnd(16)} installs ${String(arr.length).padStart(5)}  start ${String(start).padStart(4)}` +
        `  reveal ${String(rev).padStart(4)}  buys ${String(buy).padStart(3)}` +
        `  start→reveal ${start ? (100 * rev / start).toFixed(1) + '%' : '—'}`);
    }
  };
  cut('BUILD', (j) => j.build, 5);
  cut('TERRITORY', (j) => j.terr, 5);
  console.log('\n══ BY LANGUAGE ══');
  console.log('  UNINSTRUMENTED — no language/locale field exists on any analytics event.');
  console.log('  language_selected has 0 rows; no prop key matches /lang|locale/.');
  console.log('  Fix at the emitter (add AppLanguage.current to session_started) before this cut can exist.');
  console.log('  Territory is NOT a substitute — it is a different variable wearing this one\'s name.');

  // Per-build skip, since skip only exists on 237+
  const b237 = journeys.filter((j) => /\(23[7-9]\)/.test(String(j.build)));
  if (b237.length) skipReport(STEPS, b237, `(builds 237+ only, n=${b237.length})`);
})();
