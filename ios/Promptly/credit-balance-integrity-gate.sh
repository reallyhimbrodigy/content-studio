#!/usr/bin/env bash
# credit-balance-integrity-gate — a known credit balance must never be blanked
# by an unresolved currency, and must always be cleared on sign-out.
#
# WHY BOTH HALVES, IN ONE GATE. They are a matched pair: `refresh()` used to
# assign nil when RevenueCat returned without our currency, which blanked a
# balance already on screen (the `claimed_not_landed` population). Removing that
# assignment fixes the bug and simultaneously removes the only thing that was
# clearing the balance between accounts — so the leak and the fix are one edit
# apart in opposite directions. A gate that watched only one half would pass
# while the other regressed.
#
# Third half: the badge must stay observable. It shipped with no telemetry at
# all, so nothing in production could say whether it had ever drawn.
set -uo pipefail
cd "$(dirname "$0")"
IOS=Promptly
SVC="$IOS/Services/CreditsService.swift"
AUTH="$IOS/Services/AuthService.swift"
BADGE="$IOS/Views/CreditBadge.swift"
fail=0
note() { echo "  FAIL — $1"; fail=1; }

for f in "$SVC" "$AUTH" "$BADGE"; do
  [ -f "$f" ] || { echo "  FAIL — missing $f (a failed read is not a pass)"; exit 1; }
done

# A token match, both directions checked, so a rename cannot read as a pass.
has_token() { grep -Eq "(^|[^A-Za-z0-9_])$2([^A-Za-z0-9_]|$)" "$1"; }

echo "credit-balance-integrity-gate:"

# (1) THE BLANKING ASSIGNMENT MUST NOT COME BACK.
# Scoped to the success branch by matching the exact shape that caused it:
# assigning the optional subscript straight into `balance`.
if grep -Eq '^\s*balance\s*=\s*vc\[' "$SVC"; then
  note "CreditsService assigns an unresolved currency straight into balance — that blanks a known balance"
else
  echo "  ok   — no direct unresolved-currency assignment to balance"
fi

# The positive half: the success path must bind before assigning.
if grep -Eq 'if let [A-Za-z0-9_]+ = vc\[' "$SVC"; then
  echo "  ok   — the success path binds a resolved value before assigning"
else
  note "CreditsService no longer binds the resolved currency before assigning — the guard shape is gone"
fi

# (2) SIGN-OUT MUST CLEAR IT. Declared here AND called there — both halves, or
# the clear is an inert method nobody reaches.
if has_token "$SVC" "clearForSignOut"; then
  echo "  ok   — CreditsService declares clearForSignOut"
else
  note "CreditsService has no clearForSignOut — a signed-out device keeps the previous account's balance"
fi
if grep -Eq 'CreditsService\.shared\.clearForSignOut\(\)' "$AUTH"; then
  echo "  ok   — signOut calls CreditsService.shared.clearForSignOut()"
else
  note "AuthService never calls CreditsService.shared.clearForSignOut() — the clear is unreachable"
fi
# It must clear the claim flag too, or a second account on the device never claims.
if grep -A6 'func clearForSignOut' "$SVC" | grep -Eq 'claimAttempted\s*=\s*false'; then
  echo "  ok   — clearForSignOut resets claimAttempted"
else
  note "clearForSignOut does not reset claimAttempted — the next account on this device can never claim its grant"
fi

# (3) THE BADGE MUST REMAIN OBSERVABLE.
for ev in credit_badge_shown credit_badge_tap; do
  if grep -q "\"$ev\"" "$BADGE"; then
    echo "  ok   — $ev is emitted"
  else
    note "$BADGE no longer emits $ev — the surface goes dark to analytics"
  fi
done

# The impression must be gated on what the body actually draws, not on a
# separate condition that can drift away from it.
if grep -Eq 'private var visibleBalance' "$BADGE" \
   && grep -Eq 'if let [A-Za-z0-9_]+ = visibleBalance' "$BADGE" \
   && grep -Eq 'onChange\(of: visibleBalance\)' "$BADGE"; then
  echo "  ok   — body and impression event read one expression (visibleBalance)"
else
  note "the badge body and its impression event no longer share visibleBalance — they can now disagree"
fi

if [ "$fail" = 0 ]; then echo "credit-balance-integrity-gate: PASS"; else echo "credit-balance-integrity-gate: FAIL"; fi
exit "$fail"
