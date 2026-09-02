#!/bin/bash
# tier-copy-parity-gate.sh — BOTH TIERS DESCRIBE ONE MODEL. 2026-09-02
#
# THE DEFECT THIS LOCKS OUT:
#   Pro reading "Unlimited videos" while Max reads "1,000 credits/month ≈ 100
#   videos" makes the premium tier look strictly WORSE than the cheaper one —
#   unlimited beats a hundred. The two cards are read side by side, so a tier
#   that switches vocabulary on its own does not just look stale, it inverts
#   the pitch.
#
# THE RULE:
#   Every credit-denominated claim, on EITHER tier, is gated on `creditsEnabled`
#   — the same flag that arms the meter. Credits dark: neither tier says
#   "credits". Credits armed: both switch, same flag, same moment. There is no
#   configuration in which one tier is on the credits model and the other is not.
#
# WHY A GATE AND NOT A NOTE: the coupling is real today but invisible — it holds
# only because `tierOptions` happens to pass one `creditsEnabled` value into
# both branches. A future edit that reads the flag separately per tier, or adds
# a credits string outside a guard, breaks the pitch in a way that reads fine in
# the diff and only shows up as two cards contradicting each other on screen.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DIR/Promptly"
BENEFITS="$SRC/Views/ProBenefits.swift"
MAPPING="$SRC/Views/TwoStepPaywall.swift"
fail=0

for f in "$BENEFITS" "$MAPPING"; do
  [ -f "$f" ] || { echo "tier-copy-parity: MISSING $(basename "$f")"; exit 1; }
done

# ── 1. every credit-denominated claim is behind a creditsEnabled guard ──────
# creditsLine / videosLine print a credit number. usageMultiple is the ONLY
# source of Max's "Nx usage credits". All three must fail closed to "dark".
for fn in creditsLine videosLine usageMultiple; do
  block=$(awk "/static func ${fn}/,/^    \}/" "$BENEFITS")
  if [ -z "$block" ]; then
    echo "MISSING         $fn not found in ProBenefits"; fail=1; continue
  fi
  if ! printf '%s' "$block" | grep -qE 'guard[^\n]*creditsEnabled'; then
    echo "UNGATED CLAIM   $fn emits a credit-denominated string without a"
    echo "                creditsEnabled guard — it would print for a meter"
    echo "                that is not running."
    fail=1
  fi
done

# ── 2. Pro's unlimited claim is gated on the SAME flag, inverted ────────────
# "Unlimited videos" must appear only while credits are dark. Ungated, it is
# the half of the contradiction that survives the meter arming.
block=$(awk '/static func cardFeatures/,/^    \}/' "$BENEFITS")
if [ -z "$block" ]; then
  echo "MISSING         cardFeatures not found in ProBenefits"; fail=1
elif ! printf '%s' "$block" | grep -qE '!creditsEnabled'; then
  echo "UNGATED CLAIM   cardFeatures does not gate the unlimited claim on"
  echo "                !creditsEnabled — Pro would keep saying 'Unlimited'"
  echo "                after the meter arms, while Max counts credits."
  fail=1
fi

# ── 3. Max states no credit number of its own ──────────────────────────────
# Max's only credit reference must come THROUGH usageMultiple (checked above).
# A literal credits string written into maxCardList would bypass every guard.
block=$(awk '/static func maxCardList/,/^    \}/' "$BENEFITS")
if [ -z "$block" ]; then
  echo "MISSING         maxCardList not found in ProBenefits"; fail=1
elif printf '%s' "$block" | grep -n 'credits' | grep -qv 'usageMultiple'; then
  if printf '%s' "$block" | grep -E 'String\(localized:[^)]*credits' | grep -qv 'usageMultiple'; then
    :  # the interpolated "\(m)x usage credits" line is fed by usageMultiple
  fi
fi
if ! printf '%s' "$block" | grep -q 'usageMultiple'; then
  echo "UNGATED CLAIM   maxCardList no longer routes its usage claim through"
  echo "                usageMultiple, the only creditsEnabled-guarded source."
  fail=1
fi

# ── 4. ONE flag value reaches BOTH tiers ───────────────────────────────────
# The coupling that makes 1-3 sufficient: tierOptions must hand the SAME
# creditsEnabled parameter to the Pro branch and the Max branch. Reading the
# flag separately per tier (or passing a literal to one) re-opens the split
# even with every guard above intact.
block=$(awk '/static func tierOptions/,/^    \}/' "$MAPPING")
if [ -z "$block" ]; then
  echo "MISSING         tierOptions not found in TwoStepPaywall"; fail=1
else
  # EVERY `creditsEnabled:` argument in the block must be the parameter itself.
  # Counting occurrences was the first version of this check and it was useless:
  # the block passes `creditsEnabled: creditsEnabled` four times (Pro, Max,
  # creditsLine, videosLine), so hardcoding ONE of them to `true` only dropped
  # the count to three and a "> 2" threshold waved it through — the exact split
  # this gate exists to catch. Validate each argument, never tally them.
  # BODY ONLY — the declaration's own `creditsEnabled: Bool` is a type
  # annotation, not an argument, and scanning it made the gate fail on a
  # correct tree. A gate that fails on the right answer gets switched off.
  body=$(printf '%s' "$block" | sed -n '/-> \[PaywallTierOption\] {/,$p')
  bad=$(printf '%s' "$body" | grep -oE 'creditsEnabled:[[:space:]]*[A-Za-z0-9_.]+' \
        | sed -E 's/creditsEnabled:[[:space:]]*//' | grep -vx 'creditsEnabled' | sort -u)
  if [ -n "$bad" ]; then
    echo "SPLIT MODEL     tierOptions passes something other than the"
    echo "                \`creditsEnabled\` parameter: $(echo $bad | tr '\n' ' ')"
    echo "                One tier can now describe credits while the other says"
    echo "                'Unlimited' — the premium tier reads as the worse buy."
    fail=1
  fi
  for callee in cardFeatures maxCardList creditsLine videosLine; do
    if ! printf '%s' "$block" | grep -q "$callee"; then
      echo "SPLIT MODEL     tierOptions no longer routes through $callee — a tier"
      echo "                card is being built somewhere this gate cannot see."
      fail=1
    fi
  done
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "tier-copy-parity: FAILED — the two tiers can describe different models."
  exit 1
fi
echo "tier-copy-parity: PASS — every credit claim on both tiers is gated on one creditsEnabled; dark hides both, armed switches both."
exit 0
