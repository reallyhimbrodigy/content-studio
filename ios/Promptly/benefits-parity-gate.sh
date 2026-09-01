#!/bin/bash
# benefits-parity-gate.sh — THE SHARED-CLAIM CHECK (2026-08-28).
#
# THE DEFECT THIS LOCKS OUT:
#   "Upload up to 10 videos at a time" was listed on the offer reveal and
#   MISSING from the first-launch paywall — the two screens a new user sees
#   back-to-back made different promises about the same product. It was not a
#   typo. FirstLaunchPaywallView hard-coded three benefitRow(...) calls inline
#   while OfferReveal.benefitLines built four somewhere else. The two lists
#   shared nothing, so they could not help but drift, and nothing could detect
#   it: each file read perfectly on its own.
#
# THE RULE:
#   A Pro benefit claim may be WRITTEN in exactly one place — ProBenefits.swift.
#   Every surface renders that list. A screen that spells a claim itself has, by
#   definition, forked the pitch.
#
# Proven both directions: re-inline a claim in a paywall view and this fails;
# remove it and it passes.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DIR/Promptly"
SOURCE_OF_TRUTH="$SRC/Views/ProBenefits.swift"
fail=0

if [ ! -f "$SOURCE_OF_TRUTH" ]; then
  echo "benefits-parity: FAILED — ProBenefits.swift is missing; there is no shared source."
  exit 1
fi

# ── 1. the claim that actually went missing must be IN the shared source ─────
if ! grep -q "Upload up to 10 videos at a time" "$SOURCE_OF_TRUTH"; then
  echo "benefits-parity: FAILED — the shared source no longer lists"
  echo "  'Upload up to 10 videos at a time'. That claim disappearing from one"
  echo "  surface is the exact defect this gate exists for."
  fail=1
fi

# ── 2. the tail must be structurally inherited, not re-listed ────────────────
# personalised() must START from core and substitute, so the claim SET and its
# length are invariant. If it ever builds a fresh array, the tail can drift
# again and this gate would not notice.
if ! grep -qE "var out = core" "$SOURCE_OF_TRUTH"; then
  echo "benefits-parity: FAILED — personalised() must start from \`var out = core\`"
  echo "  and substitute by index. Building a fresh list re-opens the drift."
  fail=1
fi

# ── 2b. the shared list must hold the slots personalisation writes into ─────
# personalised() substitutes slots 0 and 1. That is bounds-checked in Swift, so
# a short list degrades to the generic claim rather than crashing — but a core
# of fewer than two entries would silently disable personalisation everywhere,
# which is a defect the compiler cannot see.
# The range must close on EITHER terminator: `core` was a stored array ending in
# `]`, and is now a COMPUTED property ending in `}`. When it changed, this
# extraction silently returned zero, `grep -c` exited non-zero under
# `set -o pipefail`, and the gate died with NO OUTPUT AT ALL — reporting a
# failure it could not explain, on a tree with no violation. A gate that fails
# on the correct answer is the second time that shape has appeared today (the
# localization gate did it when plural variations arrived), so it is worth
# naming: extraction patterns encode a SHAPE, and shapes change.
#
# `|| true` so an empty match is a reported 0 rather than a silent death.
# -E, because this runs under BSD sed on macOS where `\|` alternation is a GNU
# extension that does not match and does not error — it just silently finds
# nothing. That is how this returned 0 twice while looking correct.
core_count=$(sed -nE '/static (let|var) core: \[Benefit\]/,/^    []}]$/p' "$SOURCE_OF_TRUTH" | grep -c 'Benefit(icon:' || true)
if [ "${core_count:-0}" -lt 2 ]; then
  echo "benefits-parity: FAILED — ProBenefits.core holds ${core_count:-0} claim(s);"
  echo "  personalised() writes slots 0 and 1, so fewer than two silently"
  echo "  disables personalisation on every surface."
  fail=1
fi

# ── 3. NO file may spell a claim except the shared source ───────────────────
# DEFAULT-DENY, not an allowlist. This gate previously governed a named list of
# surfaces and PASSED while SecondPaywallView still spelled "Unlimited videos,
# no daily cap" — because that file was not on the list. An allowlist gate only
# catches the surfaces you remembered, which is the same failure as a gate that
# reads the wrong tree: it reports green about the part it looked at.
#
# Now every Swift file is checked, so a NEW surface that respells a claim is
# caught the day it is written rather than the day someone notices the drift.
CLAIMS=$(grep -oE 'String\(localized: "[^"]+"\)' "$SOURCE_OF_TRUTH" | sed 's/String(localized: "//; s/")$//')
if [ -z "$CLAIMS" ]; then
  echo "benefits-parity: FAILED — parsed ZERO claims out of ProBenefits.swift."
  echo "  An empty parse is a failed read, not an empty list."
  exit 1
fi

while IFS= read -r f; do
  [ "$f" = "$SOURCE_OF_TRUTH" ] && continue
  # Comment lines may quote a claim while explaining the rule.
  body=$(grep -vE '^[[:space:]]*(//|/\*|\*)' "$f")
  while IFS= read -r claim; do
    [ -z "$claim" ] && continue
    if printf '%s' "$body" | grep -qF "$claim"; then
      echo "FORKED CLAIM   ${f#"$SRC/"} spells a benefit that belongs to ProBenefits:"
      echo "                 \"$claim\""
      fail=1
    fi
  done <<< "$CLAIMS"
done < <(find "$SRC" -name '*.swift')

GOVERNED="Views/FirstLaunchPaywallView.swift Views/Onboarding/OfferRevealView.swift Views/PaywallView.swift"

# ── 4. and they must actually RENDER the shared list ────────────────────────
# Without this, a surface could pass rule 3 by simply showing no benefits.
for rel in $GOVERNED; do
  f="$SRC/$rel"
  if ! grep -q "ProBenefits" "$f"; then
    echo "NOT WIRED      $rel does not reference ProBenefits — it shows no shared claims at all."
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "benefits-parity: FAILED — a Pro benefit is written outside ProBenefits.swift."
  echo "Render the shared list instead. Two screens that each own a copy of the"
  echo "pitch will drift, and the drift is invisible in review because each file"
  echo "reads correctly by itself."
  exit 1
fi

n=$(printf '%s\n' "$CLAIMS" | grep -c . || true)
echo "benefits-parity: PASS — all $n Pro claims live only in ProBenefits.swift."
exit 0
