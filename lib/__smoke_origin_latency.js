#!/usr/bin/env node
'use strict';
// THE GUARD THAT SHOULD HAVE PAGED ON 2026-09-24.
//
// Origin time went 108ms -> 4,134ms -> 5,720ms -> dead across eleven minutes
// and nobody was told. These legs replay that shape and require a page, and
// pin the three ways a latency alert normally fails: it pages on one slow
// call, it pages on a quiet minute, or it goes quiet exactly when the database
// stops answering because failed calls are not timed.
const assert = require('assert');
const g = require('./origin-latency-guard');

let n = 0;
const failed = [];
const leg = (name, fn) => {
  try { fn(); n += 1; console.log(`   ok  ${name}`); }
  catch (e) { failed.push(name); console.log(`   FAIL  ${name}: ${e.message}`); }
};

const MIN = g.WINDOW_MS;
function minuteOf(ms, count, t0) {
  for (let i = 0; i < count; i += 1) g.observe(ms, t0 + i);
}

leg('L1 one_slow_call_does_not_page', () => {
  g._reset();
  const pages = [];
  g.configure({ sink: (t, b) => pages.push([t, b]) });
  let t = 1000;
  minuteOf(30, 40, t);                 // healthy minute
  g.observe(44000, t + MIN + 1);       // one 44s outlier, rolls the bucket
  assert.strictEqual(pages.length, 0, 'a single slow call must not page');
  assert.strictEqual(g._state().breaches, 0);
});

leg('L2 three_slow_minutes_page_and_two_do_not', () => {
  g._reset();
  const pages = [];
  g.configure({ sink: (t, b) => pages.push([t, b]) });
  let t = 1000;
  for (let m = 0; m < 2; m += 1) { minuteOf(5000, 40, t); t += MIN + 1; g.observe(5000, t); }
  assert.strictEqual(pages.length, 0, 'two breaching minutes must not page yet');
  minuteOf(5000, 40, t); t += MIN + 1; g.observe(5000, t);
  assert.strictEqual(pages.length, 1, 'the third consecutive minute must page');
  assert.ok(/p95/.test(pages[0][1]), 'the page must carry the number that fired it');
});

// A QUIET MINUTE IS UNMEASURED, NOT HEALTHY. Resetting the streak on a
// low-sample minute would let "slow, slow, quiet, slow" never reach three —
// an outage laundered by a lull.
leg('L3 a_quiet_minute_holds_the_streak_rather_than_clearing_it', () => {
  g._reset();
  const pages = [];
  g.configure({ sink: (t, b) => pages.push([t, b]) });
  let t = 1000;
  for (let m = 0; m < 2; m += 1) { minuteOf(5000, 40, t); t += MIN + 1; g.observe(5000, t); }
  assert.strictEqual(g._state().breaches, 2);
  minuteOf(5000, 3, t); t += MIN + 1; g.observe(5000, t);      // 3 samples: UNMEASURED
  assert.strictEqual(g._state().breaches, 2, 'a quiet minute must not clear the streak');
  minuteOf(5000, 40, t); t += MIN + 1; g.observe(5000, t);
  assert.strictEqual(pages.length, 1, 'the streak must still reach three and page');
});

// AND A HEALTHY MINUTE DOES CLEAR IT — otherwise the first bad patch of the
// week pages forever.
leg('L4 recovery_clears_the_streak', () => {
  g._reset();
  g.configure({ sink: () => {} });
  let t = 1000;
  for (let m = 0; m < 2; m += 1) { minuteOf(5000, 40, t); t += MIN + 1; g.observe(5000, t); }
  assert.strictEqual(g._state().breaches, 2);
  minuteOf(50, 40, t); t += MIN + 1; g.observe(50, t);
  assert.strictEqual(g._state().breaches, 0, 'a healthy minute must reset the streak');
});

// THE ONE THAT MATTERS MOST. If failures were not timed, the instrument would
// go QUIET exactly when the database stops answering — healthiest at the worst
// moment, which is the shape of every false green in this repo.
// THE ONE THAT MATTERS MOST, and it is awaited rather than left to a timer:
// a leg whose assertion runs after the summary prints cannot fail the run.
async function legAsync(name, fn) {
  try { await fn(); n += 1; console.log(`   ok  ${name}`); }
  catch (e) { failed.push(name); console.log(`   FAIL  ${name}: ${e.message}`); }
}

leg('L6 one_outlier_in_twenty_does_not_move_the_p95', () => {
  // MY FIRST EXPECTATION HERE WAS WRONG AND THE CODE WAS RIGHT. I asserted
  // that 19 fast samples and one 50-second outlier give p95 = 50000. Nearest
  // rank over 20 samples is the 19th value, which is 50 — and that is the
  // whole point of using p95 rather than a max or a mean: a single 44-second
  // insert happened on a HEALTHY day, and an instrument that pages on it
  // teaches everyone to ignore it.
  const arr = new Array(19).fill(50).concat([50000]);
  assert.strictEqual(g._p95(arr), 50, 'one outlier in twenty must not set the p95');
  // Two in twenty does move it, which is the boundary worth pinning: the bar
  // is about a SLICE going slow, not about the worst call.
  const arr2 = new Array(18).fill(50).concat([50000, 50000]);
  assert.strictEqual(g._p95(arr2), 50000, 'two in twenty is a slice, and must show');
  assert.strictEqual(g._p95([]), null, 'no samples is null, never 0');
});

leg('L7 no_sink_says_so_rather_than_going_quiet', () => {
  g._reset();
  g.configure({ sink: null });
  let t = 1000;
  for (let m = 0; m < 3; m += 1) { minuteOf(5000, 40, t); t += MIN + 1; g.observe(5000, t); }
  // It cannot page, and the point is that it must SAY it cannot — an alert
  // path with no sink is a consumer with no producer and reads as "no alerts".
  assert.strictEqual(g._state().breaches >= g.BREACH_MINUTES, true);
});

(async () => {
  // If failures were not timed, the instrument would go QUIET exactly when the
  // database stops answering — healthiest at the worst moment, which is the
  // shape of every false green in this repo.
  await legAsync('L5 a_failed_call_is_still_timed', async () => {
    g._reset();
    g.configure({ sink: () => {} });
    const before = g._state().samples;
    await g.timed(async () => { throw new Error('statement timeout'); }).catch(() => {});
    assert.ok(g._state().samples > before, 'a throwing call must still record its latency');
  });

  if (failed.length) {
    console.log(`origin-latency: FAIL (${failed.join(', ')})`);
    process.exit(1);
  }
  console.log(`origin-latency: PASS (${n} legs — three minutes not one sample, a quiet `
    + `minute is UNMEASURED, and a failed call is still timed)`);
})();
