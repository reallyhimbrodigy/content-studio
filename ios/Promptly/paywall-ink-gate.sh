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


# ── TWO LAYOUT DEFECTS THAT SHIPPED IN 1.3.27 ────────────────────────────────
# Both were invisible AT REST and appeared only once the paywall scrolled, which
# is exactly why a check of the resting state passed them. These assert the
# mechanism rather than the appearance, so they hold on every device.
LAYOUT_FAIL=0
PW=Promptly/Views/TwoStepPaywall.swift

# 1. The close button is pinned OUTSIDE the ScrollView and offset by the window's
#    own top inset. Inside the ScrollView it scrolled up under the status bar; a
#    GeometryReader reports a zero inset here because every paywall route puts an
#    .ignoresSafeArea() backdrop behind itself.
grep -q "PaywallSafeArea.top" "$PW" || {
  echo "  close button no longer offset by the window's top inset"; LAYOUT_FAIL=1; }
awk '/\.overlay\(alignment: \.topLeading\)/,/\.background\(Color\.black/' "$PW" | grep -q "header" || {
  echo "  close button is not pinned outside the ScrollView"; LAYOUT_FAIL=1; }
awk '/ScrollView\(showsIndicators: false\)/,/PromptlyLogo/' "$PW" | grep -qE '^ +header$' && {
  echo "  close button is back INSIDE the ScrollView — it will scroll under the status bar"; LAYOUT_FAIL=1; }

# 2. The tier column takes its natural height. `.frame(maxHeight: .infinity)`
#    made it flexible, and in a ScrollView whose content already exceeds the
#    viewport SwiftUI compressed it below its ideal — so its last row, "Cancel
#    anytime", overflowed and drew ON TOP of the social-proof line beneath it.
awk '/if let tier = activeTier/,/Spacer\(minLength: 0 \* k\)/' "$PW" \
  | grep -v '^[[:space:]]*//' | grep -q "frame(maxHeight: .infinity)" && {
  echo "  tier column is compressible again — Cancel anytime will overlap the social proof"; LAYOUT_FAIL=1; }
awk '/if let tier = activeTier/,/Spacer\(minLength: 0 \* k\)/' "$PW" | grep -q "fixedSize(horizontal: false, vertical: true)" || {
  echo "  tier column no longer takes its natural height"; LAYOUT_FAIL=1; }

# 3. The seam above the cancel line keeps a floor, not only a cap.
grep -q "Spacer(minLength: PaywallLayout.proofSeam \* k)" "$PW" || {
  echo "  the cancel/social-proof seam lost its minimum"; LAYOUT_FAIL=1; }

if [ "$LAYOUT_FAIL" -ne 0 ]; then
  echo "paywall-ink-gate: FAIL — paywall layout"
  exit 1
fi
echo "paywall-ink-gate: layout — close button pinned below the inset, tier column not compressible."

# ── 4. THE TIER THEY HOLD IS NOT FOR SALE ────────────────────────────────────
# Static half of the "Your plan" proof. The render half is the six-pose matrix
# captured with -poseTier; this makes the wiring itself unremovable.
HELD_FAIL=0

# Derived from the entitlement, never from the offering. Reading the held tier
# off the products on sale is how a paywall marks the wrong row.
awk '/private var heldTierAllowance/,/^    }$/' "$PW" | grep -q "subscription.isMax" || {
  echo "  heldTierAllowance no longer reads subscription.isMax"; HELD_FAIL=1; }
awk '/private var heldTierAllowance/,/^    }$/' "$PW" | grep -q "subscription.effectiveIsPro" || {
  echo "  heldTierAllowance no longer reads subscription.effectiveIsPro"; HELD_FAIL=1; }
awk '/private var heldTierAllowance/,/^    }$/' "$PW" | grep -qE "offering|availablePackages" && {
  echo "  heldTierAllowance reads the OFFERING — it must come from the entitlement"; HELD_FAIL=1; }

# The row tests the column it is drawn in. Testing the `tierAllowance` @State
# instead evaluates against nil on the first pass, and the mark never appears.
ROW=$(awk '/private func durationRow/,/^    }$/' "$PW")
grep -q "let shownAllowance = activeTier?.allowance" <<< "$ROW" || {
  echo "  durationRow no longer reads the column it is drawn in"; HELD_FAIL=1; }
grep -q "isHeldTier(shownAllowance)" <<< "$ROW" || {
  echo "  the owned test is not on the shown column"; HELD_FAIL=1; }
grep -q 'Text("Your plan")' <<< "$ROW" || {
  echo "  the held tier no longer says Your plan"; HELD_FAIL=1; }
grep -q "guard !isOwned else { return }" <<< "$ROW" || {
  echo "  the held tier's rows are tappable again"; HELD_FAIL=1; }

# The caller's tier wins on the first pass, so the column shown is the column asked for.
awk '/private var activeTier/,/^    }$/' "$PW" | grep -q "tierAllowance ?? initialTierAllowance" || {
  echo "  activeTier ignores the caller until applyDefaults runs"; HELD_FAIL=1; }

# The CTA goes, the legal links stay. Wrapping the whole footer took Terms and
# Privacy with it, on a screen that still sells the other tier.
FOOT=$(awk '/private var footer: some View/,/^    }$/' "$PW")
grep -q "if !isHeldTier(activeTier?.allowance) {" <<< "$FOOT" || {
  echo "  the CTA is back on a tier the user already holds"; HELD_FAIL=1; }
grep -q "Terms of Use" <<< "$FOOT" || {
  echo "  the footer lost Terms of Use"; HELD_FAIL=1; }
grep -q "Privacy Policy" <<< "$FOOT" || {
  echo "  the footer lost Privacy Policy"; HELD_FAIL=1; }
# Both links must sit OUTSIDE the CTA's `if`, or a Pro user sees no legal links.
python3 - "$PW" <<'PYEOF' || HELD_FAIL=1
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"private var footer: some View \{.*?\n    \}\n", src, re.S)
body = m.group(0)
i = body.index("if !isHeldTier(activeTier?.allowance) {")
depth, end = 0, None
for j in range(i, len(body)):
    if body[j] == "{": depth += 1
    elif body[j] == "}":
        depth -= 1
        if depth == 0: end = j; break
inside = body[i:end]
bad = [n for n in ("Terms of Use", "Privacy Policy") if n in inside]
if bad:
    print("  legal links are inside the CTA gate: " + ", ".join(bad))
    sys.exit(1)
PYEOF

if [ "$HELD_FAIL" -ne 0 ]; then
  echo "paywall-ink-gate: FAIL — held-tier marking"
  exit 1
fi
echo "paywall-ink-gate: held tier — Your plan from the entitlement, no CTA, legal links kept."

echo "paywall-ink-gate: PASS — all $checked selling surfaces use white ink."
exit 0
