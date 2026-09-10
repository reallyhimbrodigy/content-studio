#!/usr/bin/env bash
# A CLIENT SAVE MAY NOT BLIND-OVERWRITE THE MESSAGES COLUMN.
#
# WHY (measured 2026-09-09, 16 of 16 with no exceptions). updateChat PATCHed
# `{"messages": <entire array>}` against `?id=eq.<id>`. The server attaches a
# render's assistant message with CAS, correctly; the client then wrote back an
# array that predated the attach and the message was gone. The PATCH returned
# 200, the job stayed completed with a rendered_video_url, and the only trace
# was a jobId appearing in no chat. Every one of the sixteen had a client write
# to that user's chats AFTER the render completed.
#
# Two of them made it visible: a server-created chat holding ZERO messages, and
# one holding twenty with the render not among them.
set -uo pipefail
cd "$(dirname "$0")"
FAIL=0
CS=Promptly/Services/ChatService.swift
ST=Promptly/Services/ChatStore.swift
MG=Promptly/Services/ChatMessageMerge.swift
for f in "$CS" "$ST" "$MG"; do [ -f "$f" ] || { echo "  missing $f"; exit 1; }; done
strip() { sed -E 's://.*::' "$1"; }
CSB=$(strip "$CS"); STB=$(strip "$ST"); MGB=$(strip "$MG")

# 1. THE SAVE READS BEFORE IT WRITES, AND MERGES.
U=$(awk '/func updateChat\(/,/^    }$/' <<< "$CSB")
grep -q "fetchChatRow(id: id)" <<< "$U" || {
  echo "  updateChat no longer reads the row before writing it"; FAIL=1; }
grep -q "ChatMessageMerge.merged(" <<< "$U" || {
  echo "  updateChat no longer merges — it is a blind overwrite again"; FAIL=1; }

# 2. AND WRITES UNDER A CAS. Read-merge-write alone only narrows the window,
#    and the sweep re-issues the server's attach every ten minutes, so a narrow
#    window is one that gets hit.
grep -q "ifUpdatedAt: current.updatedAt" <<< "$U" || {
  echo "  the write is not conditioned on the row it merged against"; FAIL=1; }
P=$(awk '/private func patchChat\(/,/^    }$/' <<< "$CSB")
grep -q "updated_at=eq." <<< "$P" || {
  echo "  the PATCH carries no updated_at precondition"; FAIL=1; }
grep -q "return=representation" <<< "$P" || {
  echo "  the PATCH cannot tell a lost CAS from a success — PostgREST answers a"
  echo "  match-nothing PATCH with 200 and [], the same empty-success shape that"
  echo "  hid this class in the first place"; FAIL=1; }

# 3. AND IT DOES NOT FALL BACK TO THE BLIND WRITE. Falling back under
#    contention is falling back exactly when it matters.
grep -qE 'catch.*patchChat|try\? await patchChat' <<< "$U" && {
  echo "  updateChat swallows a failed CAS instead of re-merging or throwing"; FAIL=1; }

# 4. THE MERGE BASE EXISTS AND IS FED FROM BOTH SIDES. Without `seen` the merge
#    is a union, and a union resurrects every message the user ever deleted.
grep -q "private var seenMessageIds" <<< "$STB" || {
  echo "  ChatStore keeps no seen-set — the merge cannot tell a delete from"
  echo "  staleness, so it would resurrect deleted messages"; FAIL=1; }
SEEN=$(grep -c "noteSeen(" <<< "$STB")
[ "$SEEN" -ge 4 ] || {
  echo "  noteSeen is called $SEEN time(s); expected at least 4 (its definition,"
  echo "  the server load, the local compose, and after a successful write)"; FAIL=1; }
grep -q "seen: seenMessageIds\[chatId\] ?? \[\]" <<< "$STB" || {
  echo "  the save does not pass the seen-set, so the merge runs blind"; FAIL=1; }

# 5. THE RULE ITSELF STILL DISTINGUISHES THE TWO ABSENCES.
grep -q "!localIds.contains(\$0.id) && !seen.contains(\$0.id)" <<< "$MGB" || {
  echo "  the merge no longer separates 'never saw it' from 'removed it'"; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then echo "chat-save-merge-gate: FAIL"; exit 1; fi
echo "chat-save-merge-gate: PASS — the save reads, merges, and writes under a CAS;"
echo "                    a delete stays deleted and an unseen message survives."
exit 0
