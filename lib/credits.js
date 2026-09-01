'use strict';

// ── CREDITS — RevenueCat Virtual Currency, server-side only ──────────────────
//
// THE RULINGS THIS ENCODES (Zac, 2026-08-31):
//   1. Debit 10 at render dispatch, SERVER-SIDE. A client debit is spoofable and
//      would drift from render accounting.
//   2. Credit back on failure, and the user SEES it. A silent restore is not
//      acceptable.
//   3. Re-edits NEVER debit, on any tier.
//   4. Balance is authoritative at RevenueCat. NO SECOND LEDGER.
//
// WHY EVERY MUTATION IS REST: the Virtual Currencies SDK surface is READ-ONLY
// client-side. Balances can only be changed with a secret key, from here. That
// is what makes ruling 1 a property of the system rather than an intention.
//
// VERIFIED AGAINST THE RC v2 DOCS, not assumed — the endpoint shapes below were
// read from the API reference before this file was written, because building on
// a guessed surface is how an integration ships broken:
//   GET  /v2/projects/{p}/customers/{c}/virtual_currencies
//        -> { items: [{ balance, currency_code, object }] }
//   POST /v2/projects/{p}/customers/{c}/virtual_currencies/transactions
//        body { "adjustments": { "<CODE>": -10 } }   (negative = spend)
//
// TWO FACTS FROM THOSE DOCS CHANGED THE DESIGN, and both corrected
// SERVER_CREDITS_CONTRACT.md after it was written:
//
//   A. RC VALIDATES THE BALANCE AND DEDUCTS ATOMICALLY. On an insufficient
//      balance it returns HTTP 422, retryable:false, and DEDUCTS NOTHING. So the
//      contract's original "read balance, compare, then debit" is a TOCTOU race
//      — two concurrent renders could both read 10 and both spend. The correct
//      flow is ATTEMPT THE DEBIT and treat 422 as the insufficient signal. The
//      check and the spend are then one operation, at RC, where the balance
//      lives.
//   B. IDEMPOTENCY KEYS ARE NOT DOCUMENTED on this endpoint. So exactly-once
//      cannot come from RC and MUST come from our claim marker
//      (video_jobs.credits_debited / credits_refunded_at). Assuming a retry is
//      safe here would double-spend a user's credits.

const REVENUECAT_API_BASE = 'https://api.revenuecat.com/v2';

const COST_PER_RENDER = 10;

// Monthly allowance per tier. Enforced BY RevenueCat (grants/refresh live
// there); listed here only so the balance endpoint can report what a user is
// working against. Changing these numbers here changes NOTHING about what a
// user actually has — that is the point of ruling 4.
const TIER_ALLOWANCE = { free: 30, pro: 200, max: 1000 };

// The currency's code as created in the RC dashboard. Configurable because it
// is a dashboard artifact, not a constant of ours.
function currencyCode() {
  return (process.env.REVENUECAT_CREDITS_CODE || 'CRD').trim();
}

function _config() {
  const secret = (process.env.REVENUECAT_SECRET_KEY || '').trim();
  const projectId = (process.env.REVENUECAT_PROJECT_ID || '').trim();
  return { secret, projectId, ok: Boolean(secret && projectId) };
}

/** True when credits can operate at all. Callers must branch on this rather
 *  than discovering a missing key inside a dispatch. */
function isConfigured() {
  return _config().ok;
}

async function _rc(method, path, body) {
  const { secret, projectId, ok } = _config();
  if (!ok) {
    const e = new Error('credits_not_configured');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  const url = `${REVENUECAT_API_BASE}/projects/${encodeURIComponent(projectId)}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    // Network/timeout. NOT the same as a refusal — the caller must be able to
    // tell "RC said no" from "RC did not answer", because one is the user's
    // problem and the other is ours.
    const e = new Error(`credits_unreachable: ${err && err.message}`);
    e.code = 'UNREACHABLE';
    throw e;
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* keep text */ }

  if (res.status === 422) {
    // Documented: "Customer's balance is not enough to perform the
    // transaction." retryable:false, AND NOTHING WAS DEDUCTED.
    const e = new Error('insufficient_credits');
    e.code = 'INSUFFICIENT';
    e.rcMessage = (json && json.message) || text.slice(0, 200);
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`credits_rc_error_${res.status}`);
    e.code = 'RC_ERROR';
    e.status = res.status;
    e.rcMessage = (json && json.message) || text.slice(0, 200);
    throw e;
  }
  return json;
}

/**
 * Current balance for this user, read through to RC.
 *
 * NEVER CACHED, and never falls back to a stored number: a stale balance that
 * looks authoritative is worse than no balance. On failure this throws and the
 * caller reports unavailability rather than a guess.
 */
async function getBalance(userId) {
  const code = currencyCode();
  const body = await _rc(
    'GET', `/customers/${encodeURIComponent(userId)}/virtual_currencies`);
  const items = (body && (body.items || body.virtual_currencies)) || [];
  const row = items.find((i) => i && i.currency_code === code);
  return {
    balance: row && Number.isFinite(row.balance) ? row.balance : 0,
    currency_code: code,
    found: Boolean(row),
  };
}

/**
 * Spend `amount` credits. Returns { ok:true } or throws with code
 * 'INSUFFICIENT' (RC refused, nothing deducted) / 'UNREACHABLE' / 'RC_ERROR'.
 *
 * NO PRE-READ. RC checks the balance and deducts in one operation, so reading
 * first only opens a race between the read and the spend.
 */
async function debit(userId, amount = COST_PER_RENDER) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`debit amount must be a positive integer, got ${amount}`);
  }
  await _rc('POST',
    `/customers/${encodeURIComponent(userId)}/virtual_currencies/transactions`,
    { adjustments: { [currencyCode()]: -amount } });
  return { ok: true, spent: amount };
}

/**
 * Give `amount` credits back. Used ONLY by the refund leg, which owns the
 * exactly-once claim — this function is deliberately not idempotent on its own,
 * because RC documents no idempotency key and pretending otherwise would
 * double-credit.
 */
async function credit(userId, amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`credit amount must be a positive integer, got ${amount}`);
  }
  await _rc('POST',
    `/customers/${encodeURIComponent(userId)}/virtual_currencies/transactions`,
    { adjustments: { [currencyCode()]: amount } });
  return { ok: true, granted: amount };
}

/**
 * Ruling 3, as a function rather than a comment at each call site.
 * A re-edit NEVER debits, on ANY tier.
 */
function shouldDebit({ mode, isReEdit } = {}) {
  if (isReEdit === true) return false;
  const m = String(mode || '').toLowerCase();
  // 'full' is a fresh render. Everything else that reaches dispatch with a mode
  // is a re-edit variant (tweak / reinterpret / render_only / guided_redraft).
  if (m && m !== 'full') return false;
  return true;
}

module.exports = {
  COST_PER_RENDER,
  TIER_ALLOWANCE,
  REVENUECAT_API_BASE,
  currencyCode,
  isConfigured,
  getBalance,
  debit,
  credit,
  shouldDebit,
};
