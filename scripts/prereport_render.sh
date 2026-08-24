#!/bin/zsh
# PRE-REPORT GATE for any render BUILDER is about to report.
#
# Runs BOTH instruments over one artifact and prints one verdict block:
#   1. score_component.py  — reference-calibrated dimensions (canvas, audio,
#                            motion density, stillness, palette)
#   2. visual_critic.py    — ART_DIRECTION properties (palette hold, caption
#                            centroid, layered-type observation, beat proxy)
#
# CONTRACT — exit codes, never text (this lane's standing rule):
#   0 = all applicable checks passed
#   1 = at least one applicable check FAILED
#   2 = could not run (missing file / missing tool) — NOT a pass
#
# PROVENANCE DEFAULTS TO BUILD-LANE. Pass --production ONLY for a real
# video_jobs row. A build-lane render scores QUALITY and never closes a
# [BUILT-NOT-WIRED] entry.
#
# THIS IS AN AID TO THE OWNER'S EYE. Green means the objectively checkable
# defects are absent — it does not mean the edit is good, and the unmeasurable
# properties print on every run precisely so their absence is never read as a pass.
set -uo pipefail
# SELF-LOCATING. This was an absolute path into .worktrees/lane-judge — so
# the delivery law depended on an unmerged worktree continuing to exist.
# ${0:A:h} is the script's own directory (zsh), so the closure travels with
# the repo and a checkout anywhere works.
LANE="${0:A:h}"
V="${1:-}"; shift 2>/dev/null || true
if [[ -z "$V" || ! -f "$V" ]]; then
  echo "PRE-REPORT: ❌ cannot run — no such file: ${V:-<none>}"
  echo "  usage: prereport_render.sh <render.mp4> [--production]"
  exit 2
fi
command -v ffmpeg >/dev/null 2>&1 || { echo "PRE-REPORT: ❌ ffmpeg absent — NOT a pass (exit 2)"; exit 2; }

echo "════════ PRE-REPORT GATE — $(basename "$V") ════════"
python3 "$LANE/score_component.py" full_edit "$V" "$@"; rc1=$?
python3 "$LANE/visual_critic.py" "$V"; rc2=$?

echo
echo "════════ VERDICT ════════"
if [[ $rc1 -eq 0 && $rc2 -eq 0 ]]; then
  echo "PASS — every APPLICABLE check passed."
  echo "  This is not 'the edit is good'. It is 'the checkable defects are absent'."
  echo "  The unmeasurable properties above are the owner's call and were NOT scored."
  exit 0
fi
echo "FAIL — at least one applicable check failed (scorecard rc=$rc1, critic rc=$rc2)."
echo "  Triage before reporting: BROKEN DIMENSION or BROKEN ARTIFACT? Never assume the artifact."
exit 1
