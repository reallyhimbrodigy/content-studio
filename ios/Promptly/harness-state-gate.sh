#!/bin/bash
# Two harness cases with the same number is not a compile error — Swift takes
# the first and the second becomes unreachable. That failure is silent AND
# convincing: the harness still prints SNAPSHOT_SETTLED <n>, so the capture
# looks valid while showing a completely different screen. Cost one full
# build-boot-install-run cycle on 2026-09-01 before the absence of a second
# marker gave it away.
set -uo pipefail
F="$(dirname "$0")/Promptly/__PayoffSnapshotHarness.swift"
[ -f "$F" ] || { echo "harness-state-gate: MISSING $F"; exit 1; }
DUP=$(awk '/var body: some View/,0' "$F" | grep -oE '^ *case [0-9]+:' \
      | grep -oE '[0-9]+' | sort -n | uniq -d)
if [ -n "$DUP" ]; then
  echo "harness-state-gate: FAIL — duplicate snapshotState case(s): $(echo $DUP | tr '\n' ' ')"
  echo "  the LATER case is unreachable; renumber it."
  exit 1
fi
echo "harness-state-gate: PASS — no duplicate snapshotState cases"
exit 0
