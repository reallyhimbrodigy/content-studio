'use strict';

// Spend guards (Zac 2026-08-03) — stops the "one uncapped account = ~$86/day"
// gap and backstops attacker/bug runaway, WITHOUT a single global cap that a
// viral spike could trip into a self-inflicted outage.
//
//   1. PER-ACCOUNT DAILY RENDER CAP (default 50/day) — the actual gap. Blocks
//      one account's abuse; can NEVER cause a global outage.
//   2. TWO-TIER GLOBAL BREAKER — ALERT at 1500, HALT at 3000 (raised 2026-08-04
//      for the surge; see the note below — env-overridable). The page arrives
//      long before dispatch stops, so Zac gets a heads-up, not an outage.
//
// DB-counted (video_jobs.created_at) so a restart can't reset the count
// mid-attack. FAIL-OPEN on any DB error — a counting bug must never block a
// legitimate render. Thresholds are env-overridable.

// Defaults raised 2026-08-04 for the Instagram-virality surge (~1000 new users
// overnight, ~410 extra jobs → ~850-900, which would have tripped the old 800
// HALT mid-surge). At $0.09/job even 3000 jobs is ~$270, well under the $1,500
// cap. Env overrides win, so Render env can re-tune without a redeploy.
const PER_ACCOUNT_DAILY_CAP = parseInt(process.env.MODAL_PER_ACCOUNT_DAILY_CAP || '50', 10);   // abuse control — unaffected by volume
const GLOBAL_ALERT = parseInt(process.env.MODAL_GLOBAL_DAILY_ALERT || '1500', 10);
const GLOBAL_HALT = parseInt(process.env.MODAL_GLOBAL_DAILY_HALT || '3000', 10);

// In-memory alert de-dupe (alerts only, NOT the count). Keyed by reason+day so a
// page fires once per threshold per UTC day. A restart may re-page once — fine.
const _firedAlerts = new Set();

function _utcDayStartISO() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())).toISOString();
}
function _dayKey() {
  return _utcDayStartISO().slice(0, 10);
}

async function _countToday(supabaseAdmin, userId) {
  let q = supabaseAdmin
    .from('video_jobs')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', _utcDayStartISO());
  if (userId) q = q.eq('user_id', userId);
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

// Top accounts by render volume today — named in the HALT page so the first
// thing Zac sees is who caused it. Grouped in JS (bounded row count).
async function _topAccountsToday(supabaseAdmin, limit = 5) {
  const { data, error } = await supabaseAdmin
    .from('video_jobs')
    .select('user_id')
    .gte('created_at', _utcDayStartISO());
  if (error || !Array.isArray(data)) return [];
  const tally = new Map();
  for (const r of data) tally.set(r.user_id, (tally.get(r.user_id) || 0) + 1);
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([uid, n]) => `${String(uid).slice(0, 8)}=${n}`);
}

async function _fireOnce(alert, key, message) {
  if (_firedAlerts.has(key)) return;
  _firedAlerts.add(key);
  console.error(`[spend-guard] ${message}`);
  try { if (typeof alert === 'function') await alert(message); } catch (_) { /* alert best-effort */ }
}

/**
 * @returns {Promise<{allow: boolean, code?: string, message?: string}>}
 * Never throws — any error fails OPEN (allow), logged.
 */
async function checkSpendGuards({ supabaseAdmin, userId, alert } = {}) {
  if (!supabaseAdmin || !userId) return { allow: true };
  try {
    const [userCount, globalCount] = await Promise.all([
      _countToday(supabaseAdmin, userId),
      _countToday(supabaseAdmin, null),
    ]);

    // 1) GLOBAL HALT — loud page naming threshold + top accounts, then stop.
    if (globalCount >= GLOBAL_HALT) {
      const top = await _topAccountsToday(supabaseAdmin).catch(() => []);
      await _fireOnce(alert, `global-halt-${_dayKey()}`,
        `🚨 SPEND HALT: ${globalCount} renders today ≥ ${GLOBAL_HALT} — DISPATCH HALTED. Top accounts: ${top.join(', ') || 'n/a'}`);
      return { allow: false, code: 'spend_halt', message: 'Rendering is briefly paused for maintenance. Please try again shortly.' };
    }

    // 2) GLOBAL ALERT — page well before the halt; do NOT stop dispatch.
    if (globalCount >= GLOBAL_ALERT) {
      await _fireOnce(alert, `global-alert-${_dayKey()}`,
        `⚠️ SPEND ALERT: ${globalCount} renders today ≥ ${GLOBAL_ALERT} (halt at ${GLOBAL_HALT}). No action yet — watching.`);
    }

    // 3) PER-ACCOUNT DAILY CAP — stops one account; never a global outage.
    if (userCount >= PER_ACCOUNT_DAILY_CAP) {
      await _fireOnce(alert, `acct-cap-${userId}-${_dayKey()}`,
        `⚠️ account ${String(userId).slice(0, 8)} hit the daily render cap (${userCount} ≥ ${PER_ACCOUNT_DAILY_CAP}).`);
      return { allow: false, code: 'daily_render_cap', message: `Daily render limit reached (${PER_ACCOUNT_DAILY_CAP}/day). Please try again tomorrow.` };
    }

    return { allow: true };
  } catch (e) {
    // FAIL-OPEN: a counting bug must never block a legitimate render.
    console.error('[spend-guard] check failed — FAIL-OPEN (allowing render):', e && e.message ? e.message : e);
    return { allow: true };
  }
}

// ── Refund-farming control (Zac 2026-08-04) ─────────────────────────────────
// designed_rejection refunds (refund-leg.js) return the quota slot, so a user can
// loop bad uploads → rejected → refunded → harvest unlimited free ATTEMPTS (real
// compute). Bound it BY DESIGN, not by the coincidental 50/day spend cap.
//
// Counts ONLY user-fault rejection codes — never infra failures (RENDER_FATAL,
// UPLOAD_*, timeouts) — so a user whose renders fail on OUR side is NEVER blocked
// (that would be a wrongful conversion-killer). Generous cap, FAIL-OPEN.
const REJECTION_ATTEMPT_CAP = parseInt(process.env.MODAL_REJECTION_ATTEMPT_CAP || '20', 10);
const DESIGNED_REJECTION_CODES = [
  'NO_SPEECH', 'NO_SPEECH_NONENGLISH', 'NO_SPEECH_FACE', 'NOT_TALKING_HEAD',
  'CLIP_TOO_LONG', 'CLIP_TOO_SHORT', 'WRONG_ORIENTATION', 'INVALID_FORMAT',
  'EMPTY_UPLOAD',
];

async function checkRejectionAttemptCap({ supabaseAdmin, userId, alert } = {}) {
  if (!supabaseAdmin || !userId) return { allow: true };
  try {
    // THE COLUMN DOES NOT EXIST (found 2026-09-10). `video_jobs` has
    // `error_message` and `refund_last_error`; the rejection code lives in the
    // result envelope as `result->>error_code` (2,191 rows carry it). So this
    // filter returned 42703 on EVERY call since the guard shipped on
    // 2026-08-04, the catch below fired every time, and the refund-farming cap
    // has never once been evaluated.
    //
    // AND `head: true` IS WHY NOBODY COULD SEE IT. A HEAD response carries no
    // body, so PostgREST's "column video_jobs.error_code does not exist" was
    // discarded in transit and supabase-js built an error with an EMPTY
    // message. Measured against the live API: the same query as GET returns a
    // 99-byte body naming the column; as HEAD it returns zero bytes. The
    // optimisation that made the count cheap is what removed the only evidence
    // of why it failed. The rows here are at most a couple of dozen — the cap
    // is 20 — so counting them for real costs nothing worth having.
    const { data, error } = await supabaseAdmin
      .from('video_jobs')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'failed')
      .in('result->>error_code', DESIGNED_REJECTION_CODES)
      .gte('created_at', _utcDayStartISO());
    if (error) throw error;
    const count = Array.isArray(data) ? data.length : 0;
    if ((count || 0) >= REJECTION_ATTEMPT_CAP) {
      await _fireOnce(alert, `reject-cap-${userId}-${_dayKey()}`,
        `⚠️ account ${String(userId).slice(0, 8)} hit the rejection-attempt cap (${count} designed rejections ≥ ${REJECTION_ATTEMPT_CAP}) — possible refund farming.`);
      return { allow: false, code: 'too_many_rejected', message: "Too many videos couldn't be processed today. Please check your clip and try again tomorrow." };
    }
    return { allow: true };
  } catch (e) {
    // SAY WHAT WENT WRONG, not just that something did. `e.message` alone was
    // empty for five weeks and the line carried no other field, so the log
    // recorded a guard failing without ever recording why. A guard on the money
    // path that cannot say why it failed is worse than one that fails closed.
    console.error('[refund-guard] check failed — FAIL-OPEN (allowing):',
      JSON.stringify({
        message: (e && e.message) || null,
        code: (e && e.code) || null,
        details: (e && e.details) || null,
        hint: (e && e.hint) || null,
        raw: (e && e.message) ? undefined : String(e),
      }));
    return { allow: true };
  }
}

module.exports = {
  checkSpendGuards, PER_ACCOUNT_DAILY_CAP, GLOBAL_ALERT, GLOBAL_HALT,
  checkRejectionAttemptCap, REJECTION_ATTEMPT_CAP, DESIGNED_REJECTION_CODES,
};
