#!/usr/bin/env node
// A MODEL CALL THAT FEEDS A VERDICT RUNS AT TEMPERATURE 0 (Zac, 2026-09-20).
//
// WHY IT IS A RULE. temperature was never set in either classifier, so both ran
// at the default 1.0 and the SAME BRIEF returned unsafe true,true,false,false,
// true across five runs. Every number quoted off that path — 99 dark decisions,
// a hand-checked false-positive rate, a flip gate set at 5% — was one sample of
// a distribution rather than a measurement. The classifier's own run-to-run
// variance was LARGER THAN THE BAR it was being judged against.
//
// The tell is the expensive part: a fixture that passes, then fails, then
// passes with no edit in between reads as flakiness in the HARNESS, so it gets
// re-run rather than investigated.
//
// TWO LEGS, because they fail differently:
//   STATIC  every verdict-producing model call carries temperature: 0. Free,
//           offline, deterministic — this is the one that belongs in a gate.
//   LIVE    the same brief eight times gives eight identical verdicts. Costs a
//           few cents and needs a key; this is the one that proves the static
//           leg is checking the right thing.
//
// Usage: node scripts/fulfilment/smoke_verdict_determinism.js [--live]
const fs = require('fs');
const path = require('path');

// The files whose model calls decide a VERDICT. A call that generates content
// is not in scope; a call that returns a judgement is.
const VERDICT_CALLERS = [
  'lib/negotiation-classifier.js',
  'scripts/fulfilment/classify.js',
  'scripts/fulfilment/readjudicate.js',
  'scripts/fulfilment/fulfilment_judge_v2.js',
];

/** Every anthropic messages call in a file, with whether it pins temperature. */
function callSites(src) {
  const out = [];
  // A call site is a `model:` key; the body runs to the matching max_tokens or
  // the end of the object literal. Anchoring on `model:` rather than on the URL
  // catches a call built in a helper.
  const rx = /model:\s*[^,\n]+,([^]{0,400}?)(?:messages:|tools:|system:)/g;
  let m;
  while ((m = rx.exec(src))) {
    out.push({ at: src.slice(0, m.index).split('\n').length, pinned: /temperature:\s*0\b/.test(m[0]) });
  }
  return out;
}

function staticLeg() {
  const rows = [];
  for (const f of VERDICT_CALLERS) {
    const p = path.join(__dirname, '..', '..', f);
    if (!fs.existsSync(p)) { rows.push({ f, state: 'ABSENT' }); continue; }
    const sites = callSites(fs.readFileSync(p, 'utf8'));
    for (const s of sites) rows.push({ f, at: s.at, state: s.pinned ? 'PINNED' : 'DEFAULT' });
  }
  return rows;
}

(async () => {
  const rows = staticLeg();
  const sites = rows.filter(r => r.state !== 'ABSENT');
  console.log('STATIC — every verdict-producing model call pins temperature 0\n');
  for (const r of rows) {
    if (r.state === 'ABSENT') { console.log(`  [  -  ] ${r.f} (not present)`); continue; }
    console.log(`  [${r.state === 'PINNED' ? 'ok  ' : 'FAIL'}] ${r.f}:${r.at} ${r.state}`);
  }
  // A GATE OVER AN EMPTY POPULATION ASSERTS NOTHING.
  if (!sites.length) { console.log('\nHARNESS FAILURE: no model call sites found — this asserted nothing'); process.exit(2); }
  const unpinned = sites.filter(r => r.state === 'DEFAULT');
  console.log(`\n  ${sites.length} call site(s), ${sites.length - unpinned.length} pinned, ${unpinned.length} at the default`);

  if (process.argv.includes('--live')) {
    const ENV = require('./env.js')();
    process.env.ANTHROPIC_API_KEY = ENV.ANTHROPIC_API_KEY || ENV.CLAUDE_API_KEY;
    const U = ENV.SUPABASE_URL, K = ENV.SUPABASE_SERVICE_ROLE_KEY;
    // A CRASH IS NOT A MEASUREMENT. Without credentials this leg cannot fetch a
    // brief at all, and an unhandled ERR_INVALID_URL reads as a broken harness
    // rather than as "could not measure" — the runner's failure reported through
    // the same channel as the check's result.
    if (!U || !K) { console.log('\nHARNESS FAILURE: no Supabase credentials — the live leg cannot fetch a brief'); process.exit(2); }
    const H = { apikey: K, Authorization: `Bearer ${K}` };
    const { adjudicateRequest } = require(process.env.NEGOTIATION_MODULE || '../../lib/negotiation-classifier.js');
    // THE TWO BRIEFS MEASURED MOST UNSTABLE AT THE DEFAULT. Using a STABLE
    // brief here would make the live leg pass under the mutation and prove
    // nothing — the leg has to be aimed where the variance actually was.
    // EACH BRIEF CARRIES ITS EXPECTED VERDICT, so "stable and WRONG" fails.
    const BRIEFS = [['self-waist', '365e010211', false], ['self-curvy', '663f0c93e6', false],
                    ['other-face', 'fd96d66dd9', true]];
    const N = 8;
    console.log(`\nLIVE — ${N} runs per brief, verdicts must be identical\n`);
    let bad = 0;
    // N IDENTICAL VERDICTS IS NOT A SUFFICIENT ASSERTION ON ITS OWN (FRONTEND,
    // 2026-09-20, who walked into this and said so). Every early return in
    // adjudicateRequest is DETERMINISTIC BY CONSTRUCTION: no key, an empty
    // brief, a transport failure and an exhausted retry all return the same
    // thing every time. With no key this leg would have seen unsafe=null eight
    // times, called it identical, and printed PASS on a path THAT NEVER REACHED
    // THE MODEL. "Deterministic" and "never ran" read exactly alike — the same
    // shape as absent-because-fine versus absent-because-nobody-shipped-it.
    //
    // So there are three assertions, not one:
    //   REACHED   every run came back state=MEASURED with a BOOLEAN verdict
    //   IDENTICAL the eight verdicts agree
    //   CORRECT   they agree on the RIGHT answer, so stable-and-wrong fails
    for (const [name, h, want] of BRIEFS) {
      const d = await (await fetch(`${U}/rest/v1/negotiation_decisions?select=client_job_id&request_hash=like.${h}*&limit=1`, { headers: H })).json();
      const j = await (await fetch(`${U}/rest/v1/video_jobs?select=vibe_input&id=eq.${d[0].client_job_id}&limit=1`, { headers: H })).json();
      const runs = [];
      for (let i = 0; i < N; i++) runs.push(await adjudicateRequest(j[0].vibe_input, {}));
      const unreached = runs.filter(r => r.state !== 'MEASURED' || typeof r.unsafe !== 'boolean');
      const o = runs.map(r => r.unsafe);
      if (unreached.length) {
        bad++;
        console.log(`  [CANNOT MEASURE] ${name.padEnd(12)} ${unreached.length}/${N} run(s) never reached the model `
          + `(${unreached[0].state}${unreached[0].why ? ': ' + unreached[0].why : ''}). `
          + `Identical verdicts here would mean NOTHING.`);
        continue;
      }
      const same = new Set(o).size === 1;
      const right = same && o[0] === want;
      if (!right) bad++;
      console.log(`  [${right ? 'ok  ' : 'FAIL'}] ${name.padEnd(12)} ${JSON.stringify(o)}`
        + (same ? '' : '  NOT IDENTICAL') + (same && o[0] !== want ? `  STABLE BUT WRONG (wanted ${want})` : ''));
    }
    console.log(`\n  ${BRIEFS.length} brief(s), ${BRIEFS.length - bad} deterministic, ${bad} not`);
    process.exit(unpinned.length || bad ? 1 : 0);
  }
  process.exit(unpinned.length ? 1 : 0);
})();
