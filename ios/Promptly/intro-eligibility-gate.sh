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
#
# `introOfferLine` (PaywallView) IS THE THIRD CHOKE POINT, added 2026-09-02
# after it shipped the same defect through a door this gate did not watch. It
# renders "Intro price: $145.99 for your first year" from the PRODUCT's offer,
# and was documented "display-only" on the reasoning that RevenueCat applies
# the correct offer at purchase — true about the flow, and exactly why the
# claim is false rather than merely stale: an ineligible returning subscriber
# reads the discount and is charged full price with nothing to notice first.
# Survivable while the line was gated to `reason == .exportGate`; commit
# 74c5597 surfaced it on EVERY entry point, so it now reaches every paywall a
# returning subscriber sees.
PAYWALL="$SRC/Views/PaywallView.swift"
for pair in "$REVEAL:isRealOffer" "$REVEAL:percentOff" "$PAYWALL:introOfferLine"; do
  file="${pair%%:*}"; fn="${pair##*:}"
  if [ ! -f "$file" ]; then
    echo "MISSING         $(basename "$file") not found"; fail=1; continue
  fi
  block=$(awk "/static func ${fn}/,/^    \}/" "$file")
  if [ -z "$block" ]; then
    echo "MISSING         $fn not found in $(basename "$file")"; fail=1; continue
  fi
  if ! printf '%s' "$block" | grep -q "isEligibleForIntro"; then
    echo "UNCHECKED CLAIM $fn builds a discount claim without checking eligibility"
    fail=1
  fi
done

# ── 4. NO FOURTH DOOR: every file that reads the raw product offer must ask ─
# Naming the three choke points stops those three from regressing; it does not
# stop a fourth surface from reading `introductoryDiscount` and printing it.
# That is how this defect arrived twice. So the check is on the CLASS: a file
# that touches the product's offer must also mention the eligibility test.
#
# File-granular ON PURPOSE, and worth stating plainly rather than overselling:
# this proves a file that makes offer claims KNOWS about eligibility, not that
# every individual claim inside it is guarded. Per-claim proof needs the three
# choke points above, which is why both halves exist. Coarse and total beats
# precise and enumerable — a new paywall reading the offer fails this the day
# it is written, before it has a name anyone thought to add to a list.
# NO EXEMPTIONS, and the first draft of this check had one. It skipped `__*`
# files for the snapshot harness — which turns out not to read the offer at
# all, so the carve-out bought nothing and cost the whole guarantee: a probe
# file named `__Probe.swift` reading `introductoryDiscount` passed clean. An
# exemption written for a file that did not need it is how a gate develops a
# documented bypass. If a harness ever does need to render offer fixtures, it
# can mention the eligibility test in a comment and say why.
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if ! grep -q "isEligibleForIntro" "$f"; then
    echo "UNGUARDED FILE  $(basename "$f") reads .introductoryDiscount but never"
    echo "                mentions isEligibleForIntro — the product's offer is not"
    echo "                this Apple ID's entitlement to it."
    fail=1
  fi
done <<< "$(grep -rl "introductoryDiscount" --include="*.swift" "$SRC" 2>/dev/null || true)"

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "intro-eligibility-gate: FAILED — a discount could be claimed to a user"
  echo "Apple will charge full price. Under-promising costs a discount; over-"
  echo "promising charges someone double what the screen said."
  exit 1
fi
echo "intro-eligibility-gate: PASS — every discount claim requires per-user eligibility, failing closed."
exit 0
