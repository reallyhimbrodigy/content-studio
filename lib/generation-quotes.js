'use strict';
// THE GENERATION AND BATCH CONTRACT — sections 1-6, server side.
//
// ONE DEFINITION OF THE PRICE. lib/credit-prices.json is GENERATED from
// credit_prices.py in the worker lane and a leg there asserts they still
// agree. `label` and `credits` both come from the same row, so the card the
// user reads and the number we charge cannot drift: the client never builds
// the label and never sends a price.
//
// WHY THE FLAT 20 HAD TO GO. dispatch_classifier quoted AI_VIDEO_CREDITS = 20
// for any generated video. Against a 5-second clip that is UNDER cost on 7 of
// the 11 model x resolution rows — Seedance 2.5 at 1080p is 115 of our credits
// and we quoted 20. A flat number cannot price something that varies 11x with
// resolution alone.
//
// THE ATOMICITY IS ALREADY SOLVED AND NOT BY US. RevenueCat validates the
// balance and deducts in ONE operation: on an insufficient balance it returns
// 422 and deducts NOTHING. So "read balance, compare, debit" is the TOCTOU
// race and ATTEMPTING THE DEBIT is the correct flow — the check and the spend
// are one operation, at the place the balance lives. `credits never negative`
// is RC's 422, not a guard of ours.
//
// WHAT IS NOT SOLVED THERE IS EXACTLY-ONCE. RC documents no idempotency key on
// that endpoint, so a double-tap must be stopped by OUR claim marker before it
// reaches RC. That is the one thing this module must get right.

const fs = require('fs');
const path = require('path');

const QUOTE_TTL_MS = 10 * 60 * 1000;      // ten minutes, ruled
const BATCH_MAX = 10;                      // Pro, ruled
const DAILY_CAP = { paid: 10, max: 25 };   // per-day generation caps, ruled
const ETA_MIN_SAMPLES = 20;                // below this, eta_seconds is null

let _table = null;
function table() {
  if (_table) return _table;
  _table = JSON.parse(fs.readFileSync(path.join(__dirname, 'credit-prices.json'), 'utf8'));
  return _table;
}

const KINDS = { image: 'image', ai_video: 'video', voiceover: 'voiceover',
                music: 'music', sfx: 'sfx' };

/** -> { credits, label, row } or { error } — the price and the display string
 *  from ONE row, so the card and the charge cannot disagree. */
function priceFor({ kind, model, resolution, duration_s }) {
  const feature = KINDS[kind];
  if (!feature) return { error: 'unknown_kind' };
  const t = table();
  const row = t.rates.find((r) => r.feature === feature
    && (model ? r.model === model : true)
    && (resolution ? r.resolution === resolution : true));
  if (!row) {
    // NO ROW IS A REFUSAL, NEVER A GUESS. A real charge priced from an
    // invented number is the error that costs money rather than credibility.
    return { error: 'unpriced', why: t.unpriced[feature] || 'no rate published' };
  }
  let credits;
  let label;
  if (feature === 'video') {
    if (!(duration_s > 0)) return { error: 'duration_required' };
    credits = Math.ceil(row.our_per_unit * duration_s);
    label = `AI video · ${duration_s}s`;
  } else if (feature === 'voiceover') {
    credits = row.our_per_unit; label = 'Voiceover';
  } else if (feature === 'sfx') {
    if (!(duration_s > 0)) return { error: 'duration_required' };
    credits = Math.ceil(row.our_per_unit * duration_s);
    label = `Sound effect · ${duration_s}s`;
  } else if (feature === 'music') {
    credits = row.our_per_unit; label = 'Music';
  } else {
    credits = t.image_floor; label = 'Image';
  }
  return { credits, label, row };
}

/** Section 1 — the quote card. Display-ready; the client builds nothing. */
function quoteCard({ quote_id, kind, model, resolution, duration_s, balance, now }) {
  const p = priceFor({ kind, model, resolution, duration_s });
  if (p.error) return p;
  const t = (now === undefined ? Date.now() : now);
  return {
    quote_id, kind, label: p.label, credits: p.credits, balance,
    affordable: balance >= p.credits,
    expires_at: new Date(t + QUOTE_TTL_MS).toISOString(),
  };
}

/** Section 3 — ONE 402 shape, everywhere. `reason` alone decides the card,
 *  so nothing is ever parsed from prose. */
function paymentRequired(reason, { needed = 0, balance = 0 } = {}) {
  const actions = reason === 'pro_required' ? ['upgrade']
    : reason === 'daily_cap' ? ['upgrade']
      : ['topup', 'upgrade'];
  return {
    error: 'payment_required', reason,
    needed, balance, shortfall: Math.max(0, needed - balance),
    actions,
  };
}

/** Section 2 — expiry. An expired quote is REQUOTED, never an error: the
 *  client swaps the card in place and shows the fresh price. */
function isExpired(expires_at, now) {
  const t = (now === undefined ? Date.now() : now);
  return !(Date.parse(expires_at) > t);
}

/** Section 4 — the whole batch, priced by the server, all-or-nothing.
 *  NO PARTIAL SENDS, EVER. If the balance covers 4 of 10 the answer is
 *  "4, and you are 55 short" — the user then asks for 4, which is a new
 *  decision they made, not a silently shortened batch. */
function batchQuote({ batch_quote_id, clip_ids, kind, model, resolution,
                      duration_s, balance, now }) {
  if (!Array.isArray(clip_ids) || clip_ids.length === 0) return { error: 'no_clips' };
  if (clip_ids.length > BATCH_MAX) {
    return { error: 'too_many', max: BATCH_MAX, asked: clip_ids.length };
  }
  const p = priceFor({ kind, model, resolution, duration_s });
  if (p.error) return p;
  const count = clip_ids.length;
  const credits_total = p.credits * count;
  const t = (now === undefined ? Date.now() : now);
  return {
    batch_quote_id, count, credits_each: p.credits, credits_total, balance,
    affordable_count: Math.min(count, Math.floor(balance / p.credits)),
    shortfall: Math.max(0, credits_total - balance),
    expires_at: new Date(t + QUOTE_TTL_MS).toISOString(),
  };
}

/** Section 4 — confirm N. The server re-derives affordability AT CONFIRM TIME
 *  and dispatches exactly N or nothing. */
function batchConfirm({ count, credits_each, balance, tier, used_today }) {
  const needed = credits_each * count;
  const cap = DAILY_CAP[String(tier || '').toLowerCase()];
  if (cap === undefined) return paymentRequired('pro_required', { needed, balance });
  if (used_today + count > cap) return paymentRequired('daily_cap', { needed, balance });
  if (balance < needed) return paymentRequired('insufficient_credits', { needed, balance });
  return { ok: true, dispatch: count, reserve: needed };
}

/** Section 5 — the queue. eta_seconds is NULL below 20 samples and the client
 *  shows the position only. NO ETA IS EVER INVENTED: a median of three jobs is
 *  a number that looks like knowledge and is not. */
function queueFields({ queue_position, recent_durations_s }) {
  const d = Array.isArray(recent_durations_s) ? recent_durations_s.filter(
    (x) => typeof x === 'number' && isFinite(x) && x > 0) : [];
  if (d.length < ETA_MIN_SAMPLES) {
    return { status: 'queued', queue_position, eta_seconds: null };
  }
  const s = d.slice(-20).sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return { status: 'queued', queue_position,
           eta_seconds: Math.round(median * Math.max(1, queue_position)) };
}

module.exports = {
  QUOTE_TTL_MS, BATCH_MAX, DAILY_CAP, ETA_MIN_SAMPLES,
  priceFor, quoteCard, paymentRequired, isExpired, batchQuote, batchConfirm,
  queueFields, _table: table,
};
