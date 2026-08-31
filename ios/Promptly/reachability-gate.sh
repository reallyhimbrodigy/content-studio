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

echo "reachability-gate: PASS — every View under $VIEWS_DIR has at least one caller."
