'use strict';
// RevenueCat churn CAUSE — the discriminating fields, and one place that maps
// them to a cause.
//
// WHY THIS EXISTS (2026-08-28). Asked to split auto-renew-off subscribers into
// user-cancelled vs billing-failure vs refund, we could not answer from our own
// data. We recorded `rc_type` and nothing else — and `rc_type` is precisely the
// field that does NOT separate those cases: RevenueCat reports a deliberate
// unsubscribe and a failed payment BOTH as CANCELLATION. The distinction lives
// in `cancel_reason`. Recording a field that is consistent across the two
// explanations you are trying to tell apart produces a confident-looking count
// that answers a different question.
//
// The mapping lives here, not in the query, so every future churn read splits
// the same way instead of re-deriving it.

/** The fields that actually discriminate. Null-safe; never invents a value. */
function rcReasons(event) {
  return {
    cancel_reason: event?.cancel_reason || null,
    expiration_reason: event?.expiration_reason || null,
    period_type: event?.period_type || null,
    store: event?.store || null,
    grace_until: Number(event?.grace_period_expiration_at_ms || 0) || null,
  };
}

// RevenueCat's reason vocabulary, grouped by what we would DO about it.
// BILLING_ERROR is the recoverable one: the user still wants the product and
// Apple is still retrying the card.
const BILLING = new Set(['BILLING_ERROR']);
const VOLUNTARY = new Set(['UNSUBSCRIBE', 'PRICE_INCREASE']);
const INVOLUNTARY_OTHER = new Set(['CUSTOMER_SUPPORT', 'DEVELOPER_INITIATED']);

/**
 * One canonical cause bucket for a RevenueCat event.
 * Returns: 'billing' | 'user_cancel' | 'refund' | 'support_or_developer'
 *        | 'expired' | 'active' | 'unknown_reason'
 *
 * 'unknown_reason' is deliberate and must NOT be folded into 'user_cancel':
 * a cancellation whose reason we did not capture is an UNMEASURED case, and
 * counting it as voluntary churn is how a billing problem disappears into a
 * "users are leaving" number.
 */
function churnCause(event) {
  const type = String(event?.type || event?.rc_type || '').toUpperCase();
  const reason = String(event?.cancel_reason || '').toUpperCase();
  const expReason = String(event?.expiration_reason || '').toUpperCase();
  switch (type) {
    case 'REFUND':
      return 'refund';
    case 'BILLING_ISSUE':
      return 'billing';
    case 'CANCELLATION':
      if (!reason) return 'unknown_reason';
      if (BILLING.has(reason)) return 'billing';
      if (VOLUNTARY.has(reason)) return 'user_cancel';
      if (INVOLUNTARY_OTHER.has(reason)) return 'support_or_developer';
      return 'unknown_reason';
    case 'EXPIRATION':
      if (expReason === 'BILLING_ERROR') return 'billing';
      if (!expReason) return 'unknown_reason';
      return 'expired';
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
    case 'PRODUCT_CHANGE':
    case 'NON_RENEWING_PURCHASE':
      return 'active';
    default:
      return 'unknown_reason';
  }
}

/** True while Apple is still retrying the card — i.e. churn we could still win back. */
function isRecoverable(event, nowMs) {
  if (churnCause(event) !== 'billing') return false;
  const grace = Number(event?.grace_period_expiration_at_ms || event?.grace_until || 0);
  if (!grace) return false;
  return grace > (Number.isFinite(nowMs) ? nowMs : Date.now());
}

module.exports = { rcReasons, churnCause, isRecoverable };
