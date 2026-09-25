#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# dispatch-window-gate.sh — A BUBBLE IS NOT A CORPSE BEFORE IT IS BORN.
#
# THE LOGGED SEQUENCE, on a 45 MB clip, free account, build 266:
#   t+0.4s   source upload done (accelerated)
#   t+0.6s   [reconcile] ee24ec73 row missing — terminalizing (wasProcessing=true)
#   t+12.2s  both uploads done
#   t+12.4s  POST /api/video-jobs -> 402   (the free cap)
#
# The client mints the job id at SEND so it survives a relaunch mid-upload, and
# POST /api/video-jobs does not happen until the uploads finish. For that whole
# window there has never been a row to find — and the reconciler read its
# absence as "This render expired on our side — you weren't charged", which
# states a refund for a job that was never created. The refusal that arrived
# 12 seconds later then had nothing to attach to.
#
# The registry that exists to prevent exactly this was populated only INSIDE
# dispatch(), which is entered after the uploads. It could not cover the window
# it was written for.
set -uo pipefail
cd "$(dirname "$0")"
E="Promptly/Views/EditorView.swift"
M="Promptly/Models/Models.swift"
J="Promptly/Services/JobDispatchCoordinator.swift"
fail=0
note() { echo "  FAIL — $1"; fail=1; }
for f in "$E" "$M" "$J"; do
  [ -f "$f" ] || { echo "  FAIL — missing $f (a failed read is not a pass)"; exit 1; }
done

echo "dispatch-window-gate:"

# ── (a) LIVE FROM THE MOMENT THE ID EXISTS, NOT FROM dispatch() ────────────
grep -Eq '^[[:space:]]*JobDispatchCoordinator\.shared\.markActive\(processingMsg\.jobId\)' "$E" \
  && echo "  ok   — the client job id is registered live at mint, before any upload" \
  || note "nothing registers the job id before the uploads — the registry only covers dispatch(), which is entered 12s later, so the whole upload window is unprotected"

# The registration must sit immediately after the mint; a gap is a window.
mint_ln=$(grep -n 'processingMsg\.jobId = UUID()\.uuidString\.lowercased()' "$E" | head -1 | cut -d: -f1)
mark_ln=$(grep -n 'JobDispatchCoordinator\.shared\.markActive(processingMsg\.jobId)' "$E" | head -1 | cut -d: -f1)
if [ -n "$mint_ln" ] && [ -n "$mark_ln" ] && [ "$mark_ln" -gt "$mint_ln" ] && [ $((mark_ln - mint_ln)) -le 6 ]; then
  echo "  ok   — registered immediately after the mint (line $mint_ln -> $mark_ln)"
else
  note "the registration is not immediately after the mint (mint=$mint_ln mark=$mark_ln) — the gap between them is the window this gate exists to close"
fi
grep -Eq '^[[:space:]]*func clearActive\(' "$J" \
  && echo "  ok   — there is a clearActive for the exit paths" \
  || note "JobDispatchCoordinator has no clearActive — an id registered before the upload would never be removed on a failed or cancelled send"

# ── (b) "ROW MISSING" NEEDS A SERVER-CONFIRMED ID TO MEAN ANYTHING ────────
grep -Eq '^[[:space:]]*var serverJobConfirmed: Bool = false' "$M" \
  && echo "  ok   — the message records whether the server ever acknowledged this id" \
  || note "there is no serverJobConfirmed — nothing distinguishes 'the row is gone' from 'the job was never POSTed'"
# PERSISTED, or a relaunch mid-upload loses the distinction entirely.
grep -Eq '^[[:space:]]*self\.serverJobConfirmed = message\.serverJobConfirmed \? true : nil' "$M" \
  && grep -Eq '^[[:space:]]*msg\.serverJobConfirmed = serverJobConfirmed \?\? false' "$M" \
  && echo "  ok   — and it round-trips through storage, so a relaunch keeps it" \
  || note "serverJobConfirmed does not round-trip through StoredMessage — after a relaunch every bubble would look unconfirmed"
recon="$(sed -n '/row missing — terminalizing/,+0p;/guard messages\[idx\]\.serverJobConfirmed else {/,+3p' "$E")"
grep -Fq 'guard messages[idx].serverJobConfirmed else {' "$E" \
  && echo "  ok   — the reconciler will not terminalize an unconfirmed id" \
  || note "the reconciler still terminalizes on a missing row without checking serverJobConfirmed — it will kill bubbles mid-upload again"
# The confirmation must actually be set, or the guard never opens.
grep -Fq 'messages[i].serverJobConfirmed = true' "$E" \
  && echo "  ok   — confirmed when the server hands back a job id" \
  || note "nothing sets serverJobConfirmed on dispatch success — the guard would then block every terminalization forever, including real corpses"
grep -Fq 'messages[idx].serverJobConfirmed = true' "$E" \
  && echo "  ok   — and when a row decodes on the poll" \
  || note "nothing sets serverJobConfirmed when a row decodes — a restored bubble whose job is real could never be terminalized"

[ "$fail" = 0 ] && echo "dispatch-window-gate: PASS" || echo "dispatch-window-gate: FAIL"
exit "$fail"
