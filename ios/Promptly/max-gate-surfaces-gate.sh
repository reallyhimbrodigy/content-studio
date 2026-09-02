#!/bin/bash
# max-gate-surfaces-gate.sh — NO SURFACE SELLS AN UNAPPROVED TIER. 2026-09-02
#
# THE DEFECT:
#   74c5597 hid Max in `tierOptions` and described it as "dropped at the SOURCE
#   ... so it cannot leak into the toggle, the CTA, or a percentage computed
#   across tiers." That was the source for ONE surface. FirstLaunchPaywallView
#   never calls `tierOptions` — it listed the offering's packages directly, so
#   on a real erased device the FIRST screen of the app showed four plans with
#   **Max Yearly $799.99 preselected and badged BEST VALUE**, a product in
#   MISSING_METADATA, and wrote that id into `preselectedPlanID` as the funnel's
#   default purchase intent. `first_launch` is 25% of paywall views (1,393 of
#   5,563; 1,277 users, 13 days to 2026-09-02).
#
# THE RULE:
#   The gate lives in `SubscriptionService.sortedByDuration` — the one function
#   every plan-listing surface already calls. A view must not build its plan
#   list from `availablePackages` while bypassing it.
#
# WHY NOT A BROAD SWEEP: the first draft failed any Views file mentioning
# `availablePackages` and flagged seven, most of which read it for eligibility
# or allowance lookups and list nothing. A gate that fails on a correct tree
# gets switched off, so it is scoped to the choke point and to views that
# actually render a selectable list.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DIR/Promptly"
SVC="$SRC/Services/SubscriptionService.swift"
fail=0

[ -f "$SVC" ] || { echo "max-gate-surfaces: MISSING SubscriptionService.swift"; exit 1; }

# ── 1. the choke point actually consults the flag ───────────────────────────
block=$(awk '/static func sortedByDuration/,/^    \}/' "$SVC")
if [ -z "$block" ]; then
  echo "MISSING         sortedByDuration not found — the shared gate is gone."
  fail=1
elif ! printf '%s' "$block" | grep -q 'maxTierEnabled'; then
  echo "UNGATED SOURCE  sortedByDuration does not consult maxTierEnabled."
  echo "                Every plan-listing surface reads its list through this"
  echo "                function, so an unapproved tier leaks to all of them."
  fail=1
fi

# ── 2. no listing view bypasses it ──────────────────────────────────────────
# A view that ForEach-es over a package array must obtain that array from
# sortedByDuration (or from PaywallMapping.tierOptions, which gates separately
# via its own maxEnabled parameter).
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in *"/Views/"*) ;; *) continue ;; esac
  grep -qE 'ForEach\((packages|pkgs|plans|sorted)' "$f" || continue
  if ! grep -qE 'sortedByDuration|tierOptions' "$f"; then
    echo "BYPASSES GATE   $(basename "$f") renders a selectable plan list without"
    echo "                going through sortedByDuration or tierOptions, so the"
    echo "                Max gate does not reach it."
    fail=1
  fi
done <<< "$(grep -rl 'availablePackages' --include='*.swift' "$SRC" 2>/dev/null || true)"

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "max-gate-surfaces: FAILED — a surface can offer a tier that is not approved."
  exit 1
fi
echo "max-gate-surfaces: PASS — the Max gate sits in sortedByDuration and no listing view bypasses it."
exit 0
