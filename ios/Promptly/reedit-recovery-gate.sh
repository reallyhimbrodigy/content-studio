#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# reedit-recovery-gate.sh — A SENT CHANGE IS NEVER LOST, AND NEVER SENT TWICE.
#
# THE DEFECT THIS LOCKS OUT, found by driving the app against a server that
# answered 503 / 429 / 20s-latency on purpose:
#
#   A user types a change and sends it. The composer is cleared. The send fails
#   — a bad minute, not a refusal. The row was marked failed with NO retry flag,
#   so no button appeared. Even where a flag WAS set (the launch reconcile of an
#   orphaned queue does set one, under the copy "That change didn't get sent.
#   Tap to try it again."), `retryClosure` returned nil anyway, because it
#   demanded `cachedSourceUrl` and `cachedVibe` — fields only the UPLOAD path
#   ever sets. A re-edit has no source clip and no vibe; it is a sentence about
#   a video that already exists.
#
#   The card then fell past its "Try Again" branch — which tests
#   `cachedSourceUrl` too — into "Upload a new video", which discards the
#   change. So the copy promised a tap that did not exist, and the one button
#   offered threw the words away. Measured on the simulator: the words were on
#   screen and unreachable.
#
# AND THE OTHER DIRECTION. A flood loses RESPONSES, not necessarily work. A
# re-edit that 5xx'd or timed out at 20s may well have been created
# server-side. Only the queued and kept paths ever passed an idempotency key;
# an ordinary send — nearly all of them — passed nil, so no header was set at
# all. The webhook-race retry re-sent with that same nil while its own comment
# promised "retry the SAME key ... so the server still charges once". A retry
# without a key is a second job and a second charge.
#
# So both halves are asserted here, in the same gate, because either one alone
# is a trap: a retry button with no key double-charges, and a key with no
# button is never presented.
set -uo pipefail
cd "$(dirname "$0")"
E="Promptly/Views/EditorView.swift"
M="Promptly/Models/Models.swift"
B="Promptly/Views/MessageBubble.swift"
A="Promptly/Services/APIService.swift"
P="Promptly/Services/PresignResilience.swift"
fail=0
note() { echo "  FAIL — $1"; fail=1; }
for f in "$E" "$M" "$B" "$A" "$P"; do
  [ -f "$f" ] || { echo "  FAIL — missing $f (a failed read is not a pass)"; exit 1; }
done
# The body of sendReedit, so an assertion about the send cannot be satisfied by
# an identical line somewhere else in a 5000-line file.
send_body() { sed -n '/private func sendReedit(changeRequest:/,/^    private func mostRecentFinishedVideoJobId/p' "$E"; }
retry_body() { sed -n '/private func retryClosure(for message:/,/^    \/\/\/ Provides the cancel action/p' "$E"; }

echo "reedit-recovery-gate:"

# ── 1. ONE KEY PER INTENT, MINTED AT THE FIRST SEND ─────────────────────────
send_body | grep -Eq '^[[:space:]]*let key = idempotencyKey \?\? UUID\(\)\.uuidString' \
  && echo "  ok   — sendReedit mints a key when the caller has none" \
  || note "sendReedit does not mint an idempotency key — an ordinary send goes out with no header, and its retry is a second charge"

# NO send inside sendReedit may pass the raw optional parameter: that is the
# nil that produced the double-charge. Every send presents the minted `key`.
if send_body | grep -Eq '^[[:space:]]*idempotencyKey: idempotencyKey[,)]?[[:space:]]*$'; then
  note "a send in sendReedit still passes the raw optional \`idempotencyKey\` — nil for an ordinary send, so that attempt carries no key"
else
  echo "  ok   — every send in sendReedit presents the minted key"
fi

# ── 2. THE ROW REMEMBERS THE INTENT, ACROSS A RELAUNCH ──────────────────────
# The orphan case IS a relaunch, so a field that does not round-trip leaves the
# retry inert exactly where it is needed. Producer AND consumer, same gate.
for fld in reeditRequest reeditOriginalJobId reeditIdempotencyKey; do
  send_body | grep -Eq "^[[:space:]]*processingMsg\.$fld = " \
    || note "sendReedit does not stamp $fld on the row — a failed change has nothing to re-send from"
  grep -Eq "^[[:space:]]*self\.$fld = message\.$fld[[:space:]]*$" "$M" \
    || note "$fld is not written to StoredMessage — the intent dies at the app boundary"
  grep -Eq "^[[:space:]]*msg\.$fld = $fld[[:space:]]*$" "$M" \
    || note "$fld is not restored from StoredMessage — the intent dies on relaunch, which is the orphan case"
done
echo "  ok   — checked reeditRequest / reeditOriginalJobId / reeditIdempotencyKey stamp + both storage directions"

# ── 3. THE RETRY DOES NOT DEMAND UPLOAD-ONLY FIELDS ─────────────────────────
# Scoped to retryClosure, and ordered: the re-edit branch must come BEFORE the
# cachedSourceUrl guard, or the guard returns nil first and the branch is dead.
rb="$(retry_body)"
if ! printf '%s' "$rb" | grep -Eq '^[[:space:]]*if let request = message\.reeditRequest,'; then
  note "retryClosure has no re-edit branch — every failed change returns nil and shows no Try Again"
else
  reedit_ln=$(printf '%s\n' "$rb" | grep -nE '^[[:space:]]*if let request = message\.reeditRequest,' | head -1 | cut -d: -f1)
  guard_ln=$(printf '%s\n' "$rb" | grep -nE '^[[:space:]]*guard let cachedSourceUrl = message\.cachedSourceUrl,' | head -1 | cut -d: -f1)
  if [ -n "$guard_ln" ] && [ "$reedit_ln" -gt "$guard_ln" ]; then
    note "retryClosure's re-edit branch sits AFTER the cachedSourceUrl guard — the guard returns nil first, so the branch is unreachable"
  else
    echo "  ok   — retryClosure answers a re-edit before requiring upload-only fields"
  fi
  printf '%s' "$rb" | grep -Eq '^[[:space:]]*sendReedit\(changeRequest: request,' \
    && echo "  ok   — the re-edit retry re-sends the sentence" \
    || note "retryClosure's re-edit branch does not call sendReedit — the button would do nothing"
  printf '%s' "$rb" | grep -Eq '^[[:space:]]*idempotencyKey: key\)' \
    && echo "  ok   — the retry presents the row's original key, so a received send is not charged twice" \
    || note "the re-edit retry does not pass the stored key — a send whose response was lost would be charged again"
fi

# ── 4. THE CARD MUST OFFER THE RETRY, NOT A NEW UPLOAD ──────────────────────
# The bubble has its own copy of the cachedSourceUrl test. Widening retryClosure
# alone leaves the button hidden and the change discarded by the else-branch.
grep -Eq '^[[:space:]]*message\.cachedSourceUrl != nil \|\| message\.reeditRequest != nil,' "$B" \
  && echo "  ok   — the failure card shows Try Again for a re-edit" \
  || note "MessageBubble still gates Try Again on cachedSourceUrl alone — a failed change falls through to \"Upload a new video\", which discards it"

# ── 5. A TRANSIENT SEND FAILURE IS MARKED RETRYABLE ─────────────────────────
# Scoped to the generic catch in sendReedit. Asserted against the CLASSIFIER,
# not a bare `true`: a closed list that defaults to false keeps a genuine
# refusal from getting a button that could only fail again.
send_body | grep -Eq '^[[:space:]]*messages\[i\]\.isRetryable = PresignResilience\.isRetryableInfrastructure\(error\)' \
  && echo "  ok   — a transient send failure leaves a retryable row" \
  || note "sendReedit's catch does not set isRetryable from the classifier — a 503 leaves a dead row and the words must be retyped"

# ── 6. THE FLOOD SHAPES ARE ACTUALLY RECOGNISED ─────────────────────────────
# Both halves. A classifier case for an error nothing throws is inert, and an
# error thrown into a classifier that cannot see its status is the reason
# `.jobCreationFailed` could never be retried.
grep -Eq '^[[:space:]]*throw APIError\.reeditRefused\(status: status,' "$A" \
  && echo "  ok   — a non-200 re-edit throws its status, not a status-free string" \
  || note "reeditFromJob does not throw .reeditRefused — a 503 collapses into .jobCreationFailed, which no classifier can call transient"
sed -n '/static func isRetryableInfrastructure/,/^    }/p' "$P" | grep -Eq '\.reeditRefused\(let status, _\)' \
  && echo "  ok   — the classifier recognises a refused re-edit by status" \
  || note ".reeditRefused is not classified in isRetryableInfrastructure — the thrown status is read by nobody"

# ── 7. THE FLOOD HARNESS MUST NOT EXIST IN A SHIPPED BINARY ─────────────────
# The 503/429/latency cases are driven by pointing a DEBUG build at a local
# proxy with `-apiBase`. A launch argument that redirects every API call is a
# test affordance and nothing else: in a Release build it would let anything
# that can start the app send a user's uploads to a host of its choosing. So
# the override must sit inside #if DEBUG, and production must be the value the
# function returns when it does not fire.
base_decl="$(sed -n '/private let baseUrl/,/^    }()/p' "$A")"
if ! printf '%s' "$base_decl" | grep -Fq -- '-apiBase'; then
  echo "  ok   — no -apiBase override present"
else
  printf '%s' "$base_decl" | grep -Fq '#if DEBUG' \
    && echo "  ok   — the -apiBase override is inside #if DEBUG" \
    || note "the -apiBase override is NOT inside #if DEBUG — a shipped build would redirect every API call on a launch argument"
  printf '%s' "$base_decl" | grep -Eq '^[[:space:]]*return "https://usepromptly\.app"' \
    && echo "  ok   — production is the value returned when the override does not fire" \
    || note "the baseUrl declaration does not fall back to production"
fi

[ "$fail" = 0 ] && echo "reedit-recovery-gate: PASS" || echo "reedit-recovery-gate: FAIL"
exit "$fail"
