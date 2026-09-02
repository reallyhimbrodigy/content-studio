#!/bin/bash
# paywall-view-event-gate.sh — THE PAYWALL IS NEVER SILENT, AND NEVER DOUBLE. 2026-09-02
#
# THE DEFECT:
#   TwoStepPaywall — the paywall the whole conversion surface is built on —
#   emitted NO view event at all, while the legacy PaywallView it replaces emits
#   `upgrade_wall_viewed`. Nothing in the tree noticed, because the two-step
#   paywall has never shipped: `TwoStepPaywall.swift` was added in 88b693a and
#   is not an ancestor of b86212c, the 1.3.25 (243) build commit, which is still
#   the newest build in the field. So the silence was invisible in production by
#   accident, and would have surfaced as a total collapse of every paywall view
#   metric on the day the branch merged.
#
#   The opposite failure is just as easy: the three wrapper surfaces (first
#   launch, trial wall, second paywall) each had their OWN emitter, and once
#   they started rendering TwoStepPaywall every view on those surfaces would
#   have been counted twice. Silence reads as a crash; double-counting reads as
#   a win. The second is more dangerous.
#
# THE RULE:
#   Exactly two views may emit `upgrade_wall_viewed` — the two paywall bodies,
#   which are mutually exclusive at runtime (UpgradePaywall picks one). Both key
#   the context off `PaywallView.reasonKey`, so the series is comparable across
#   the cutover instead of restarting.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DIR/Promptly"
EVENT='Analytics.track("upgrade_wall_viewed"'
fail=0

# ── 1. both paywall bodies emit ────────────────────────────────────────────
for rel in Views/PaywallView.swift Views/TwoStepPaywall.swift; do
  f="$SRC/$rel"
  if [ ! -f "$f" ]; then
    echo "MISSING         $rel"; fail=1; continue
  fi
  if ! grep -qF "$EVENT" "$f"; then
    echo "SILENT PAYWALL  $(basename "$rel") does not emit upgrade_wall_viewed."
    echo "                A paywall nobody can count is a paywall nobody can"
    echo "                improve, and its absence reads as a metric collapse."
    fail=1
  fi
done

# ── 2. nobody else emits ───────────────────────────────────────────────────
# Wrapper surfaces render TwoStepPaywall; an emitter of their own double-counts.
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$(basename "$f")" in
    PaywallView.swift|TwoStepPaywall.swift) continue ;;
    __*) continue ;;
  esac
  echo "DOUBLE COUNT    $(basename "$f") also emits upgrade_wall_viewed. It"
  echo "                renders the shared paywall, which already emits — every"
  echo "                view on this surface would be counted twice."
  fail=1
done <<< "$(grep -rlF "$EVENT" --include='*.swift' "$SRC" 2>/dev/null || true)"

# ── 3. the context is the ENTRY, from the shared resolver ──────────────────
# Two spellings of the same entry silently fork the funnel, which is the reason
# reasonKey was lifted off the instance in the first place.
# grep -A, not an awk range. The awk version interpolated the event string —
# quotes, parens and all — into a REGEX, matched nothing, and reported a forked
# context on a tree that keys correctly. Third time today a gate has failed on
# the right answer; the shape to avoid is building a pattern out of source text.
block=$(grep -A3 -F "$EVENT" "$SRC/Views/TwoStepPaywall.swift" 2>/dev/null || true)
if [ -z "$block" ] || ! printf '%s' "$block" | grep -q "reasonKey"; then
  echo "FORKED CONTEXT  TwoStepPaywall's view event does not key on"
  echo "                PaywallView.reasonKey — its contexts cannot be compared"
  echo "                with the legacy paywall's across the cutover."
  fail=1
fi

# ── 4. purchases key the same way as views ─────────────────────────────────
# A funnel needs both ends on the same key. `context: "two_step_paywall"` named
# the SCREEN, collapsing every entry into one bucket while views split by entry.
if grep -q 'purchase(pkg, context: "two_step_paywall")' "$SRC/Views/TwoStepPaywall.swift" 2>/dev/null; then
  echo "MISMATCHED END  TwoStepPaywall reports purchases under the screen name"
  echo "                while views split by entry — the ratio is meaningless."
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "paywall-view-event: FAILED — paywall view counting is silent, doubled, or forked."
  exit 1
fi
echo "paywall-view-event: PASS — two mutually exclusive emitters, both keyed on reasonKey, purchases keyed to match."
exit 0
