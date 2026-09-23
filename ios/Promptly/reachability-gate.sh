#!/bin/bash
# REACHABILITY GATE — a View that nothing calls must not ship.
#
# WHY THIS EXISTS. Six surfaces were built, translated, reviewed, committed and
# shipped in build 241 while being referenced by NOTHING. They compiled, they
# passed every other gate, and they were reported as "shipped behind a flag".
# They were not behind a flag — they were absent. Flipping the flag would have
# changed nothing, and the first person to notice would have been whoever tried
# to record a demo of a screen that does not exist.
#
# Every existing gate checked the CONTENT of what we wrote. None checked that
# anything reaches it. "Compiles" and "runs" are separated by exactly this
# question and nothing else was asking it.
#
# WHAT IT CHECKS: every `struct X: View` declared under Promptly/Views must be
# named in at least one file OTHER than the one that declares it. That is a
# deliberately weak test — it proves a reference exists, not that the reference
# is reachable from PromptlyApp — but it is the check that would have caught all
# six, and a weak check that runs beats a strong one that does not.
#
# Exit 0 = every View has a caller. Exit 1 = at least one is orphaned.

set -uo pipefail
cd "$(dirname "$0")" || exit 2

VIEWS_DIR="Promptly/Views"
[ -d "$VIEWS_DIR" ] || { echo "reachability-gate: CANNOT READ — no $VIEWS_DIR"; exit 2; }

# Entry points and harnesses legitimately have no in-tree caller: the app root
# is invoked by SwiftUI itself, previews by Xcode, harness screens by launch
# argument. Anything added here must be justified in the commit that adds it —
# this list is the gate's only escape hatch and it is how the gate dies.
ALLOW="PromptlyApp|__PayoffSnapshotHarness|_Previews|PreviewProvider"

orphans=0
checked=0

while IFS= read -r file; do
  # Declared View structs in this file. Bounded to `struct NAME: ... View`.
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    case "$name" in
      # Native bash matching — NOT `printf | grep -q`. That idiom returns 141
      # under `set -o pipefail` when grep exits early on a large file (SIGPIPE),
      # which made an earlier gate's verdict depend on file size rather than on
      # content.
      *) ;;
    esac
    if [[ "$name" =~ ^($ALLOW)$ ]]; then continue; fi

    checked=$((checked + 1))

    # Count USE sites: every mention anywhere in the tree, minus the lines that
    # merely DECLARE the type (`struct X`, `extension X`).
    #
    # The first version of this excluded the declaring FILE instead, and was
    # wrong in a way worth recording: it flagged 30 Views, most of them
    # perfectly reachable, because a View used only by its own file — a private
    # subview like UsageMeterStrip, called one line from where it is written —
    # looked identical to a true orphan. A gate with a 4-to-1 false-positive
    # rate does not get fixed, it gets ignored, and then it protects nothing.
    #
    # Positive assertion — we require a hit, rather than requiring the absence
    # of a pattern. An earlier gate used a negative regex that matched nothing
    # at end-of-line and therefore passed on the exact regression it existed to
    # catch.
    refs=$(grep -rn --include="*.swift" "\b${name}\b" Promptly 2>/dev/null \
             | grep -vE ":[[:space:]]*(public |private |internal )?(struct|extension)[[:space:]]+${name}\b" \
             | wc -l | tr -d ' ')

    if [ "$refs" -eq 0 ]; then
      echo "  ORPHAN: ${name}  (declared in ${file}, referenced by nothing)"
      orphans=$((orphans + 1))
    fi
  done < <(grep -oE "^(public |private |internal )?struct [A-Za-z_][A-Za-z0-9_]*[[:space:]]*:[^{]*\bView\b" "$file" 2>/dev/null \
             | sed -E 's/^.*struct[[:space:]]+([A-Za-z_][A-Za-z0-9_]*).*$/\1/')
done < <(find "$VIEWS_DIR" -name "*.swift" -type f)

echo "reachability-gate: checked $checked View structs under $VIEWS_DIR"

if [ "$orphans" -gt 0 ]; then
  echo "reachability-gate: FAIL — $orphans View(s) compiled but called by nothing."
  echo "  A View with no caller is not 'behind a flag'. It is absent, and"
  echo "  flipping its flag will not produce it. Wire it or delete it."
  exit 1
fi

# A gate that cannot fail is not a gate. If the declaration scan matched
# nothing, the regex has drifted from the codebase and the pass is empty.
if [ "$checked" -eq 0 ]; then
  echo "reachability-gate: CANNOT READ — zero View structs matched. The scan is"
  echo "  broken, which is NOT the same as everything being reachable."
  exit 2
fi


# ── THE OFFER REVEAL IS ITS OWN SCREEN (ruled 2026-09-23) ────────────────────
# INVERTED, NOT DELETED, NOT BYPASSED. This block asserted the collapse — that
# OfferRevealView, ExitOfferLadder, the firing budget and exit_offer_shown were
# gone. The ruling reversed the collapse: the paywall stands alone and the
# introductory offer is a separate screen reached on decline or dismiss. So the
# same four symbols are asserted PRESENT, by the same method.
#
# Keeping the block inverted rather than removing it is the point. A gate that
# is deleted when the decision changes leaves nothing to stop the next
# accidental collapse; a gate that flips keeps the decision enforced in whatever
# direction it currently points, and its RED case proves which way it is facing.
REVEAL_FAIL=0
for sym in OfferRevealView ExitOfferLadder exit_offer_shown ExitOffer; do
  # CODE, not prose — unchanged from the version that asserted the absence. A
  # comment mentioning a symbol is not that symbol being wired up, and counting
  # it would let a tree full of history pass with no screen in it.
  hits=$(grep -rl --include='*.swift' "$sym" Promptly/ 2>/dev/null \
         | while read -r f; do grep -vE '^[[:space:]]*(//|///|\*)' "$f" \
             | grep -q "$sym" && echo "$f"; done | tr '\n' ' ')
  if [ -z "$hits" ]; then
    echo "  $sym is gone — the offer reveal was collapsed back into the paywall"; REVEAL_FAIL=1
  fi
done
if [ ! -f Promptly/Views/Onboarding/OfferRevealView.swift ]; then
  echo "  OfferRevealView.swift is missing from disk"; REVEAL_FAIL=1
fi
if ! grep -q "OfferRevealView" Promptly.xcodeproj/project.pbxproj 2>/dev/null; then
  echo "  OfferRevealView is not in the Xcode project — it would not compile in"; REVEAL_FAIL=1
fi
# PRESENT IS NOT THE SAME AS REACHED. The file existing and compiling proves
# nothing about a user ever seeing it; the ladder has to be raised from the two
# surfaces that own the decline path, or this is a screen with no door.
if ! grep -vE '^[[:space:]]*(//|///|\*)' Promptly/Views/AppShell.swift | grep -q "ExitOfferLadder("; then
  echo "  AppShell does not raise ExitOfferLadder — dismissing the paywall reaches nothing"; REVEAL_FAIL=1
fi
if ! grep -vE '^[[:space:]]*(//|///|\*)' Promptly/Views/Onboarding/OnboardingV2Flow.swift | grep -q "ExitOfferLadder("; then
  echo "  the funnel does not raise ExitOfferLadder — onboarding skips the offer"; REVEAL_FAIL=1
fi
# NOT CONJOINED. The ruling is that these are two screens; the reveal must not
# be drawn from inside the paywall's own body.
if grep -vE '^[[:space:]]*(//|///|\*)' Promptly/Views/TwoStepPaywall.swift | grep -q "OfferRevealView("; then
  echo "  TwoStepPaywall constructs OfferRevealView — that is the conjoined screen again"; REVEAL_FAIL=1
fi
# The intro arithmetic stayed in ProBenefits through the collapse and stays here:
# one definition, whichever screen shows it.
if ! grep -q "static func introPercentOff" Promptly/Views/ProBenefits.swift; then
  echo "  the intro percentage arithmetic is gone"; REVEAL_FAIL=1
fi
if [ "$REVEAL_FAIL" -ne 0 ]; then
  echo "reachability-gate: FAIL — offer reveal"
  exit 1
fi
echo "reachability-gate: the offer reveal is its own screen, raised from both decline paths."

echo "reachability-gate: PASS — every View under $VIEWS_DIR has at least one caller."
