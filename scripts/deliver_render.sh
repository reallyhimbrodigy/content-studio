#!/bin/zsh
# THE ONLY SANCTIONED WAY TO PUT AN MP4 IN ~/Desktop/Promptly Reports/.
#
# Gates first, copies second. The doubled-captions render and the shipped-nothing
# render both reached the owner's eye when four sampled frames would have caught
# them, and the gate costs nothing per run.
#
#   deliver_render.sh <render.mp4> [NAME_IN_REPORTS.mp4]
#
# exit 0 = gated clean AND delivered
# exit 1 = gate FAILED, NOT delivered (override: PROMPTLY_DELIVER_ANYWAY=1)
# exit 2 = could not run — NOT delivered
#
# The override exists because a FAILED GATE IS SOMETIMES THE POINT: sending the
# owner a render precisely because it is wrong is legitimate. It must be
# deliberate, and it is recorded in the delivery note either way.
set -uo pipefail
# SELF-LOCATING. This was an absolute path into .worktrees/lane-judge — so
# the delivery law depended on an unmerged worktree continuing to exist.
# ${0:A:h} is the script's own directory (zsh), so the closure travels with
# the repo and a checkout anywhere works.
LANE="${0:A:h}"
DEST="$HOME/Desktop/Promptly Reports"
SRC="${1:-}"; NAME="${2:-$(basename "${SRC:-render.mp4}")}"
[[ -f "$SRC" ]] || { echo "DELIVER: ❌ no such file: ${SRC:-<none>} — NOT delivered"; exit 2; }
mkdir -p "$DEST"

bash "$LANE/prereport_render.sh" "$SRC"; gate=$?
note="$DEST/${NAME%.mp4}__GATE.txt"
{ echo "gate run: $(date -u +%FT%TZ)"; echo "artifact: $NAME"; echo "exit: $gate"; } > "$note"

if [[ $gate -ne 0 && "${PROMPTLY_DELIVER_ANYWAY:-}" != "1" ]]; then
  echo
  echo "DELIVER: ❌ GATE FAILED (rc=$gate) — NOT copied to Promptly Reports."
  echo "  Triage: BROKEN DIMENSION or BROKEN ARTIFACT? Never assume the artifact."
  echo "  To send it anyway (legitimate when the point IS the defect):"
  echo "    PROMPTLY_DELIVER_ANYWAY=1 deliver_render.sh \"$SRC\" \"$NAME\""
  echo "  gate note written: $note"
  exit 1
fi
cp "$SRC" "$DEST/$NAME"
[[ $gate -ne 0 ]] && echo "OVERRIDE USED — delivered despite a failing gate (recorded in $note)"
echo "DELIVER: ✅ $NAME -> Promptly Reports (gate rc=$gate)"
exit 0
