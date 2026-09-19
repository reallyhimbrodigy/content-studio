#!/usr/bin/env bash
# RED PROOF — a failing command behind a tee must stop the script.
#
# Plants a verdict that FAILS, runs it through the wrapper, and requires a
# non-zero exit. Without the wrapper the same shape exits 0, which is exactly
# how two wrong "PASS" readings got reported in this lane.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
ok=1

# ── the bug, demonstrated: naked pipe reports tee's status ──────────────────
# pipefail must be OFF here or this script's own setting hides the very bug it
# is demonstrating — which it did on the first run, and the leg read MISS for
# the right reason. The default shell a careless caller uses has it off.
set +o pipefail
( exit 7 ) 2>&1 | tee "$tmp/naked.log" >/dev/null
naked=$?
set -o pipefail
if [ "$naked" -eq 0 ]; then
  echo "  CONFIRMED  a failing command behind a bare pipe reports exit 0 (the bug)"
else
  echo "  MISS       expected the bare pipe to hide the failure, got $naked"; ok=0
fi

# ── leg 1: the wrapper must propagate a failure ─────────────────────────────
"$here/run_checked.sh" "$tmp/fail.log" false >/dev/null 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then echo "  RED ok     a failing command through run_checked.sh exits $rc"
else echo "  MISS       run_checked.sh swallowed a failure"; ok=0; fi

# ── leg 2: the exact code, not merely non-zero ──────────────────────────────
"$here/run_checked.sh" "$tmp/seven.log" bash -c 'exit 7' >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 7 ]; then echo "  RED ok     the COMMAND's code survives (7), not tee's"
else echo "  MISS       expected 7, got $rc"; ok=0; fi

# ── leg 3 (GREEN): a passing command must still pass, and still log ─────────
"$here/run_checked.sh" "$tmp/pass.log" bash -c 'echo hello; exit 0' >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 0 ] && grep -q hello "$tmp/pass.log"; then
  echo "  RED ok     [green] a passing command exits 0 AND its output reached the log"
else echo "  MISS       green leg failed: rc=$rc"; ok=0; fi

# ── leg 4: an ABSENT verdict is a failure, never a pass ─────────────────────
"$here/run_checked.sh" "$tmp/killed.log" bash -c 'kill -9 $$' >/dev/null 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then echo "  RED ok     a command killed before writing a status fails ($rc), not passes"
else echo "  MISS       an absent verdict read as a pass"; ok=0; fi

if [ "$ok" -eq 1 ]; then echo "PIPE RULE: PASS — 4 legs, 1 green"; exit 0; fi
echo "PIPE RULE: FAIL"; exit 1
