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

check() { # file, function-regex, description
  local f="$1" fn="$2" desc="$3"
  [ -f "$f" ] || { echo "  MISSING FILE $f"; FAIL=1; return; }
  local body
  body=$(awk "/$fn/,/^    }$/" "$f")
  if [ -z "$body" ]; then echo "  $desc: function not found ($fn)"; FAIL=1; return; fi
  if ! echo "$body" | grep -q "AuthGate.shared.require"; then
    echo "  $desc does not raise the auth gate"
    FAIL=1
  fi
}

check "Views/EditorView.swift"    "private func send\(\)"             "chat send"
check "Views/MessageBubble.swift" "private func prepareGatedLocalFile" "export/share"

# The autopicker must not fire for a signed-out user at all.
if ! awk '/func maybeAutoOpenPickerOnFirstSession/,/^    }$/' Views/EditorView.swift \
     | grep -q 'AuthService.shared.currentUser?.id != nil'; then
  echo "  the first-session autopicker does not require an account"
  FAIL=1
fi

# The gate itself must still exist and be presented somewhere.
grep -q "func require(" Services/AuthGate.swift || { echo "  AuthGate.require is gone"; FAIL=1; }
grep -rq "authGate.isPresenting" --include="*.swift" . || { echo "  AuthGate is never presented"; FAIL=1; }
grep -rq "authGate.takePending()" --include="*.swift" . || { echo "  pending intent is never resumed"; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then echo "auth-seam-gate: FAIL"; exit 1; fi
echo "auth-seam-gate: PASS — send, export and the autopicker all require an account"
exit 0
