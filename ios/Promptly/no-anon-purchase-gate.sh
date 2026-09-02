#!/bin/bash
# NO PURCHASE MAY COMPLETE WITHOUT AN ACCOUNT.
#
# An anonymous purchase lands on $RCAnonymousID: the webhook fires with an
# app_user_id matching no profile, the entitlement is never written server-side,
# and it cannot be reliably aliased afterwards. That is the no_profile_matched
# failure the 1.3.20 ordering fix exists for.
#
# The old guard read `if currentUser != nil { ensureIdentified() }` — it enforced
# aliasing for a signed-IN user and did NOTHING for a signed-out one. That hole
# was invisible while the paywall sat behind signup. Deferred auth puts a
# purchasable surface in front of an anonymous user, so the hole becomes a live
# path, and this gate exists so it cannot reopen quietly.
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 1
FAIL=0

SVC="Services/SubscriptionService.swift"
[ -f "$SVC" ] || { echo "no-anon-purchase-gate: MISSING $SVC"; exit 1; }

# 1. purchase() must open with a HARD guard on a signed-in user, not an `if`.
BODY=$(awk '/func purchase\(_ package: Package/,/^    }$/' "$SVC")
if ! echo "$BODY" | grep -qE 'guard AuthService\.shared\.currentUser\?\.id != nil else'; then
  echo "  purchase() does not hard-guard on a signed-in user"
  FAIL=1
fi
# The guard must come BEFORE the store call, not after it.
GUARD_LINE=$(echo "$BODY" | grep -nE 'guard AuthService\.shared\.currentUser\?\.id != nil else' | head -1 | cut -d: -f1)
BUY_LINE=$(echo "$BODY" | grep -nE 'Purchases\.shared\.purchase|purchases\.purchase\(' | head -1 | cut -d: -f1)
if [ -n "$GUARD_LINE" ] && [ -n "$BUY_LINE" ] && [ "$GUARD_LINE" -ge "$BUY_LINE" ]; then
  echo "  the auth guard sits AFTER the store call — it guards nothing"
  FAIL=1
fi

# 2. Nobody may call RevenueCat's purchase API outside this one service.
STRAY=$(grep -rln --include="*.swift" "Purchases.shared.purchase" . 2>/dev/null \
        | grep -v "Services/SubscriptionService.swift" || true)
if [ -n "$STRAY" ]; then
  echo "  RevenueCat purchase called outside SubscriptionService:"
  echo "$STRAY" | sed 's/^/    /'
  FAIL=1
fi

# 3. The guard must not be gated on a feature flag. "No anonymous purchase" is a
#    safety property, not an experiment.
if echo "$BODY" | grep -qE 'deferredAuthEnabled|onboarding\.[a-zA-Z]*Enabled'; then
  echo "  purchase() reads a feature flag; the auth requirement must be unconditional"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then echo "no-anon-purchase-gate: FAIL"; exit 1; fi
echo "no-anon-purchase-gate: PASS — purchase is hard-gated on an account"
exit 0
