/**
 * Determine if a user has Pro entitlement based on their profile row.
 *
 * Single source of truth: profiles.tier === 'pro' AND (pro_until IS NULL
 * OR pro_until > now()). RevenueCat's webhook writes both fields on
 * subscription start / trial start / renewal, and clears them on
 * cancellation / expiration / billing failure.
 *
 * We also still honor legacy 'teams'/'premium' tier values so any rows
 * hand-promoted via the dashboard keep working.
 */
function isUserPro(profile) {
  if (!profile) return false;

  // Admin comp — an explicit, service-role-only signal (a DB trigger blocks
  // authenticated clients from writing `comp_pro`, see the protect-entitlement
  // migration), so unlike a bare tier='pro' it is trustworthy on its own and
  // grants Pro regardless of tier / RevenueCat fields. This is the supported
  // way to hand-promote an account (internal staff, comped Pro). Strict `=== true`
  // so a stray truthy value can never silently comp.
  if (profile.comp_pro === true) return true;

  const tier = String(profile.tier || '').toLowerCase().trim();
  if (tier !== 'pro' && tier !== 'teams' && tier !== 'premium') return false;

  // If pro_until is set, the future-vs-past check is the source of truth.
  // Covers normal RevenueCat subscriptions (active, in-trial, cancelled-
  // but-not-yet-expired) without needing any other field.
  if (profile.pro_until) {
    const until = new Date(profile.pro_until);
    if (Number.isNaN(until.getTime())) return false;
    return until.getTime() > Date.now();
  }

  // No pro_until + tier === 'pro'. Two legitimate paths:
  //   (1) RevenueCat purchase just landed; the webhook wrote the tier
  //       but the expiration field hasn't been computed yet. Identifiable
  //       because rc_app_user_id is populated (RevenueCat webhook sets
  //       it at the same time as tier).
  //   (2) Hand-promoted account from the dashboard (internal staff,
  //       comped Pro). Identifiable because rc_app_user_id is null and
  //       there's an explicit is_admin / comp flag — we DON'T currently
  //       have one, so this path is intentionally closed.
  //
  // Anything else — tier='pro' with no rc_app_user_id and no pro_until
  // — is suspect. That's the exact state created by the now-removed
  // POST /api/user/subscription self-promote bypass. Refuse to honour
  // it so legacy bypassed rows fail closed until they're either reset
  // or linked to RevenueCat.
  if (profile.rc_app_user_id) return true;
  return false;
}

/** The entitlement's human lookup_key in the RevenueCat dashboard. */
const PRO_ENTITLEMENT_ID = 'pro';

/**
 * Decide Pro state from a RevenueCat REST **v2** active-entitlements list
 * (the `items` array of
 *   GET /v2/projects/{project_id}/customers/{customer_id}/active_entitlements).
 * Each item looks like:
 *   { object: 'customer.active_entitlement', entitlement_id: 'entl…', expires_at: <ms>|null }
 *
 * Pure + side-effect free so it's unit-testable without a network call — the
 * /api/revenuecat/sync endpoint and the webhook's TRANSFER branch both use it.
 *
 * `proEntitlementInternalId` is the internal id ("entl…") that the 'pro'
 * lookup_key resolves to. Pass null to accept ANY active entitlement, which is
 * the correct fallback for a single-entitlement project (and what we use if the
 * lookup can't be resolved).
 *
 * `expires_at` is epoch MILLISECONDS, or null for a non-expiring entitlement.
 * Consistent with this app's billing model (a BILLING_ISSUE webhook revokes
 * Pro), a match whose expiry is already in the past counts as inactive.
 *
 * Returns { active, proUntil } — proUntil is an ISO string or null.
 */
function proEntitlementFromV2ActiveList(items, proEntitlementInternalId, nowMs = Date.now()) {
  const list = Array.isArray(items) ? items : [];
  const matches = proEntitlementInternalId
    ? list.filter((it) => it && it.entitlement_id === proEntitlementInternalId)
    : list.slice();

  let bestExpiry = null; // furthest-out expiry among matches
  for (const it of matches) {
    const exp = it && it.expires_at;
    if (exp === null || exp === undefined) {
      return { active: true, proUntil: null }; // non-expiring beats everything
    }
    const ms = Number(exp);
    if (!Number.isFinite(ms)) continue;
    if (ms > nowMs && (bestExpiry === null || ms > bestExpiry)) bestExpiry = ms;
  }
  if (bestExpiry === null) return { active: false, proUntil: null };
  return { active: true, proUntil: new Date(bestExpiry).toISOString() };
}

module.exports = { isUserPro, proEntitlementFromV2ActiveList, PRO_ENTITLEMENT_ID };
