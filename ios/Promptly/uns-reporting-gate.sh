#!/bin/bash
# uns-reporting-gate.sh — THE SILENT-CLASS CHECK (2026-08-28).
#
# THE DEFECT THIS LOCKS OUT:
#   593 distinct users tapped upload and never produced a video_jobs row. Only
#   120 of them emitted ANY error event. 473 — 80% — emitted nothing at all.
#   The largest failure class in the product was silent by construction, and so
#   it was simultaneously the biggest and the only one nobody could describe.
#
#   It is silent because a video_jobs row is created at SEND time. Anything that
#   dies before that leaves no server-side trace at all: no job, no row, no
#   worker involvement. No amount of worker-side classification can name it.
#   (Worker counterpart: `no_subcode` — a class that never routes through _e().)
#
# THE RULE:
#   Every path that STARTS an upload must open an outcome record, and the only
#   path that RESOLVES one is a created job row. A new pick path added without a
#   record silently re-opens the blind spot — the code would look complete and
#   the class would simply stop being counted.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DIR/Promptly"
REPORTER="$SRC/Services/UploadOutcomeReporter.swift"
fail=0

[ -f "$REPORTER" ] || { echo "uns-reporting: FAILED — UploadOutcomeReporter.swift is missing."; exit 1; }

# ── 1. every upload_started emitter opens a record ───────────────────────────
while IFS= read -r f; do
  if grep -q 'Analytics.track("upload_started")' "$f"; then
    if ! grep -q 'UploadOutcomeReporter.shared.recordPick' "$f"; then
      echo "UNREPORTED PICK  $(basename "$f") starts an upload but opens no outcome record."
      echo "                 A pick with no record is invisible when it fails to become a job."
      fail=1
    fi
  fi
done < <(find "$SRC" -name '*.swift')

# ── 2. the record is closed ONLY by a real job row ───────────────────────────
if ! grep -rq 'UploadOutcomeReporter.shared.recordDispatched' "$SRC/Services/JobDispatchCoordinator.swift"; then
  echo "NO RESOLUTION    JobDispatchCoordinator never calls recordDispatched — every"
  echo "                 pick would be reported as unresolved, including the successes."
  fail=1
fi

# ── 3. the sweep actually runs ───────────────────────────────────────────────
# A ledger nobody reads is not instrumentation.
if ! grep -rq 'UploadOutcomeReporter.shared.sweepOnLaunch' "$SRC"; then
  echo "NO SWEEP         sweepOnLaunch() is never called; records accumulate and"
  echo "                 nothing is ever reported."
  fail=1
fi

# ── 4. the report must SPLIT the class, not just count it ────────────────────
# This is the whole point. "No job row" spans an upload that DIED (transport,
# ours) and an upload that SUCCEEDED and was never sent (intent, a different
# fix in a different subsystem). A count that merges them answers no question
# and would aim the next week of work at the wrong place.
for required in uploaded_never_sent died_in_transfer died_before_transfer unclassified; do
  if ! grep -q "$required" "$REPORTER"; then
    echo "LOST SPLIT       the subcode '$required' is gone from the reporter."
    echo "                 Without it the silent class collapses back to one unnameable blob."
    fail=1
  fi
done

# ── 5. the emit keeps the worker's key shape ─────────────────────────────────
# So a two-codebase census can union client and worker rows on one key. The
# worker returns error_code / error_subcode / error_cause="CODE:subcode".
for k in '"error_code"' '"error_subcode"' '"error_cause"'; do
  if ! grep -q -- "$k" "$REPORTER"; then
    echo "SHAPE DRIFT      the emit is missing $k — the client rows can no longer be"
    echo "                 unioned with the worker's terminals in one census."
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "uns-reporting: FAILED — the dominant failure class can go silent again."
  exit 1
fi

echo "uns-reporting: PASS — every upload path is accounted for, and the report splits transport from intent."
exit 0
