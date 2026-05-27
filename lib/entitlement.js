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
  // If pro_until is missing, trust the tier flag — covers hand-promoted
  // accounts and the brief gap between RevenueCat purchase and webhook
  // delivery (the client's purchase callback writes tier='pro' optimistically).
  if (!profile.pro_until) return true;
  const until = new Date(profile.pro_until);
  if (Number.isNaN(until.getTime())) return true;
  return until.getTime() > Date.now();
}

module.exports = { isUserPro };
