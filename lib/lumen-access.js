'use strict';
// THE LUMEN ACCESS MODEL [§2.1] — dark, entitlement-driven, cost-capped.
//
// §2.1 (founder ruling 2026-08-12): Lumen is THE one premium model. Free = the
// standard editor at pro-parity floor (§3.4); paid = Lumen. Full-default free
// Lumen is REJECTED on unit cost (~$1/render all-in). Visibility is solved by
// BOUNDED EXPOSURE, not generosity — and any free-Lumen generosity is a
// METERED DIAL (default 0), never a doctrine. Paid Lumen carries a monthly
// render quota sized to unit cost.
//
// WHY THIS FILE EXISTS AT ALL — the three gates that produced 0/2,074:
//   1. server.js required `body.premium_pipeline_enabled === true` — a CLIENT
//      PICKER dependency. A Pro user who never opened the picker got standard.
//   2. process.env.PREMIUM_PIPELINE_ENABLED was never declared in render.yaml.
//   3. only 3 of 1,000 profiles are pro.
// §2.1's ruling kills (1): premium routing is tied to ENTITLEMENT server-side,
// never to a client pick. This module is that routing, plus the cost controls
// that make always-on-for-Pro affordable.
//
// EVERY DECISION IS RETURNED, NEVER ASSUMED. decide() returns a verdict object
// naming which gate closed, so a Lumen job that did not happen is explainable
// from one log line instead of a five-way AND nobody can see (the exact defect
// that hid this for 2,074 jobs).

const DEFAULTS = {
  // §2.1 "a metered dial (default 0), never a doctrine"
  freeRendersPerMonth: 0,
  // §2.1 "paid Lumen carries a monthly render quota sized to unit cost"
  paidRendersPerMonth: 30,
  // §2.1 "campaign #1 carries a cost budget per Lumen render"
  budgetUsdPerRender: 1.0,
  // Global blast radius. Not in §2.1 — added because an always-on premium path
  // with a per-render budget still has no ceiling on VOLUME, and the Modal
  // spend cap is a real, already-hit failure mode in this project.
  globalDailyBudgetUsd: 0,
};

function num(v, dflt) {
  // ABSENT AND ZERO ARE DIFFERENT. The first version did
  // Number(String(v ?? '').trim()), and Number('') is 0 — which is finite and
  // >= 0, so every default silently collapsed to 0 when the env var was absent.
  // That would have disabled the PAID tier by omission: master flag on, quota
  // 0, no Lumen, and a reason code ('paid_quota_zero') that reads like a
  // deliberate setting. Exactly the class of silent-disable this whole module
  // exists to end. The smoke caught it.
  const raw = String(v ?? '').trim();
  if (raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Config from env, every value overridable, every default safe. */
function config(env = process.env) {
  return {
    masterFlag: /^(1|true|yes|on)$/i.test(String(env.PREMIUM_PIPELINE_ENABLED || '').trim()),
    freeRendersPerMonth: num(env.LUMEN_FREE_RENDERS_PER_MONTH, DEFAULTS.freeRendersPerMonth),
    paidRendersPerMonth: num(env.LUMEN_PAID_RENDERS_PER_MONTH, DEFAULTS.paidRendersPerMonth),
    budgetUsdPerRender: num(env.LUMEN_BUDGET_USD_PER_RENDER, DEFAULTS.budgetUsdPerRender),
    globalDailyBudgetUsd: num(env.LUMEN_GLOBAL_DAILY_BUDGET_USD, DEFAULTS.globalDailyBudgetUsd),
  };
}

/**
 * Should THIS job run Lumen?
 *
 * @param {object} a
 *   isPro            server-resolved entitlement. NEVER a client field.
 *   clientDeclined   true ONLY when the client explicitly sent
 *                    premium_pipeline_enabled === false. Absence is NOT a
 *                    decline — that distinction is the whole §2.1 fix.
 *   usedThisMonth    the user's Lumen renders this month (null = unknown)
 *   spentTodayUsd    global Lumen spend today (null = unknown)
 * @returns {{premium: boolean, reason: string, quota: number|null}}
 */
function decide({ isPro = false, clientDeclined = false, usedThisMonth = null,
  spentTodayUsd = null, env = process.env } = {}) {
  const c = config(env);

  if (!c.masterFlag) return { premium: false, reason: 'master_flag_off', quota: null };

  // §2.1: free tier is the standard editor. The dial can open a bounded
  // exposure, and it is 0 by default — generosity is a number someone turned
  // up, never an accident of code.
  const quota = isPro ? c.paidRendersPerMonth : c.freeRendersPerMonth;
  if (quota <= 0) {
    return { premium: false, reason: isPro ? 'paid_quota_zero' : 'free_dial_zero', quota };
  }

  // An explicit client opt-out is honored — a Pro user who deliberately picks
  // the standard model gets it. Absence of the field is NOT a decline, which is
  // precisely the gate that produced 0/2,074.
  if (clientDeclined) return { premium: false, reason: 'client_declined', quota };

  // UNKNOWN IS NOT UNDER QUOTA. An unreadable count must not hand out ~$1
  // renders; the confident-zero class costs money here, not just credibility.
  if (usedThisMonth === null || usedThisMonth === undefined) {
    return { premium: false, reason: 'quota_unknown', quota };
  }
  if (usedThisMonth >= quota) {
    return { premium: false, reason: 'quota_exhausted', quota };
  }

  // Global cap. 0 = disabled (no ceiling configured) so this cannot silently
  // block the campaign the day it is turned on; a positive value enforces.
  if (c.globalDailyBudgetUsd > 0) {
    if (spentTodayUsd === null || spentTodayUsd === undefined) {
      return { premium: false, reason: 'global_spend_unknown', quota };
    }
    if (spentTodayUsd >= c.globalDailyBudgetUsd) {
      return { premium: false, reason: 'global_budget_exhausted', quota };
    }
  }

  return { premium: true, reason: 'entitled', quota };
}

/**
 * The user-facing sentence when Lumen was wanted and not given [§4.5, §4.6].
 * Returns null when there is nothing honest to say (the user never asked for
 * premium, or they got it) — a note fires on a WITHHELD capability, never as
 * chatter. Never mentions a flag, a quota table, or an internal reason code.
 */
function withheldNote(reason, { asked = false } = {}) {
  if (!asked) return null;
  switch (reason) {
    case 'quota_exhausted':
      return 'You’ve used all your premium edits this month — this one was made with the '
        + 'standard editor. Your premium renders reset next month.';
    case 'free_dial_zero':
      return 'Premium edits are part of the paid plan — this one was made with the standard '
        + 'editor.';
    case 'global_budget_exhausted':
      return 'Premium edits are paused right now and this one was made with the standard '
        + 'editor — nothing was charged for the premium pass.';
    case 'client_declined':
      return null;               // they chose standard; saying so is chatter
    default:
      // master_flag_off / quota_unknown / global_spend_unknown are OURS, not
      // the user's. Never expose an internal state as if it were their limit.
      return null;
  }
}

/**
 * The monthly quota key. feature_usage is a LIFETIME counter, and §2.1 says the
 * quota is MONTHLY — so the month rides the key and the reset is automatic and
 * free. No cron, no reset job, nothing to forget to run.
 */
function monthKey(now = new Date()) {
  return `lumen_render_${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * This user's Lumen renders this month, or NULL when it cannot be read.
 *
 * The shared getFeatureUsageCount returns 0 for "table missing" and 0 for "no
 * client" — indistinguishable from a genuine zero. Here that conflation would
 * hand out unlimited ~$1 renders on an unreadable quota, so this reads the row
 * itself and keeps the three states apart:
 *   number  a real count (no row = a real 0)
 *   null    UNKNOWN — client absent, table absent, or the query errored
 * decide() treats null as NOT under quota. Cost makes fail-open unaffordable.
 */
async function readMonthlyUsage(supabaseAdmin, userId, now = new Date()) {
  if (!supabaseAdmin || !userId) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('feature_usage')
      .select('count')
      .eq('user_id', userId)
      .eq('feature_key', monthKey(now))
      .maybeSingle();
    if (error) return null;              // includes a missing table
    if (!data) return 0;                 // no row = genuinely none used
    return typeof data.count === 'number' ? data.count : null;
  } catch (_) {
    return null;
  }
}

module.exports = { decide, config, withheldNote, monthKey, readMonthlyUsage, DEFAULTS };
