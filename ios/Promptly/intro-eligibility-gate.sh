#!/bin/bash
# intro-eligibility-gate.sh — NEVER CLAIM A DISCOUNT THE USER CANNOT RECEIVE.
# 2026-08-30
#
# THE DEFECT: `storeProduct.introductoryDiscount` describes the PRODUCT. Apple
# grants one introductory offer per Apple ID per subscription group, for ever.
# A returning user who already used theirs is charged FULL PRICE at the sheet no
# matter what we render — so reading the product alone showed
# "49% off · $145.99" to someone Apple then charged $289.99.
#
# That is a false money claim on the money surface: the same class the
# literal-percentage ban exists to prevent, arriving through a different door.
# It shipped in every build up to and including 238.
#
# THE RULE: every discount claim must pass through a check of THIS user's
# eligibility, and that check must fail closed.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DIR/Promptly"
SVC="$SRC/Services/SubscriptionService.swift"
REVEAL="$SRC/Views/Onboarding/OfferRevealView.swift"
fail=0

# ── 1. eligibility is actually fetched from RevenueCat ──────────────────────
if ! grep -q "checkTrialOrIntroDiscountEligibility" "$SVC"; then
  echo "NOT FETCHED     SubscriptionService never asks RevenueCat for eligibility."
  echo "                The product's offer is not the user's entitlement to it."
  fail=1
fi

# ── 2. it fails CLOSED ──────────────────────────────────────────────────────
# `.unknown` and `.noIntroOfferExists` are not a licence to claim a discount,
# and an unfetched map must not read as eligible.
if ! grep -qE '==\s*\.eligible' "$SVC"; then
  echo "NOT STRICT      eligibility is not compared against .eligible exactly —"
  echo "                unknown must never count as eligible"
  fail=1
fi
if ! grep -qE 'introEligibility\[[^]]+\]\s*==\s*true' "$SVC"; then
  echo "NOT FAIL-CLOSED an absent entry must be false, not optional-true"
  fail=1
fi

# ── 3. the CHOKE POINTS require it ──────────────────────────────────────────
# Every claim on the reveal — headline %, struck price, CTA label, the
# secondary monthly line, and whether the screen renders at all — flows through
# isRealOffer and percentOff. Requiring it there means a new claim cannot be
# added that forgets to ask.
for fn in isRealOffer percentOff; do
  block=$(awk "/static func ${fn}/,/^    \}/" "$REVEAL")
  if [ -z "$block" ]; then
    echo "MISSING         $fn not found in OfferRevealView"; fail=1; continue
  fi
  if ! printf '%s' "$block" | grep -q "isEligibleForIntro"; then
    echo "UNCHECKED CLAIM $fn builds a discount claim without checking eligibility"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "intro-eligibility-gate: FAILED — a discount could be claimed to a user"
  echo "Apple will charge full price. Under-promising costs a discount; over-"
  echo "promising charges someone double what the screen said."
  exit 1
fi
echo "intro-eligibility-gate: PASS — every discount claim requires per-user eligibility, failing closed."
exit 0
