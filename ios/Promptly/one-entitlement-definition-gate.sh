#!/usr/bin/env bash
# ONE DEFINITION OF "IS THIS USER PAYING".
#
# WHY (2026-09-07, second instance). `subscription.isPro || usage.isPro` reads
# like the whole answer and is not: `SubscriptionService.effectiveIsPro`
# composes RevenueCat's `pro`, RevenueCat's `max`, the server's /api/usage view
# and the DEBUG pose. The two-term version omits `isMax`, so a Max subscriber
# whose entitlement is Max-only is treated as free.
#
# AccountView had exactly this line and was fixed for exactly this reason — it
# had shown the wrong allowance. MessageBubble then had it too, walling Re-edit
# for a subscriber, and was found by a UI test rather than by review. Two
# instances of one shape is what a gate is for.
#
# It survives today only because the Max products are attached to the `pro`
# entitlement as an interim guard. When that ends, every such surface silently
# starts treating Max subscribers as free.
set -uo pipefail
cd "$(dirname "$0")"
FAIL=0

SRC=Promptly
# The composition itself lives in SubscriptionService; everywhere else must call
# it rather than re-derive it.
HITS=$(grep -rn 'subscription\.isPro *|| *usage\.isPro\|usage\.isPro *|| *subscription\.isPro' \
        "$SRC" --include='*.swift' \
        | grep -v 'Services/SubscriptionService.swift' \
        | sed -E 's://.*::' | grep 'isPro' || true)
if [ -n "$HITS" ]; then
  echo "  a surface re-derives entitlement instead of reading effectiveIsPro —"
  echo "  this omits isMax, so a Max-only subscriber is treated as free:"
  printf '%s\n' "$HITS" | sed 's/^/      /'
  FAIL=1
fi

# And the composition still composes all of it.
E=$(awk '/var effectiveIsPro: Bool \{/,/^    }$/' "$SRC/Services/SubscriptionService.swift")
for term in "isPro" "isMax" "UsageService.shared.isPro"; do
  grep -q "$term" <<< "$E" || {
    echo "  effectiveIsPro no longer composes $term"; FAIL=1; }
done

if [ "$FAIL" -ne 0 ]; then
  echo "one-entitlement-definition-gate: FAIL"
  exit 1
fi
echo "one-entitlement-definition-gate: PASS — entitlement is composed once, in"
echo "                    effectiveIsPro, and no surface re-derives it."
exit 0
