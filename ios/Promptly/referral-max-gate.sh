#!/bin/bash
# Max subscribers must not be asked to refer (ruled 2026-09-01): the reward is
# subscription time, and the top tier has nothing to win.
#
# The rule lives in ONE property, ReferralService.shouldOffer. This gate asserts
# every surface that presents a referral share or progress consults it, so a
# seventh surface cannot ship without the check — which is exactly how the
# progress count and the share button drifted apart across four surfaces before.
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 1

# Files that present referral UI, and the symbol each must guard with.
FAIL=0
declare -a MISSING=()
for f in Views/PaywallView.swift Views/EditorView.swift \
         Views/ReferralProgressRow.swift; do
  [ -f "$f" ] || { echo "referral-max-gate: MISSING FILE $f"; FAIL=1; continue; }
  # Count presentation points vs guarded points.
  PRESENTS=$(grep -c "presentShareSheet(source:" "$f")
  # \.shouldOffer NOT followed by another letter — `shouldOfferSoftPrompt`
  # (PushService, unrelated) lives in EditorView and made this gate pass while
  # the guard was absent. A gate that cannot fail is worse than no gate.
  GUARDS=$(grep -cE "\\.shouldOffer([^A-Za-z]|$)" "$f")
  if [ "$PRESENTS" -gt 0 ] && [ "$GUARDS" -eq 0 ]; then
    MISSING+=("$f presents a share ($PRESENTS site(s)) but never reads shouldOffer")
    FAIL=1
  fi
done

# The rule itself must exist and be defined exactly once.
DEF=$(grep -cE "var shouldOffer([^A-Za-z]|$)" Services/ReferralService.swift)
if [ "$DEF" -ne 1 ]; then
  MISSING+=("ReferralService.shouldOffer defined $DEF time(s), expected exactly 1")
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "referral-max-gate: FAIL"
  for m in "${MISSING[@]}"; do echo "  $m"; done
  exit 1
fi
echo "referral-max-gate: PASS — every referral surface reads shouldOffer"
exit 0
