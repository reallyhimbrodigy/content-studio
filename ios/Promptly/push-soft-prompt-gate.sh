#!/bin/bash
# push-soft-prompt-gate.sh — makes the permanent-flag regression impossible.
#
# THE DEFECT. `shouldOfferSoftPrompt` was `!hasAskedForPermission &&
# !didOfferSoftPrompt`, and BOTH alert buttons called markSoftPromptOffered().
# So one "Not now" — a deferral — set a permanent flag and the app never asked
# again. 1,056 users have no push token because of it. The delivery primer built
# to re-ask them guarded on that same flag, so it was dead for exactly the
# population it existed to recover, and it called markSoftPromptOffered() on the
# way IN, spending the future merely by appearing.
#
# Four assertions, each RED-proved by mutation. Comments are stripped before
# matching — a gate that greps raw source flags the paragraph explaining the
# defect it guards against, which has bitten this repo twice.
# NO `pipefail` HERE, deliberately. With it, `strip f | grep -q X` reports
# FAILURE on a successful match: grep -q exits the moment it matches, sed takes
# SIGPIPE, and pipefail returns the rightmost non-zero. This gate's third
# assertion read as broken while the code was correct — the instrument lying
# about its own plumbing, which is the failure this whole lane has been about.
# Content is stripped ONCE into variables below and matched with grep on stdin.
set -u
cd "$(dirname "$0")"
fail=0
say() { printf '  %s %s\n' "$1" "$2"; }

strip() { sed -e 's://.*::' "$1" | tr '\n' '\0' | sed -e 's:/\*[^*]*\**\([^/*][^*]*\**\)*/::g' | tr '\0' '\n'; }
has() { printf '%s' "$1" | grep -q "$2"; }

POLICY=Promptly/Services/SoftPromptPolicy.swift
PUSH=Promptly/Services/PushService.swift
EDITOR=Promptly/Views/EditorView.swift
PRIMER=Promptly/Views/PushPrimerView.swift

# 1. The predicate must not read the offered flag as a bar.
S_PUSH=$(strip "$PUSH"); S_EDITOR=$(strip "$EDITOR"); S_PRIMER=$(strip "$PRIMER")
PRED=$(printf '%s' "$S_PUSH" | grep -A3 'var shouldOfferSoftPrompt' || true)
if has "$PRED" 'didOfferSoftPrompt'; then
  say "✗" "shouldOfferSoftPrompt reads didOfferSoftPrompt again — that flag is set by a DEFERRAL and would silence the app forever"; fail=1
else
  say "✓" "the predicate does not treat the offered flag as a permanent bar"
fi

# 2. A decline must record a DATE, not just a flag.
DECL=$(printf '%s' "$S_PUSH" | grep -A8 'func recordSoftPromptDeclined' || true)
if has "$DECL" 'retryAfterKey'; then
  say "✓" "a decline writes a retry date"
else
  say "✗" "recordSoftPromptDeclined does not write a retry date — 'Not now' is permanent again"; fail=1
fi

# 3. Accept and decline must not be the same call.
for pair in "EditorView:$S_EDITOR" "PushPrimerView:$S_PRIMER"; do
  name=${pair%%:*}; body=${pair#*:}
  if has "$body" 'markSoftPromptOffered'; then
    say "✗" "$name still calls markSoftPromptOffered — an offer with no outcome is what caused this"; fail=1
  fi
done
if has "$S_EDITOR" 'recordSoftPromptAccepted' && has "$S_EDITOR" 'recordSoftPromptDeclined'; then
  say "✓" "the alert's two buttons record two different outcomes"
else
  say "✗" "the alert does not record accept and decline separately"; fail=1
fi

# 4. There must be a look-point AFTER the first render, or the expiry is inert.
#    This is the assertion that would have caught the original design: the flag
#    could have been a date from day one and nothing would have changed, because
#    both existing call sites fire around a user's FIRST render.
if grep -rq 'maybeOfferSoftPromptAfterExport' Promptly/Views/MessageBubble.swift; then
  say "✓" "the re-ask is wired to a post-export moment, so an expired deferral is actually looked at"
else
  say "✗" "nothing looks again after an export — an expiring flag with no later look-point changes nothing"; fail=1
fi

# 5. The policy's own unit test must pass.
if command -v swiftc >/dev/null 2>&1; then
  out=$(swiftc -o /tmp/__soft_prompt_policy_test "$POLICY" __test_soft_prompt_policy.swift 2>&1) \
    && /tmp/__soft_prompt_policy_test >/dev/null 2>&1 \
    && say "✓" "SoftPromptPolicy unit test passes (re-ask, escalation, cap, legacy recovery)" \
    || { say "✗" "SoftPromptPolicy unit test FAILED"; /tmp/__soft_prompt_policy_test 2>&1 | head -5; fail=1; }
else
  say "!" "swiftc unavailable — policy unit test SKIPPED (not a pass)"
fi

if [ "$fail" -ne 0 ]; then echo "push-soft-prompt-gate: FAIL"; exit 1; fi
echo "push-soft-prompt-gate: PASS"
