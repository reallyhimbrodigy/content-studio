'use strict';
// Gate for "a failed job can never cost credits" (Zac 2026-09-24).
//
// Frontend has a "charge stands" failure state. refund-leg already sweeps
// failed jobs every 60s and that sweep works — what it cannot close is the
// WINDOW, because the row is marked `failed` first and refunded up to a minute
// later. The user is looking at the screen during exactly that minute.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const strip = require('./__gate_strip').stripComments;
const { failWithRefund, owedRefund, STATES } = require('./fail-with-refund');

const quiet = { error() {}, warn() {}, log() {} };
const NOW = () => new Date('2026-09-24T07:00:00Z');

function rig({ refundThrows = false, terminalizeThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    opts: {
      log: quiet, now: NOW,
      refund: async (amount) => {
        calls.push(['refund', amount]);
        if (refundThrows) throw new Error('RC 503');
      },
      terminalize: async (patch) => {
        calls.push(['terminalize', JSON.stringify(patch)]);
        if (terminalizeThrows) throw new Error('write failed');
        return { outcome: 'failed' };
      },
      alert: async (t) => { calls.push(['alert', t]); },
    },
  };
}

(async () => {
  // ── L1: FAILURE -> REFUNDED, ATOMICALLY. The refund happens BEFORE the
  // terminal write, and credits_refunded_at rides in the SAME patch.
  {
    const r = rig();
    const out = await failWithRefund({ id: 'j1', credits_debited: 10 }, r.opts);
    assert.strictEqual(out.state, 'REFUNDED_AND_FAILED', 'L1: both facts land');
    assert.strictEqual(out.marked, true);
    const order = r.calls.map((c) => c[0]);
    assert.deepStrictEqual(order, ['refund', 'terminalize'],
      'L1: the credits go back BEFORE the row is marked — the other order IS the window');
    const patch = JSON.parse(r.calls[1][1]);
    assert.ok(patch.credits_refunded_at,
      'L1: credits_refunded_at must be in the SAME write as status=failed — two '
      + 'writes is the minute the client can read a failure with the charge standing');
  }

  // ── L2: A REFUND ERROR DOES NOT MARK THE JOB FAILED. This is the rollback:
  // if the money did not come back, the client cannot see `failed` at all.
  {
    const r = rig({ refundThrows: true });
    const out = await failWithRefund({ id: 'j2', credits_debited: 10 }, r.opts);
    assert.strictEqual(out.state, 'REFUND_FAILED', 'L2: named, not a boolean');
    assert.strictEqual(out.marked, false, 'L2: and the row is NOT marked failed');
    assert.ok(!r.calls.some((c) => c[0] === 'terminalize'),
      'L2: terminalize must never run after a failed refund — marking it and '
      + 'hoping the sweep catches up IS the silent charge');
    assert.ok(r.calls.some((c) => c[0] === 'alert'), 'L2: and it alerts');
  }

  // ── L3: NEVER A SILENT CHARGE. Across every failure mode, there is no path
  // that marks the row failed while the credits are still ours.
  for (const mode of [{ refundThrows: true }, { terminalizeThrows: true }]) {
    const r = rig(mode);
    const out = await failWithRefund({ id: 'j3', credits_debited: 10 }, r.opts);
    const markedButUnrefunded = out.marked === true
      && !r.calls.some((c) => c[0] === 'refund' && !mode.refundThrows);
    assert.ok(!markedButUnrefunded,
      `L3: ${JSON.stringify(mode)} must never leave the row failed with the charge kept`);
    assert.ok(r.calls.some((c) => c[0] === 'alert'),
      `L3: ${JSON.stringify(mode)} must alert — a quiet one is the silent charge`);
  }

  // ── L4: REFUNDED-BUT-NOT-TERMINALIZED IS ITS OWN STATE. The money is back
  // and the row is stale. Safe (nobody is out of pocket) but a defect, and a
  // defect that reports success is the class this repo keeps paying for.
  {
    const r = rig({ terminalizeThrows: true });
    const out = await failWithRefund({ id: 'j4', credits_debited: 10 }, r.opts);
    assert.strictEqual(out.state, 'TERMINALIZE_FAILED',
      'L4: money back, row stale — its own state, not a success');
    assert.strictEqual(out.marked, false, 'L4: and it does not claim to be marked');
    assert.ok(r.calls.some((c) => c[0] === 'refund'), 'L4: the refund did happen');
  }

  // ── L5: A NULL DEBIT IS NOT A ZERO DEBIT. Refunding a job that never paid
  // credits users who were never charged — and the dark-answer receipt is
  // exactly a NULL credits_debited.
  for (const j of [{ id: 'a' }, { id: 'b', credits_debited: null },
    { id: 'c', credits_debited: 0 }]) {
    const r = rig();
    const out = await failWithRefund(j, r.opts);
    assert.strictEqual(out.state, 'NOTHING_TO_REFUND', `L5: ${JSON.stringify(j)}`);
    assert.ok(!r.calls.some((c) => c[0] === 'refund'),
      'L5: and no refund call is made');
    assert.strictEqual(out.marked, true, 'L5: but the row still terminalizes');
    const patch = JSON.parse(r.calls[0][1]);
    assert.ok(!('credits_refunded_at' in patch),
      'L5: and it does NOT claim a refund that never happened');
  }

  // ── L6: IDEMPOTENT. A second pass over an already-refunded job must not
  // refund twice — one job, one refund.
  {
    const r = rig();
    const out = await failWithRefund(
      { id: 'j6', credits_debited: 10, credits_refunded_at: '2026-09-24T06:00:00Z' }, r.opts);
    assert.strictEqual(out.state, 'ALREADY_REFUNDED',
      'L6: a job already carrying credits_refunded_at must not be refunded again');
    assert.ok(!r.calls.some((c) => c[0] === 'refund'), 'L6: no second refund');
    assert.strictEqual(out.marked, true, 'L6: and the row still terminalizes');
  }

  // ── L7: AN ALERT THAT THROWS NEVER BREAKS A REFUND. The alert path is the
  // least reliable thing here and it must not be able to take the fix down.
  {
    const r = rig({ refundThrows: true });
    r.opts.alert = async () => { throw new Error('ops-alert down'); };
    let out;
    try {
      out = await failWithRefund({ id: 'j7', credits_debited: 10 }, r.opts);
    } catch (e) {
      assert.fail(`L7: a throwing alert escaped (${e && e.message}). The alert path `
        + 'is the least reliable thing here and must not be able to take the fix down.');
    }
    assert.strictEqual(out.state, 'REFUND_FAILED', 'L7: the state still comes back');
  }

  // ── L8: THE STATE THAT MUST NOT EXIST HAS A NAME. MARKED_WITHOUT_REFUND is
  // deliberately absent from STATES — naming it is how the absence is
  // assertable rather than merely believed.
  assert.ok(!STATES.includes('MARKED_WITHOUT_REFUND'),
    'L8: no state may describe a row marked failed with the charge kept');
  assert.deepStrictEqual([...STATES].sort(),
    ['ALREADY_REFUNDED', 'NOTHING_TO_REFUND', 'REFUNDED_AND_FAILED',
      'REFUND_FAILED', 'TERMINALIZE_FAILED'].sort(),
    'L8: and the state set is exhaustive');

  // ── L9: WIRED INTO THE ONE WRITE POINT. A correct module nothing calls is
  // the inert-instrument shape — the guard, the metering column and the
  // scoreboard have each been that here.
  const d = strip(fs.readFileSync(
    path.join(__dirname, 'video-processor', 'dispatch-to-modal.js'), 'utf8'));
  assert.ok(/failWithRefund\(/.test(d),
    'L9: markJobFailed must route through failWithRefund');
  const mjf = d.slice(d.indexOf('async function markJobFailed'));
  assert.ok(/if \(!_fw\.marked\)/.test(mjf),
    'L9: and it must RETURN without the funnel event and SSE push when the row '
    + 'was not marked — telling the client "failed" is the one thing we must not '
    + 'do while the charge stands');
  const held = mjf.indexOf('_fw.marked');
  const sse = mjf.indexOf('pushProgressToSSE(jobId');
  assert.ok(held > 0 && sse > held,
    'L9: the hold must come BEFORE the SSE push, not after it');

  console.log('[smoke] fail with refund: ALL PASS (refund precedes the terminal write and '
    + 'credits_refunded_at rides in the same patch, a refund error never marks the row, '
    + 'no path leaves failed-with-charge-kept, refunded-but-stale is its own state, a NULL '
    + 'debit is not a zero debit, idempotent, a throwing alert cannot break it, and it is '
    + 'wired ahead of the SSE push)');
  process.exit(0);
})().catch((e) => {
  console.error('fail-with-refund smoke FAILED:', e && e.message);
  process.exit(1);
});
