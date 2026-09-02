'use strict';
// Analytics ingest normalisation — the event NAME must not assert an outcome
// the payload contradicts.
//
// WHY (2026-08-02): `not_talking_head_rejected` fired with props.proceeded:true
// on 570 of 1040 events (55%) — an event whose name ends in "_rejected"
// described a NON-rejection most of the time. Counting the name at face value
// produced a false corrected-completion rate of 35.9% (real: 46.5%) by treating
// 68 warnings as blocks in a 12h window. A name that lies is a defect, not a
// cosmetic issue: it is read by everyone downstream who never sees the props.
//
// An audit of every outcome-asserting event name over 20,000 events (since
// 2026-07-30) found this is the ONLY offender — free_limit_hit,
// no_audio_rejected, too_short_rejected, too_long_rejected, render_completed,
// render_failed, upload_completed, purchase_failed, offerings_load_failed all
// carry no contradicting prop.
//
// Normalisation happens SERVER-SIDE at ingest, derived from props the current
// client already sends, so the split needs no app release. A future client that
// sends the split names directly passes through untouched.

const LEGACY_SPLIT = {
  not_talking_head_rejected: {
    prop: 'proceeded',
    whenTrue: 'not_talking_head_warned',
    whenFalse: 'not_talking_head_blocked',
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rewrite an outcome-asserting legacy event name using the payload that decides
 * the outcome. Returns the name unchanged when the client did not tell us —
 * an unknown must never be silently counted as a block.
 */
function normalizeEventName(event, props) {
  const rule = LEGACY_SPLIT[event];
  if (!rule) return event;
  const v = (props && typeof props === 'object' && !Array.isArray(props))
    ? props[rule.prop] : undefined;
  if (v === true) return rule.whenTrue;
  if (v === false) return rule.whenFalse;
  return event;
}

/**
 * RULE 7 (cut by USER, not by job). Every pre-dispatch analytics event landed
 * with user_id NULL, so the largest block class in the product could not be cut
 * by user at all — 109 blocks might have been 109 users or 5 users retrying,
 * and nothing could distinguish them. The client's distinct_id IS the Supabase
 * user.id for a signed-in user (the welcome-email hook already relies on this),
 * and it was a valid UUID on 126/126 sampled events. Anonymous / pre-signin
 * events keep NULL rather than being invented.
 */
function resolveUserId(anonUserId) {
  return (anonUserId && UUID_RE.test(String(anonUserId))) ? String(anonUserId) : null;
}

module.exports = { normalizeEventName, resolveUserId, LEGACY_SPLIT };
