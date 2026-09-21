#!/usr/bin/env bash
# RED PROOF — the density gate BLOCKS A COMMIT, by exit code.
#
# Not "the gate prints FAIL". A real `git commit` against a planted failing
# verdict must be REFUSED, because the failure this proves against is a commit
# that landed while its own gate was red and nobody read the verdict line.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
ok=1
SB=scripts/scoreboard.js
BK=$(mktemp)
cp "$SB" "$BK"
restore() { cp "$BK" "$SB"; rm -f "$BK"; git reset -q HEAD -- "$SB" 2>/dev/null || true; git checkout -q -- "$SB" 2>/dev/null || true; }
trap restore EXIT

echo "RED PROOF — the pre-commit gate blocks, by exit code"

# BASELINE: the tree is green and a commit is ALLOWED.
if .githooks/pre-commit >/dev/null 2>&1; then
  echo "  baseline  the gate passes on the clean tree"
else
  echo "  MISS      baseline is not green — a red below would prove nothing"; ok=0
fi

# PLANT: turn the density block into a gate. This is the exact regression the
# smoke exists to catch — a threshold compared against the reference.
python3 - "$SB" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
# anchor by SEARCH, not by a retyped literal — the first version guessed the
# exact spacing, missed, and the proof then reported a red for a commit that was
# refused because nothing was staged.
import re
# the assignment lives INSIDE a for-statement, not at line start
m = re.search(r"^.*per25\[fam\] = .*$", s, re.M)
assert m, "ANCHOR NOT FOUND — refusing to plant, because a plant that does not apply proves nothing"
s = s[:m.end()] + "\n      if (per25[fam] < table[fam]) process.exit(3);   // PLANTED: a floor" + s[m.end():]
p.write_text(s)
PY

if grep -q "PLANTED: a floor" "$SB"; then
  echo "  plant     applied: the density block now compares against the reference and exits"
else
  echo "  MISS      the plant did not apply — a red below would be for the wrong reason"; ok=0
fi

# 1. the gate itself must go red
node lib/__smoke_density_is_not_a_gate.js >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ]; then echo "  RED ok    the density gate FAILS on the planted floor (exit $rc)"
else echo "  MISS      the gate passed a planted floor"; ok=0; fi

# 2. AND A REAL COMMIT MUST BE REFUSED. This is the leg that matters.
git add "$SB" >/dev/null 2>&1
out=$(git commit -m "planted floor — this commit must be refused" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && echo "$out" | grep -qi "BLOCKED by"; then
  echo "  RED ok    git commit REFUSED BY THE GATE (exit $rc)"
  echo "$out" | grep -i "BLOCKED by" | head -2 | sed 's/^/            /'
elif [ "$rc" -ne 0 ]; then
  # refused for SOME OTHER REASON — nothing staged, a bad message, a different
  # hook. That is not this proof passing.
  echo "  MISS      commit refused but NOT by the gate (exit $rc): $(echo "$out" | head -1)"; ok=0
else
  echo "  MISS      THE COMMIT LANDED. Undoing."; ok=0
  git reset -q --soft HEAD^ 2>/dev/null || true
fi
git reset -q HEAD -- "$SB" 2>/dev/null || true

# 3. GREEN: with the plant removed, a commit is allowed again.
cp "$BK" "$SB"
.githooks/pre-commit >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ]; then echo "  RED ok    [green] with the plant removed the gate passes again"
else echo "  MISS      the gate stayed red after the plant was removed"; ok=0; fi

# 4. the override exists, is loud, and is not the default
o=$(PROMPTLY_SKIP_LANE_GATES=1 .githooks/pre-commit 2>&1); rc=$?
if [ "$rc" -eq 0 ] && echo "$o" | grep -q "SKIPPED"; then
  echo "  RED ok    the override works and SAYS SO ($(echo "$o" | head -1 | cut -c1-58)...)"
else echo "  MISS      override missing or silent"; ok=0; fi

[ "$ok" -eq 1 ] && { echo "RED PROOF: PASS — a planted floor refuses the commit"; exit 0; }
echo "RED PROOF: FAIL"; exit 1
