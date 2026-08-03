'use strict';

// Spend guards (Zac 2026-08-03) — stops the "one uncapped account = ~$86/day"
// gap and backstops attacker/bug runaway, WITHOUT a single global cap that a
// viral spike could trip into a self-inflicted outage.
//
//   1. PER-ACCOUNT DAILY RENDER CAP (default 50/day) — the actual gap. Blocks
//      one account's abuse; can NEVER cause a global outage.
//   2. TWO-TIER GLOBAL BREAKER — ALERT at 450 (~2× today's 235), HALT at 800.
//      The page arrives long before dispatch stops, so Zac gets a heads-up, not
//      an outage.
//
// DB-counted (video_jobs.created_at) so a restart can't reset the count
// mid-attack. FAIL-OPEN on any DB error — a counting bug must never block a
// legitimate render. Thresholds are env-overridable.

const PER_ACCOUNT_DAILY_CAP = parseInt(process.env.MODAL_PER_ACCOUNT_DAILY_CAP || '50', 10);
const GLOBAL_ALERT = parseInt(process.env.MODAL_GLOBAL_DAILY_ALERT || '450', 10);
const GLOBAL_HALT = parseInt(process.env.MODAL_GLOBAL_DAILY_HALT || '800', 10);

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

module.exports = { checkSpendGuards, PER_ACCOUNT_DAILY_CAP, GLOBAL_ALERT, GLOBAL_HALT };
