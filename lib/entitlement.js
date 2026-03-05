/**
 * Determine if a user has Pro entitlement based on their profile row.
 * Shared source of truth for API guards and render watermark decisions.
 */
function isUserPro(profile) {
  if (!profile) return false;

  // Direct tier check — profiles.tier is the authoritative source.
  const directTier = String(profile.tier || '').toLowerCase().trim();
  if (directTier === 'pro' || directTier === 'teams' || directTier === 'premium') return true;

  const status = String(
    profile.subscription_status ||
    profile.stripe_subscription_status ||
    profile.status ||
    ''
  ).toLowerCase().trim();
  const isActiveStatus = status === 'active' || status === 'trialing';

  const plan = String(
    profile.subscription_plan ||
    profile.plan ||
    profile.tier ||
    profile.subscription_tier ||
    ''
  ).toLowerCase().trim();
  const isProPlan = plan === 'pro' || plan === 'teams' || plan === 'paid' || plan === 'premium';

  const hasProFlag = Boolean(profile.is_pro || profile.isPro || profile.pro || profile.paid);

  if (isActiveStatus && (isProPlan || !plan)) return true;
  if (hasProFlag) return true;
  return false;
}

module.exports = { isUserPro };
