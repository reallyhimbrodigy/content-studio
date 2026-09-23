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
    quote_id, kind,
    // kind_label ships BESIDE label, not instead of it: `label` is the whole
    // display string ("AI video · 5s") and kind_label is the family. The
    // client was deriving the second from the first by splitting on " · ",
    // which already failed on the three kinds whose label has no separator.
    kind_label: kindLabel(kind),
    label: p.label, credits: p.credits, balance,
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
    batch_quote_id, count, kind_label: kindLabel(kind),
    credits_each: p.credits, credits_total, balance,
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

/** ─────────────────────────────────────────────────────────────────────────
 *  RULED 2026-09-23, REVISED THE SAME DAY — BATCH CONFIRM RETURNS PAIRS.
 *
 *  200 { jobs: [{ job_id, clip_id }, ...], balance: N }.
 *
 *  THE FIRST RULING WAS `job_ids` IN CLIP ORDER, AND THIS IS STRICTLY BETTER
 *  FOR ONE REASON: ORDER IS AN INVISIBLE CONTRACT. A bare array makes the
 *  client INFER which clip a job belongs to, and an inference that is wrong
 *  produces a perfectly healthy-looking batch — ten jobs, ten clips, no error,
 *  the right total charged — with clip 1's thumbnail spinning while clip 3's
 *  generation lands somewhere else. Nothing in the payload could ever
 *  contradict it, because the payload does not carry the claim. A pair carries
 *  the claim, so a mismatch is a value the client can compare rather than an
 *  assumption it cannot check.
 *
 *  The pairs stay IN CLIP ORDER anyway — it costs nothing and a stable order
 *  is the difference between a diffable response and one that churns — but the
 *  order is now a convenience, not the contract.
 *
 *  AND IT IS ALL-OR-NOTHING. A clip with no job is a MISSING PAIR, never a
 *  shorter array: under the old shape a short array silently re-aligned every
 *  index after the gap; under this one it would simply omit a clip the user
 *  was charged for. Both are refusals. */
function batchResponse({ clip_ids, jobs, balance }) {
  if (!Array.isArray(clip_ids) || clip_ids.length === 0) return { error: 'no_clips' };
  if (!Array.isArray(jobs)) return { error: 'no_jobs' };
  const byClip = new Map();
  for (const j of jobs) {
    if (!j || j.clip_id === undefined || j.job_id === undefined) {
      return { error: 'malformed_job' };
    }
    if (byClip.has(j.clip_id)) return { error: 'duplicate_job', clip_id: j.clip_id };
    byClip.set(j.clip_id, j.job_id);
  }
  const missing = clip_ids.filter((c) => !byClip.has(c));
  if (missing.length) return { error: 'dispatch_incomplete', missing };
  // A job for a clip nobody asked about means the dispatch and the request
  // disagree about the batch; that is a fault, not a spare row to ignore.
  if (byClip.size !== clip_ids.length) {
    return { error: 'unasked_job', dispatched: byClip.size, asked: clip_ids.length };
  }
  return {
    jobs: clip_ids.map((c) => ({ job_id: byClip.get(c), clip_id: c })),
    balance,
  };
}

/** ─────────────────────────────────────────────────────────────────────────
 *  RULED 2026-09-23 — POST /api/clips/picked IS IDEMPOTENT ON
 *  Idempotency-Key = upload_key. The same key within 30 minutes returns the
 *  SAME clip_id with a 200 and starts NO second import.
 *
 *  THE HEADER *IS* THE upload_key — one value, and the endpoint refuses a
 *  request whose header and body disagree rather than picking a winner. Two
 *  names for one value is where they drift, and the drift is invisible: both
 *  are well-formed keys and the wrong one just makes a second clip. */
const PICK_TTL_MS = 30 * 60 * 1000;

function pickedKey({ header, upload_key }) {
  const h = typeof header === 'string' ? header.trim() : '';
  if (!h) return { error: 'idempotency_key_required' };
  if (upload_key !== undefined && upload_key !== null && String(upload_key) !== h) {
    return { error: 'idempotency_key_mismatch' };
  }
  return { key: h };
}

/** Decides what the SECOND request does, from what the ON CONFLICT insert
 *  reported. `inserted` is `(xmax = 0)` off the RETURNING clause — the one
 *  field that distinguishes "I created this" from "it was already there",
 *  which DO NOTHING cannot tell you because it returns no row at all.
 *
 *  200 IN EVERY CASE, DELIBERATELY. A 201-for-new / 200-for-existing split
 *  makes a retry after a dropped response look different from the original,
 *  which is the one thing an idempotent endpoint exists to prevent. */
function pickedClipDecision({ inserted, created_at, used_at, now }) {
  const t = (now === undefined ? Date.now() : now);
  if (inserted) return { status: 'created', start_import: true, http: 200 };
  // Already claimed. It is a real clip in a project — never import again.
  if (used_at) return { status: 'reused', start_import: false, http: 200 };
  const age = t - Date.parse(created_at);
  // ABSENT IS NOT ZERO AND NOT INFINITY. An unreadable created_at would fall
  // to one side or the other silently: fresh (never re-import a dead upload)
  // or stale (import twice). Both are wrong, so it fails loudly to us.
  if (!(age >= 0)) return { error: 'unreadable_created_at', created_at };
  if (age <= PICK_TTL_MS) return { status: 'reused', start_import: false, http: 200 };
  // Past the window the sweep should have removed this row; if a sweep has not
  // run yet, the earlier import has aged out and the clip_id is still ours.
  return { status: 'refreshed', start_import: true, http: 200 };
}

/** ─────────────────────────────────────────────────────────────────────────
 *  kind_label — ONE DEFINITION, DERIVED FROM THE KIND.
 *
 *  The frontend was splitting `label` on " · " to get "AI video". That is a
 *  parser over prose: it is correct until a label has no separator (Image,
 *  Music, Voiceover all have none, so it already fails on three of five) or
 *  until one gains a second. The kind is the thing that actually decides it,
 *  so the kind decides it here and the client reads a field. */
const KIND_LABELS = {
  image: 'Image',
  ai_video: 'AI video',
  voiceover: 'Voiceover',
  music: 'Music',
  sfx: 'Sound effect',
};
function kindLabel(kind) {
  return KIND_LABELS[kind] || null;
}

/** ─────────────────────────────────────────────────────────────────────────
 *  THE CRASH MATRIX. Four ways a confirm can die mid-flight, and what a retry
 *  does about each.
 *
 *  THERE IS NO COLUMN HOLDING THE FIRST RESPONSE, and none is needed for a
 *  single quote: the response is reconstructed from state + charged_at +
 *  job_id, which are the three facts it was built from. What is NOT
 *  reconstructible is `balance` — that is RevenueCat's number at the moment
 *  of the charge, RC has no "balance as of" read, and storing our own copy
 *  would be the second source of truth for money this whole design exists to
 *  avoid. So a replay returns the CURRENT balance and says so with
 *  `balance_is_current: true`. A stale balance shown as live would be worse
 *  than a live one shown late.
 *
 *  THE THREE STATES OF A CHARGE, WHICH IS THE WHOLE MATRIX:
 *    CHARGED      RC returned success; charged_at is set.
 *    NOT CHARGED  RC returned 422. It documents that 422 deducts NOTHING, so
 *                 this is a fact, not an inference — the claim RELEASES.
 *    UNKNOWN      anything else: a timeout, a 5xx, a dropped socket. The
 *                 money may or may not have moved. Releasing here would let a
 *                 second confirm charge twice; settling would settle a quote
 *                 that may never have been paid. It HOLDS, claimed and
 *                 uncharged, and is reconciled out of band.
 *  Folding UNKNOWN into either neighbour is the three-state rule failing
 *  inside the code that handles money, which is the most expensive place for
 *  it to fail. */

/** (a),(b),(c),(d) — what a retry of a confirm should do, from the row alone. */
function recoverQuote({ state, charged_at, job_id, expires_at, now }) {
  const t = (now === undefined ? Date.now() : now);
  const charged = !!charged_at;
  const hasJob = !!job_id;
  const live = expires_at === undefined || Date.parse(expires_at) > t;

  if (state === 'open') {
    if (charged || hasJob) {
      // An open quote that has been charged or built is not a state, it is a
      // contradiction — loud, never repaired by guessing which half is true.
      return { action: 'inconsistent', why: 'open but charged_at/job_id set' };
    }
    return live
      ? { action: 'confirm', why: 'open and live — the normal path' }
      : { action: 'requote', why: 'open but expired — a fresh price, not an error' };
  }

  if (state === 'claimed') {
    // (a) DIED AFTER THE CLAIM, BEFORE THE RC DEDUCT. Nothing was taken and
    // nothing was built. The retry does NOT hang waiting for a first result
    // that does not exist: the claim is already ours — that is what the claim
    // is FOR — so the retry resumes at the charge. It deliberately ignores
    // expiry: the price was fixed when the claim won, and re-pricing a quote
    // the user already confirmed would move the number under them.
    if (!charged) return { action: 'charge', why: '(a) claimed, never charged — resume at the deduct' };
    // (b) DIED AFTER THE DEDUCT, BEFORE THE JOB INSERT. The user is charged
    // with nothing to show. DETECTED as exactly this row shape:
    // charged_at set, job_id null. REPAIR IS RESUME, NOT REFUND — the user
    // wanted the thing and paid for it; refunding first and asking later
    // turns a delay into a cancellation they did not choose. Refund is the
    // fallback when the job cannot be created at all.
    if (!hasJob) return { action: 'resume_job', why: '(b) charged with no job — build it, refund only if it cannot be built' };
    return { action: 'settle', why: 'charged and built; the settle write was lost' };
  }

  if (state === 'settled') {
    if (!charged || !hasJob) {
      return { action: 'inconsistent', why: 'settled without a charge and a job' };
    }
    return { action: 'replay', why: 'already done — return the first result' };
  }

  if (state === 'refunded') {
    // (d) THE JOB FAILED AFTER THE CHARGE and the refund already fired.
    return { action: 'replay_refund', why: '(d) refunded — say so, never re-charge' };
  }

  if (state === 'expired') return { action: 'requote', why: 'expired — a fresh price' };
  return { action: 'inconsistent', why: `unknown state ${JSON.stringify(state)}` };
}

/** What to do with RevenueCat's answer. The 422 is the only "not charged"
 *  RC promises; everything else that is not success is UNKNOWN. */
function chargeOutcome({ ok, status }) {
  if (ok) return { charge: 'CHARGED', next: 'record_charge' };
  if (status === 422) {
    // (c) RC 422 AFTER THE CLAIM. The claim must RELEASE, back to 'open', or
    // the quote is stuck: not charged, so nothing to refund, and not open, so
    // the confirm after a top-up can never succeed. A quote the user can
    // neither spend nor recover is the worst of the four outcomes precisely
    // because nothing looks broken.
    return { charge: 'NOT_CHARGED', next: 'release', release_to: 'open' };
  }
  return {
    charge: 'UNKNOWN',
    next: 'hold',
    why: 'the money may or may not have moved; releasing would allow a double '
       + 'charge and settling would settle an unpaid quote',
  };
}

/** The first response, rebuilt. `balance` is re-read live — see above. */
function replayConfirm({ quote_id, kind, credits, job_id, balance }) {
  return {
    quote_id, job_id,
    kind_label: kindLabel(kind),
    credits,
    balance,
    balance_is_current: true,
    replayed: true,
  };
}

/** THE GAP, NAMED. A batch confirm's response is jobs:[{job_id, clip_id}],
 *  and NOTHING APPLIED STORES THOSE PAIRS. generation_batch_quotes holds
 *  clip_ids and confirmed_count but no job ids, and video_jobs has no
 *  clip_id and no batch column (read from the live schema 2026-09-23). So a
 *  crash between dispatch and response leaves a batch that cannot be
 *  replayed, only re-derived by guessing.
 *
 *  This refuses instead of guessing, and the batch confirm route stays dark
 *  until a column holds the pairs. Recommended: `jobs jsonb` on
 *  generation_batch_quotes, written in the same statement as confirmed_count
 *  — jsonb rather than two aligned arrays, because index-aligned arrays are
 *  the ordering contract we just removed from the response, reintroduced
 *  where nobody would look for it. */
function replayBatchConfirm() {
  return {
    error: 'unreplayable_batch',
    missing: 'generation_batch_quotes has no column holding the dispatched '
           + '{job_id, clip_id} pairs, and video_jobs has neither a clip_id '
           + 'nor a batch_quote_id',
    fix: 'ALTER TABLE generation_batch_quotes ADD COLUMN jobs jsonb;',
  };
}

module.exports = {
  QUOTE_TTL_MS, BATCH_MAX, DAILY_CAP, ETA_MIN_SAMPLES, PICK_TTL_MS,
  priceFor, quoteCard, paymentRequired, isExpired, batchQuote, batchConfirm,
  queueFields, batchResponse, pickedKey, pickedClipDecision,
  kindLabel, KIND_LABELS, recoverQuote, chargeOutcome, replayConfirm,
  replayBatchConfirm, _table: table,
};
