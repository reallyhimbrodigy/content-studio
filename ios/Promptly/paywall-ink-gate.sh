#!/bin/bash
# paywall-ink-gate.sh — WHITE INK ON EVERY SELLING SURFACE (2026-08-28).
#
# Ruling: gold → white on every paywall surface. The 2026-08-26 rebuild did the
# main paywall and stopped there, so FirstLaunchPaywallView kept a gold BEST
# VALUE badge, a gold selected border and a gold per-month anchor, and
# SecondPaywallView kept seven more. The user saw two different visual languages
# for one purchase.
#
# WHAT COUNTS AS A PAYWALL SURFACE — structurally, never a named list. A paywall
# surface is any file that INITIATES A PURCHASE (calls our
# SubscriptionService.purchase). That definition cannot fall out of date: a new
# selling screen is covered the moment it can take money, without anyone
# remembering to add it here. A list of remembered filenames is the failure this
# codebase has now paid for three times — see the standing rule about
# enumerating what is forbidden rather than where to look.
#
# The PromptlyGold enum itself survives: the app's Pro LANGUAGE outside the
# paywalls (the wand in chat, the Pro badge in account, tab-bar accents) still
# uses it deliberately. This gate governs selling surfaces only, which is
# exactly the ruling's scope.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DIR/Promptly"
GOLD='PromptlyGold'
fail=0
checked=0

while IFS= read -r f; do
  case "$(basename "$f")" in __PayoffSnapshotHarness.swift) continue ;; esac
  grep -qE '(subscription|sub|SubscriptionService\.shared)\.purchase\(' "$f" || continue
  checked=$((checked + 1))
  # Exclude the enum DEFINITION and comment lines; we are looking for USE.
  hits=$(grep -nE "\b${GOLD}\b" "$f" \
         | grep -vE ':[[:space:]]*(enum|struct) ' \
         | grep -vE ':[[:space:]]*(//|///|\*)' || true)
  if [ -n "$hits" ]; then
    echo "GOLD ON A SELLING SURFACE  ${f#"$SRC/"}"
    printf '%s\n' "$hits" | sed 's/^/     /'
    fail=1
  fi
done < <(find "$SRC" -name '*.swift')

if [ "$checked" -eq 0 ]; then
  echo "paywall-ink-gate: FAILED — found NO selling surfaces to check."
  echo "  Zero matches means the detector broke, not that the app stopped selling."
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "paywall-ink-gate: FAILED — a surface that takes money is still painting gold."
  echo "Ruling is white ink on every paywall surface. Keep hierarchy by OPACITY"
  echo "(a border is full white, a secondary anchor line is white at ~0.55), not by hue."
  exit 1
fi

echo "paywall-ink-gate: PASS — all $checked selling surfaces use white ink."
exit 0
