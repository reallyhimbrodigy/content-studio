#!/bin/bash
# EVERY ACTION THAT NEEDS AN ACCOUNT MUST ASK FOR ONE.
#
# Deferred auth makes browsing free, which is only safe if the actions that
# write to a user's data stop and ask. The failure this locks out is not a 401 —
# it is SILENCE: signed out, `getValidToken()` returns nil, `authedRequest`
# returns nil, and ChatStore catches and prints. The message renders from local
# state, the user believes it is saved, and it is gone on relaunch.
#
# Three seams, asserted by name so one cannot be dropped while the flag stays on.
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 1
FAIL=0

# A FIXED WINDOW, NOT A BRACE-MATCHED RANGE.
#
# The first version used `awk /sig/,/^    }$/`, which ends at the first
# four-space closing brace after the signature. That is not the function's brace
# — any nested construct that happens to close at that indent truncates the
# range early, and the gate then reports the guard missing while it sits ten
# lines further down. It did exactly that after an unrelated header edit shifted
# the file: a red gate on correct code, which is the failure mode that teaches
# you to ignore gates.
#
# The seam must be near the TOP of the function anyway — that is the whole
# point, stopping before the message is accepted — so a window is both more
# robust and a better statement of the requirement.
check() { # file, function-regex, description, window
  local f="$1" fn="$2" desc="$3" win="${4:-40}"
  [ -f "$f" ] || { echo "  MISSING FILE $f"; FAIL=1; return; }
  local line
  line=$(grep -nE "$fn" "$f" | head -1 | cut -d: -f1)
  if [ -z "$line" ]; then echo "  $desc: function not found ($fn)"; FAIL=1; return; fi
  # Either entry point counts: `require` raises the gate directly, `allow` is
  # the guard form that returns false and raises it. The seam moved to `allow`
  # so it could be EXECUTED by a probe rather than only read by this gate, and
  # this gate went red on code the probe had just proven refuses — a stale
  # assertion is indistinguishable from a real failure at the moment you read it.
  if ! sed -n "${line},$((line + win))p" "$f" | grep -qE "AuthGate\.shared\.(require|allow)"; then
    echo "  $desc does not raise the auth gate within $win lines of its entry"
    FAIL=1
  fi
}

# DEFERRED AUTH GATES ONE SEAM: PURCHASE (ruled 2026-09-06). INVERTED from what
# this gate used to assert. Chat send, upload, render, re-edit and share all work
# on the anonymous session — so these two must NOT raise the gate, and the check
# is that the call is gone rather than that it is present.
absent() { # file, function-regex, description, window
  local f="$1" fn="$2" desc="$3" win="${4:-40}"
  [ -f "$f" ] || { echo "  MISSING FILE $f"; FAIL=1; return; }
  local line
  line=$(grep -nE "$fn" "$f" | head -1 | cut -d: -f1)
  if [ -z "$line" ]; then echo "  $desc: function not found ($fn)"; FAIL=1; return; fi
  if sed -n "${line},$((line + win))p" "$f" | grep -qE "AuthGate\.shared\.(require|allow)"; then
    echo "  $desc RAISES the auth gate — purchase is the only seam"
    FAIL=1
  fi
}
absent "Views/EditorView.swift"    "private func send\(\)"             "chat send"
absent "Views/MessageBubble.swift" "private func prepareGatedLocalFile" "export/share"

# And the gate itself must refuse to raise for anything but a purchase, so a new
# call site cannot reintroduce a seam by accident.
if ! grep -q "guard intent.isPurchase else { return true }" Services/AuthGate.swift; then
  echo "  AuthGate.allow no longer short-circuits non-purchase intents"
  FAIL=1
fi
if ! grep -q "guard intent.isPurchase else {" Services/AuthGate.swift; then
  echo "  AuthGate.require no longer drops non-purchase intents"
  FAIL=1
fi

# The purchase seam MUST still be there — removing it would let an anonymous
# device buy, which is the one thing deferred auth cannot allow.
if ! grep -q "AuthGate.shared.require" Services/SubscriptionService.swift; then
  echo "  the PURCHASE seam is gone — that is the one seam that must remain"
  FAIL=1
fi

# The autopicker must not fire for a signed-out user at all.
if ! awk '/func maybeAutoOpenPickerOnFirstSession/,/^    }$/' Views/EditorView.swift \
     | grep -q 'AuthService.shared.currentUser?.id != nil'; then
  echo "  the first-session autopicker does not require an account"
  FAIL=1
fi

# The gate itself must still exist and be presented somewhere.
grep -q "func require(" Services/AuthGate.swift || { echo "  AuthGate.require is gone"; FAIL=1; }
grep -q "func allow(" Services/AuthGate.swift || { echo "  AuthGate.allow is gone"; FAIL=1; }
grep -rq "authGate.isPresenting" --include="*.swift" . || { echo "  AuthGate is never presented"; FAIL=1; }
grep -rq "authGate.takePending()" --include="*.swift" . || { echo "  pending intent is never resumed"; FAIL=1; }

# ── THE LINK FALLBACK MUST MATCH A CASE, NOT A SENTENCE ──────────────────────
# GoTrue returns error_code=identity_already_exists in ONE parameter and a prose
# error_description ("Identity is already linked to another user") in another.
# The fallback matched the code against the description, so it never fired: a
# user with an existing Google identity saw the raw provider message instead of
# being signed in — the exact case the fallback exists for.
AV=Views/AuthView.swift
grep -q 'dict\["error_code"\]' "$AV" || {
  echo "  the OAuth callback no longer reads error_code"; FAIL=1; }
grep -q 'throw AuthService.OAuthLinkError.identityAlreadyExists' "$AV" || {
  echo "  an already-linked identity is no longer raised as a typed case"; FAIL=1; }
grep -q 'case AuthService.OAuthLinkError.identityAlreadyExists = error' "$AV" || {
  echo "  the link fallback matches on a string again, not the case"; FAIL=1; }
# CODE ONLY. The first version of this grepped the whole file, and the comment
# above the branch — which quotes GoTrue's message — satisfied it on its own.
# An assertion a comment can pass is not an assertion.
AV_CODE=$(grep -v '^[[:space:]]*//' "$AV")
grep -q 'desc.lowercased().contains("already linked")' <<< "$AV_CODE" || {
  echo "  the prose fallback for the same condition is gone"; FAIL=1; }

# ── A COMPLETED SIGN-IN CLOSES THE SHEET ─────────────────────────────────────
# The handler was `guard authed, let intent = takePending() else { return }` —
# so the ORDINARY sign-in, the one with nothing pending, returned and left the
# sheet up for the user to dismiss by hand. Purchase worked only because it
# always has an intent to replay.
SHELL_SRC=Views/AppShell.swift
grep -q "authGate.finish()" "$SHELL_SRC" || {
  echo "  a plain sign-in no longer closes the auth sheet"; FAIL=1; }
grep -q "func finish()" Services/AuthGate.swift || {
  echo "  AuthGate.finish is gone — cancel() would report a success as abandonment"; FAIL=1; }
AS_CODE=$(grep -v '^[[:space:]]*//' "$SHELL_SRC")
grep -q "guard authed, let intent = authGate.takePending() else { return }" <<< "$AS_CODE" && {
  echo "  the guard that swallowed the no-intent case is back"; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then echo "auth-seam-gate: FAIL"; exit 1; fi
echo "auth-seam-gate: PASS — purchase is the only seam; send and export do not raise"
exit 0
