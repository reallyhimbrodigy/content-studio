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
  if ! sed -n "${line},$((line + win))p" "$f" | grep -q "AuthGate.shared.require"; then
    echo "  $desc does not raise the auth gate within $win lines of its entry"
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
