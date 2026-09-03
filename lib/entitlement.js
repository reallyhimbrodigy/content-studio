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
function isUserPro(profile, now = Date.now()) {
  if (!profile) return false;

  // Admin comp — an explicit, service-role-only signal (a DB trigger blocks
  // authenticated clients from writing `comp_pro`, see the protect-entitlement
  // migration), so unlike a bare tier='pro' it is trustworthy on its own and
  // grants Pro regardless of tier / RevenueCat fields. This is the supported
  // way to hand-promote an account (internal staff, comped Pro). Strict `=== true`
  // so a stray truthy value can never silently comp.
  if (profile.comp_pro === true) return true;

  // 'max' added 2026-09-02. It was absent here while TIER_RANK below already
  // ranked max:40 ABOVE pro:30 — so the codebase ranked Max as the top tier and
  // simultaneously did not consider it paid. A Max subscriber returned false
  // from this function and was treated as free everywhere downstream, including
  // /api/credits/balance, which derives the credit allowance from isPro and so
  // reported 30 instead of 1000.
  const tier = String(profile.tier || '').toLowerCase().trim();
  if (tier !== 'pro' && tier !== 'teams' && tier !== 'premium' && tier !== 'max') return false;

  // If pro_until is set, the future-vs-past check is the source of truth.
  // Covers normal RevenueCat subscriptions (active, in-trial, cancelled-
  // but-not-yet-expired) without needing any other field.
  if (profile.pro_until) {
    const until = new Date(profile.pro_until);
    if (Number.isNaN(until.getTime())) return false;
    return until.getTime() > now;
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

/**
 * A COMPED account — paid by an explicit admin grant, not by a purchase.
 *
 * Used at the render debit site to SKIP the credit charge rather than refuse:
 * a comped account has no subscription, so RevenueCat's recurring grant has
 * nothing to hang on and the free monthly roll skips it as a paid tier. Metered
 * without a source of credits, it renders until its balance runs out and is
 * then refused forever.
 *
 * `comp_pro === true` ONLY — deliberately NOT "paid with no rc_app_user_id",
 * which would be the intuitive way to say the same thing and is the reason this
 * is a named function rather than an inline test.
 *
 * WHY THAT WIDER FORM IS UNSAFE (measured 2026-09-03). `comp_pro` is the one
 * entitlement column protected by a database trigger — `trg_guard_comp_pro`
 * raises on any write whose JWT role is `authenticated` or `anon`, so only the
 * service role can set it. `tier`, `pro_until` and `rc_app_user_id` have NO
 * such guard: UPDATE is granted to `authenticated` at table level and the RLS
 * policy is `auth.uid() = id` with no column restriction. A signed-in user can
 * therefore write their own `pro_until`, and any bypass keyed on it would be
 * self-serve free renders. The two accounts the wider form would additionally
 * cover have rendered ZERO times, ever — it buys nothing and opens that.
 *
 * Strict `=== true` so a stray truthy value can never comp, matching isUserPro.
 */
function isCompAccount(profile) {
  return Boolean(profile) && profile.comp_pro === true;
}

/**
 * Three-way entitlement tier for the trial-wall model (Release N+1):
 *   'none'  — no active entitlement (pre-trial or lapsed → the wall gates them).
 *   'trial' — an ACTIVE free-trial subscription (rc_period_type = 'trial').
 *             Gets the LIMITED tier (today's free limits), not full Pro.
 *   'paid'  — full Pro: a normal/intro paid subscription, an admin comp, or a
 *             legacy hand-promote.
 *
 * Built on isUserPro(), which fails closed on entitlement, so a malformed or
 * unentitled profile is 'none'. Only an entitlement EXPLICITLY marked as a free
 * trial is limited; every other active entitlement is full Pro, so a legacy or
 * comped row with no rc_period_type is never accidentally down-tiered. `now` is
 * injectable for deterministic tests.
 */
function entitlementTier(profile, now = Date.now()) {
  if (!isUserPro(profile, now)) return 'none';
  if (profile.comp_pro === true) return 'paid';
  const period = String(profile.rc_period_type || '').toLowerCase().trim();
  return period === 'trial' ? 'trial' : 'paid';
}

/**
 * The edge (ratified item 1): an RC-linked active entitlement classified as
 * full `paid` ONLY because it lacks a period type — the case the tier rule
 * silently promotes to generous. It's cost exposure worth watching: it should
 * be near-zero once the RC->DB reconcile cron runs, and if it isn't we want it
 * in the daily [REPORT], not in a Modal bill.
 *
 * Scoped to the cron-fixable population: RC-linked (`rc_app_user_id`), active,
 * non-comp, no `rc_period_type`. Comps and non-RC legacy hand-promotes lack a
 * period too but are intentional and not cron-relevant, so they're excluded to
 * keep the counter actionable. Pure — the caller does the logging.
 */
function unknownPeriodPaid(profile, now = Date.now()) {
  return (
    entitlementTier(profile, now) === 'paid' &&
    profile.comp_pro !== true &&
    !!profile.rc_app_user_id &&
    !String(profile.rc_period_type || '').trim()
  );
}

/** The entitlement's human lookup_key in the RevenueCat dashboard. */
const PRO_ENTITLEMENT_ID = 'pro';

// RC entitlement lookup_key -> the tier we store in profiles.tier (2026-09-02).
// This is the whole fix for "a Max purchase granted nothing": resolution used to
// key on PRO_ENTITLEMENT_ID alone, so an entitlement that was not literally
// 'pro' was invisible. Keys here are RC DASHBOARD artifacts — if a lookup_key is
// renamed there, it must be renamed here or that tier silently stops resolving.
// Values must be tiers TIER_RANK knows, or tierRank() scores them 0.
const ENTITLEMENT_TIER_BY_LOOKUP_KEY = { max: 'max', pro: 'pro' };

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

/**
 * TIER-AWARE sibling of proEntitlementFromV2ActiveList (2026-09-02).
 *
 * WHY A SIBLING AND NOT A CHANGE: the function above is exported and covered by
 * a dozen assertions. Its contract — "is the PRO entitlement active" — is still
 * correct for every caller that only asks that. Widening it in place would have
 * rewritten a tested contract to serve one new caller. This adds the capability
 * beside it instead.
 *
 * THE BUG THIS EXISTS FOR: RevenueCat now carries a `max` entitlement with the
 * Max products attached. The old path resolves exactly ONE internal id (the one
 * whose lookup_key is 'pro') and filters the customer's active entitlements down
 * to it — so a customer holding ONLY `max` matched nothing, resolved inactive,
 * and a completed purchase granted them NOTHING.
 *
 * @param items      RC v2 active_entitlements items
 * @param idToTier   { <internal entitlement id>: <tier label> }, e.g.
 *                   { entl_abc: 'max', entl_def: 'pro' }
 * @returns { active, proUntil, tier } — `tier` is the HIGHEST-RANKED active
 *          tier by tierRank, and `proUntil` is that SAME tier's furthest expiry.
 *
 * The tier and the expiry deliberately describe the SAME entitlement. A
 * customer can legitimately hold both (Zac is attaching the Max products to
 * `pro` as an interim guard, so both will be present), and pairing 'max' with
 * pro's later expiry would grant Max access past the Max subscription; pairing
 * it with an unrelated earlier expiry would revoke access the user still has.
 * One entitlement decides both fields, or the pair lies.
 */
function tieredEntitlementFromV2ActiveList(items, idToTier, nowMs = Date.now()) {
  const list = Array.isArray(items) ? items : [];
  const map = idToTier && typeof idToTier === 'object' ? idToTier : null;

  // No map (lookup failed) → preserve the single-entitlement fallback the old
  // path documents: accept any active entitlement, and call it 'pro'. Never
  // 'max' — an unidentified entitlement must not be promoted to the top tier.
  if (!map || Object.keys(map).length === 0) {
    const r = proEntitlementFromV2ActiveList(list, null, nowMs);
    return { ...r, tier: r.active ? 'pro' : null };
  }

  let best = null; // { tier, rank, proUntil, nonExpiring }
  for (const it of list) {
    const tier = it && map[it.entitlement_id];
    if (!tier) continue;                       // unmapped entitlement — ignore
    const rank = tierRank(tier);
    const exp = it.expires_at;
    const nonExpiring = exp === null || exp === undefined;
    let ms = null;
    if (!nonExpiring) {
      ms = Number(exp);
      if (!Number.isFinite(ms) || ms <= nowMs) continue;  // expired/garbage
    }
    if (!best || rank > best.rank) {
      best = { tier, rank, proUntil: nonExpiring ? null : ms, nonExpiring };
    } else if (rank === best.rank) {
      // Same tier twice (e.g. monthly + annual): keep the furthest expiry, and
      // a non-expiring grant beats any dated one.
      if (nonExpiring) { best.nonExpiring = true; best.proUntil = null; }
      else if (!best.nonExpiring && ms > best.proUntil) best.proUntil = ms;
    }
  }

  if (!best) return { active: false, proUntil: null, tier: null };
  return {
    active: true,
    proUntil: best.nonExpiring ? null : new Date(best.proUntil).toISOString(),
    tier: best.tier,
  };
}

/**
 * Auth check for the RevenueCat webhook.
 *
 * RevenueCat sends whatever you type into the dashboard's "Authorization header
 * value" field VERBATIM as the `Authorization` header. The two common ways to
 * fill it — the bare secret, or `Bearer <secret>` — must both work, or every
 * webhook 401s and billing silently stops syncing (exactly the bug we hit:
 * the dashboard had one form, the server expected the other). So we normalize
 * BOTH sides — strip an optional case-insensitive `Bearer ` prefix and trim —
 * then compare the bare secrets. Fails closed on an empty configured secret.
 *
 * This only tolerates the prefix/whitespace; the secret VALUE must still match,
 * so it grants nothing to a caller without the real secret.
 *
 * @param {string} authHeader      Incoming request `Authorization` header.
 * @param {string} expectedSecret  Configured secret (REVENUECAT_WEBHOOK_AUTH).
 * @returns {boolean}
 */
function revenuecatWebhookAuthMatches(authHeader, expectedSecret) {
  const stripBearer = (s) => String(s || '').trim().replace(/^Bearer\s+/i, '').trim();
  const expected = stripBearer(expectedSecret);
  if (!expected) return false;
  return stripBearer(authHeader) === expected;
}

/**
 * The wall tier from a server entitlement DECISION (assertProEntitled's return
 * shape: { isPro, reason, row, ... }), not a bare profile row. Guards two wiring
 * hazards the row-only path misses:
 *   - a decision without `.row` (e.g. an RC self-heal grants Pro without
 *     re-reading the profile) must NEVER read as 'none' for a Pro user — that
 *     would cap a paying user at trial limits with the knob OFF (the exact
 *     regression this fixes: gates fed `entitlement.row || {}` computed tier
 *     'none' for everyone when the decision carried no row at all);
 *   - isPro and the row can disagree mid-heal; most-privileged wins, matching
 *     the client's RC-vs-server composition rule.
 */
function tierFromEntitlement(decision, now = Date.now()) {
  const tier = entitlementTier((decision && decision.row) || {}, now);
  if (decision && decision.isPro === true && tier === 'none') return 'paid';
  return tier;
}


// ── TIER RANK — a grant may only ever RAISE a tier, never lower one ──────────
// Both grant paths (referral, reverse trial) wrote `tier: 'pro'` unconditionally,
// so an active Max subscriber who earned a referral or tapped Decline had their
// stored tier clobbered DOWN to 'pro'. There was no ordering anywhere in the
// server to take a maximum OF, which is why the clobber looked harmless.
//
// Ranked so a comparison is possible. 'paid'/'premium'/'teams' sit with 'pro'
// because entitlementTier() collapses subscription states to paid/trial/none —
// they are the same access level, not a higher one.
const TIER_RANK = {
  max: 40,
  teams: 30, premium: 30, pro: 30, paid: 30,
  trial: 20,
  free: 10, none: 10, '': 0,
};

function tierRank(t) {
  return TIER_RANK[String(t || '').toLowerCase().trim()] ?? 0;
}

/** The tier a grant should WRITE: the incoming one, unless the stored tier is
 *  already higher. Never lowers. */
function tierAfterGrant(existingTier, grantTier = 'pro') {
  return tierRank(existingTier) > tierRank(grantTier)
    ? String(existingTier).toLowerCase().trim()
    : grantTier;
}

/** The instant a grant should COUNT FROM: never earlier than an existing
 *  pro_until, so a grant can only extend. The referral path already did this;
 *  the reverse trial did not, and would overwrite a six-month subscription with
 *  72 hours. */
function grantFromMs(existingProUntilIso, now = Date.now()) {
  const prev = existingProUntilIso ? new Date(existingProUntilIso).getTime() : 0;
  return Math.max(now, Number.isFinite(prev) ? prev : 0);
}

module.exports = {
  TIER_RANK,
  tierRank,
  tierAfterGrant,
  grantFromMs,
  isUserPro,
  isCompAccount,
  entitlementTier,
  tierFromEntitlement,
  unknownPeriodPaid,
  proEntitlementFromV2ActiveList,
  tieredEntitlementFromV2ActiveList,
  PRO_ENTITLEMENT_ID,
  ENTITLEMENT_TIER_BY_LOOKUP_KEY,
  revenuecatWebhookAuthMatches,
};
