#!/usr/bin/env bash
# THE PIPE RULE, MADE MECHANICAL.
#
# `cmd | tail` reports TAIL's exit status, not cmd's. This lane has now hit it
# twice: a census printed FAIL while the shell said 0, and an ECONNRESET killed
# a 413-row run that was reported as exit 0. Builder-1's lane hit it once more.
# Third instance across two lanes in a week; the fix is a wrapper, not care.
#
# Usage:  run_checked.sh <logfile> <cmd> [args...]
# The command's output goes to the log AND to the terminal, and the exit code
# that leaves this script is the COMMAND's, never tee's.
set -euo pipefail

log="$1"; shift
[ -n "$log" ] || { echo "run_checked.sh: no logfile given" >&2; exit 2; }

# THE VERDICT IS READ FROM A FILE, not from a pipeline's status. `set -o
# pipefail` alone would be enough here, but writing the status down makes the
# verdict inspectable after the fact and survives being called from a shell
# that does not have pipefail set.
status_file="${log}.status"
rm -f "$status_file"

set +e
( "$@"; echo "$?" > "$status_file" ) 2>&1 | tee "$log"
set -e

if [ ! -f "$status_file" ]; then
  echo "run_checked.sh: NO STATUS WRITTEN — the command did not complete far enough to record one. Treating as failure, because an absent verdict is not a pass." >&2
  exit 3
fi
rc="$(cat "$status_file")"
[ -n "$rc" ] || { echo "run_checked.sh: status file empty — treating as failure" >&2; exit 3; }
exit "$rc"
