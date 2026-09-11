'use strict';

// ── CHARGING N SOURCES ──────────────────────────────────────────────────────
//
// THE DESIGN THIS REPLACES. The worker contract originally priced the batch
// before dispatch: "60 credits against ten sources answers SIX with the
// shortfall named". The arithmetic was right and the mechanism was wrong, on
// two counts. The container holds no RevenueCat credentials by design, so it
// cannot see a balance; and debit() deliberately has NO PRE-READ, because "RC
// checks the balance and deducts in one operation, so reading first only opens
// a race between the read and the spend." A price-then-dispatch pass is that
// race one process further away — between pricing ten and dispatching six the
// balance can move under a concurrent render, a refund, or a renewal.
//
// So pricing is not a step. Debit each source in order and stop at the first
// INSUFFICIENT: "six answered, four held" becomes an OUTCOME of the charges
// rather than a prediction of them. RC's atomic check-and-deduct IS the pricing,
// there is no balance read anywhere, and the race has nowhere to live.
//
// STOPPING AT THE FIRST REFUSAL IS CORRECT, not just cheaper. Cost per source
// is uniform and a balance cannot rise mid-loop, so every later source would be
// refused too — continuing would spend N more RC round-trips to learn what the
// first refusal already said.
//
// PER-SOURCE REFUND NEEDED NO CODE. Each source is its own job row with its own
// `credits_debited` receipt, and lib/refund-leg.js already refunds per job under
// an exactly-once claim on that row's `credits_refunded_at`. Ten sources is ten
// independent receipts, which is what made fanning out safe in the first place.
//
// THIS NEVER THROWS. A thrown error after source 3 succeeded would leave 1 and
// 2 charged while the caller unwound the whole batch, so every outcome is
// reported per source instead. The caller's contract is simple and total:
// DISPATCH EVERY `answered`, TELL THE USER ABOUT EVERY `held`.

const DEFAULT_COST = 10;

/**
 * @param {object}   o
 * @param {string}   o.userId
 * @param {Array}    o.sources     [{ client_key, ... }] in the user's own order
 * @param {boolean}  o.armed       is the debit live? (CREDITS_DEBIT_ENABLED &&
 *                                 floor && configured && not a comp) — computed
 *                                 by the caller, never by this module
 * @param {Function} o.debit       (userId, amount) => Promise, throws INSUFFICIENT
 * @returns {Promise<{metered, costPerSource, answered, held, spent}>}
 */
async function debitSources({
  userId, sources, armed, debit, costPerSource = DEFAULT_COST, log = console,
}) {
  const list = Array.isArray(sources) ? sources : [];
  const answered = [];
  const held = [];

  // ── DARK ────────────────────────────────────────────────────────────────
  // Every source is answered and nothing is charged, which is exactly today's
  // behaviour. The SHAPE is identical to the armed path so the caller has one
  // code path and arming changes no control flow — but `metered` says which
  // world produced this answer, because "answered because it was free" and
  // "answered because it was paid for" must never look the same to a reader.
  // That distinction is what lets anyone tell, after the flag flips, whether
  // anything actually changed.
  if (!armed) {
    for (const s of list) answered.push({ client_key: s.client_key, credits_debited: null });
    return { metered: false, costPerSource, answered, held, spent: 0 };
  }

  let spent = 0;
  let stopped = null;   // once set, every remaining source is held for this reason

  for (const s of list) {
    if (stopped) { held.push({ client_key: s.client_key, reason: stopped }); continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      await debit(userId, costPerSource);
      spent += costPerSource;
      answered.push({ client_key: s.client_key, credits_debited: costPerSource });
    } catch (e) {
      const code = (e && e.code) || 'RC_ERROR';
      if (code === 'INSUFFICIENT') {
        stopped = 'insufficient';
      } else {
        // UNREACHABLE / RC_ERROR is UNMEASURABLE, not "no credits". Fail closed:
        // hold the rest rather than dispatching renders we could not charge for.
        // Anything already charged stays in `answered` and MUST still be
        // dispatched — those users paid, and refunding them for renders we chose
        // not to attempt would be the wrong repair.
        log.error(`[credits-batch] user=${String(userId).slice(0, 8)} `
          + `debit failed with ${code} after ${answered.length} source(s) — holding the rest`);
        stopped = 'unavailable';
      }
      held.push({ client_key: s.client_key, reason: stopped });
    }
  }

  return { metered: true, costPerSource, answered, held, spent };
}

/** What the user is told, in reason_code form. Never a sentence: the words live
 *  in the String Catalog behind the localization gate, or every reader gets
 *  English — the same ruling the refund leg follows. */
function shortfallFor(result) {
  const insufficient = result.held.filter((h) => h.reason === 'insufficient').length;
  if (!insufficient) return null;
  return {
    reason_code: 'credits_shortfall',
    held: insufficient,
    needed: insufficient * result.costPerSource,
  };
}

module.exports = { DEFAULT_COST, debitSources, shortfallFor };
