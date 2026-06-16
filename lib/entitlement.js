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

module.exports = { isUserPro };
