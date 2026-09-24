'use strict';
// A FAILED JOB CAN NEVER COST CREDITS, AND THE CLIENT MUST NEVER SEE IT DO SO.
//
// Zac 2026-09-24: "Frontend has a 'charge stands' failure state, which means a
// failed change can end with the credits kept. Make the refund commit in the
// same transaction that marks the re-edit failed, so the client never sees
// failed without refunded."
//
// ── WHAT WAS ALREADY TRUE, AND WHY IT IS NOT ENOUGH ──────────────────────
// lib/refund-leg.js sweeps failed jobs every 60 seconds and refunds them, and
// that sweep works. What it cannot close is the WINDOW: the row is marked
// `failed` first and refunded up to a minute later, so there is a minute in
// which the client reads a failure with the charge standing. A sweep is the
// right backstop and the wrong primary — the user is looking at the screen
// during exactly that minute.
//
// ── THE ORDER IS THE DESIGN ──────────────────────────────────────────────
//   1. return the credits (RevenueCat — external, cannot be in a transaction)
//   2. ONLY THEN mark failed, with credits_refunded_at in the SAME write
//
// One UPDATE touching both columns is atomic by definition — no stored
// procedure is needed for this, and adding one would be a migration standing
// between the fix and production for no gain. What matters is that the two
// facts move together, and a single statement is how you say that in SQL.
//
// ── A REFUND FAILURE DOES NOT MARK THE JOB FAILED ────────────────────────
// That is the "rollback" in practice: if the money did not come back, the
// terminal write never happens, so the client cannot see failed-without-
// refunded because it cannot see failed at all yet. The job stays non-terminal,
// the alert fires, and the refund-leg retries it. The alternative — mark it
// failed and hope the sweep catches up — is the silent charge.
//
// ── EVERY OUTCOME IS A NAMED STATE ───────────────────────────────────────
// Never a boolean. "It did not refund" is three different facts:
//   REFUNDED_AND_FAILED     money back, row terminal, one write
//   NOTHING_TO_REFUND       the job never carried a debit
//   ALREADY_REFUNDED        idempotent re-entry; the row still terminalizes
//   REFUND_FAILED           money NOT back; row NOT marked; alerted; retryable
//   MARKED_WITHOUT_REFUND   REFUSED — see below
//   TERMINALIZE_FAILED      money back but the row did not move; alerted LOUD
//
// MARKED_WITHOUT_REFUND is never returned by this module. It is named so the
// state that must not exist has a name to be asserted absent by.

const STATES = [
  'REFUNDED_AND_FAILED', 'NOTHING_TO_REFUND', 'ALREADY_REFUNDED',
  'REFUND_FAILED', 'TERMINALIZE_FAILED',
];

/** Did this job actually cost credits? A NULL debit is not a zero debit. */
function owedRefund(job) {
  if (!job) return { owed: false, amount: null, why: 'no job row' };
  if (job.credits_refunded_at) {
    return { owed: false, amount: null, why: 'already refunded' };
  }
  const n = Number(job.credits_debited);
  if (!Number.isFinite(n) || n <= 0) {
    // NULL means never debited — the dark-answer receipt the batch smoke
    // already relies on. Treating it as 0-and-refund-anyway would credit users
    // who were never charged.
    return { owed: false, amount: null, why: 'never debited' };
  }
  return { owed: true, amount: n, why: `debited ${n}` };
}

/**
 * Refund (if owed), then terminalize with credits_refunded_at in the same
 * write. Primitives are injected so the ordering is testable without a
 * RevenueCat account or a database.
 *
 *   refund(amount, job)        -> resolves on success, throws on failure
 *   terminalize(patch)         -> the single UPDATE; resolves with an outcome
 *   alert(title, body)         -> pages; never throws out of here
 */
async function failWithRefund(job, {
  refund, terminalize, alert = async () => {}, log = console, now = () => new Date(),
} = {}) {
  const o = owedRefund(job);

  if (o.owed) {
    try {
      await refund(o.amount, job);
    } catch (e) {
      // THE ROW IS NOT TOUCHED. The client keeps seeing the job in flight,
      // which is true, rather than a failure with the charge standing.
      const detail = (e && e.message) || 'unknown';
      log.error(`[fail-with-refund] REFUND FAILED job=${job.id} amount=${o.amount} `
        + `(${detail}) — the job was NOT marked failed, so the client cannot see a `
        + 'failure with the charge standing. refund-leg will retry.');
      try {
        await alert('💸 [Promptly] refund failed — job held non-terminal',
          `job ${job.id} owed ${o.amount} credits back and RevenueCat refused `
          + `(${detail}). The row is deliberately NOT marked failed. If this `
          + 'repeats, the refund-leg sweep is the backstop.');
      } catch (_) { /* an alert must never be the thing that fails a refund */ }
      return { state: 'REFUND_FAILED', amount: o.amount, detail, marked: false };
    }
  }

  // ONE WRITE, BOTH FACTS. credits_refunded_at rides with status='failed'.
  const patch = {};
  if (o.owed) patch.credits_refunded_at = now().toISOString();
  let outcome = null;
  try {
    outcome = await terminalize(patch);
  } catch (e) {
    // The money IS back and the row did not move. That is the safe direction —
    // a user who is not charged and whose job is still in flight loses nothing
    // — but it is a defect and it must not be quiet.
    const detail = (e && e.message) || 'unknown';
    log.error(`[fail-with-refund] REFUNDED BUT NOT TERMINALIZED job=${job.id} `
      + `amount=${o.amount} (${detail}) — the credits are back; the row is stale.`);
    try {
      await alert('⚠️ [Promptly] refunded but the row did not move',
        `job ${job.id}: ${o.amount} credits returned, then the terminal write `
        + `failed (${detail}). No user is out of pocket; the row needs repair.`);
    } catch (_) { /* never */ }
    return { state: 'TERMINALIZE_FAILED', amount: o.amount, detail, marked: false };
  }

  if (!o.owed) {
    return {
      state: job && job.credits_refunded_at ? 'ALREADY_REFUNDED' : 'NOTHING_TO_REFUND',
      amount: null, why: o.why, marked: true, outcome,
    };
  }
  return { state: 'REFUNDED_AND_FAILED', amount: o.amount, marked: true, outcome };
}

module.exports = { failWithRefund, owedRefund, STATES };
