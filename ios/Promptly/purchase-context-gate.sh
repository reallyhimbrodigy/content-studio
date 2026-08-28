#!/bin/bash
# purchase-context-gate.sh — EVERY PURCHASE NAMES ITS SURFACE (2026-08-28).
#
# WHY: the canonical conversion read is revenue per wall-view, cut BY SURFACE
# and territory, joined in-database. Territory rides every event automatically;
# surface does not — it exists only because the caller passes `context:` into
# SubscriptionService.purchase(). A call site that omits it does not produce a
# wrong number, it produces a MISSING one: those purchases simply vanish from
# the by-surface cut, and a surface with no revenue is indistinguishable from a
# surface nobody bought from.
#
# SecondPaywallView shipped exactly that way in build 236.
#
# Shape per the standing rule: enumerate what is forbidden (a purchase without
# a context) and check EVERY Swift file, rather than listing the surfaces we
# happen to remember.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DIR/Promptly"
fail=0

while IFS= read -r f; do
  # The snapshot harness drives a purchase for a screenshot; it is not a surface.
  case "$(basename "$f")" in __PayoffSnapshotHarness.swift) continue ;; esac
  # Any call to our own purchase(...) — not RevenueCat's Purchases.shared.purchase.
  while IFS= read -r hit; do
    line="${hit%%:*}"
    code="${hit#*:}"
    printf '%s' "$code" | grep -q "Purchases.shared.purchase" && continue
    if ! printf '%s' "$code" | grep -q "context:"; then
      echo "UNSTAMPED PURCHASE  ${f#"$SRC/"}:$line"
      echo "                    $(printf '%s' "$code" | sed 's/^[[:space:]]*//' | cut -c1-84)"
      fail=1
    fi
  done < <(grep -nE "(subscription|sub|SubscriptionService\.shared)\.purchase\(" "$f" 2>/dev/null || true)
done < <(find "$SRC" -name '*.swift')

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "purchase-context-gate: FAILED — a purchase does not name its surface."
  echo "Pass context: \"<surface>\" so the revenue-per-wall-view read can attribute it."
  echo "An unstamped purchase is INVISIBLE in the by-surface cut, not merely wrong —"
  echo "and a surface with no revenue looks identical to one nobody bought from."
  exit 1
fi
echo "purchase-context-gate: PASS — every purchase names its surface."
exit 0
