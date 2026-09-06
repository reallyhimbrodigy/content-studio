#!/bin/bash
# THE WIDTH RULE (ruled 2026-09-06, final — this gate asserts it and does not
# change again):
#
#   Full-width on the phone  -> 88% of the iPad CONTAINER.
#   Fixed-width on the phone -> that width times k.
#   Heights, type, padding, radii, icons -> times k.
#
# k is 1 on a phone and windowLongSide/852 on an iPad, so a dimension written
# `X * k` satisfies the third line by construction. What this gate can read from
# source is that the dimensions ARE written that way, that the filling elements
# use the proportional rule rather than a column of their own invention, and
# that the thread's shape matches the reference.
#
# The pixel half is Scripts/overlay_check.py, which needs captures: it divides
# the iPad by k and requires every block to land on the phone's, and checks the
# filling width against the rule rather than against the phone times k.
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 2
FAIL=0
say() { printf "  %-54s %s\n" "$1" "$2"; }
bad() { say "$1" "FAIL — $2"; FAIL=1; }

code() { grep -vE '^[[:space:]]*(//|///)' "$1"; }

# 1. Filling elements use the proportional rule. A fixed column (the 635pt one)
#    or a bare .infinity would both be a different layout, not a scaled one.
CC=$(code Views/ConversionColumn.swift)
grep -q "hSize == .regular ? .infinity : phoneCap" <<<"$CC" \
  && say "1. thread fills on regular, phone cap on compact" "PASS" \
  || bad "1. thread fills on regular, phone cap on compact" "ThreadFill no longer follows the rule"
grep -q "ThreadColumn.width(k)" <<<"$(code Views/EditorView.swift)" \
  && bad "1b. no scaled-phone column" "the 393*k column is back — that is not the width rule" \
  || say "1b. no scaled-phone column" "PASS"

# 2. The video is an attachment, not the thread.
grep -q "0.55 \* ConversionColumn.phoneReferenceHeight \* k" <<<"$CC" \
  && say "2. video capped at 55% of the viewport" "PASS" \
  || bad "2. video capped at 55% of the viewport" "the height cap is gone"

# 3. The thread's shape: user bubble in the accent, assistant plain, no mark.
MB=$(code Views/MessageBubble.swift)
grep -q "userAccent" <<<"$MB" \
  && say "3. user bubble takes the accent" "PASS" \
  || bad "3. user bubble takes the accent" "the bubble is grey again"
grep -q "PromptlyMark" <<<"$MB" \
  && bad "3b. no mark on assistant messages" "the mark is back" \
  || say "3b. no mark on assistant messages" "PASS"
grep -q "assistantActionRow" <<<"$MB" \
  && say "3c. per-message action row" "PASS" \
  || bad "3c. per-message action row" "copy/thumbs/share row is gone"

# 4. Every dimension scales. A bare font size in the thread or the ring is a
#    phone-sized part on a scaled layout.
for f in Views/MessageBubble.swift Views/RenderProgressRing.swift Views/FirstRunHero.swift; do
  if grep -qE "\.font\(\.system\(size: [0-9]+[,)]" <<<"$(code $f)"; then
    bad "4. every dimension scales" "an unscaled font size in $(basename $f)"
  fi
done
grep -qE "\.font\(\.system\(\.body" <<<"$(code Views/EditorView.swift)" \
  && bad "4b. composer text scales" "a Dynamic Type style is back in the composer" \
  || say "4b. composer text scales" "PASS"
[ $FAIL -eq 0 ] && say "4. every dimension scales" "PASS"

# 5. No chips inside the composer — the suggestion rows above it are the
#    suggestions, and their absence is what makes it one row.
grep -q "vibeChipRow" <<<"$(code Views/EditorView.swift)" \
  && bad "5. no chips in the composer" "the chip row is back inside the composer" \
  || say "5. no chips in the composer" "PASS"

[ $FAIL -eq 0 ] && echo "✓ ipad thread gate: the width rule holds" \
                || echo "✗ ipad thread gate FAILED"
exit $FAIL
