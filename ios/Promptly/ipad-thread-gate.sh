#!/bin/bash
# THE IPAD CHAT IS THE IPHONE CHAT, SCALED (ruled 2026-09-05).
#
# That is the whole rule, so it is checkable in one line of reasoning: a view in
# the chat must not ask what size class it is in. Every dimension is written as
# `X * k`, k is 1 on a phone and windowLongSide/852 on an iPad, and the result is
# the phone's screen scaled. The moment a chat view branches on
# horizontalSizeClass it is drawing a DIFFERENT layout, which is the defect Zac
# rejected twice: plain-text rows against cards, chips duplicated in the
# composer, an action row of capsules that the phone does not have.
#
# The pixel half of this check is scripts/overlay_check.py — the phone's capture
# scaled by k, laid over the iPad's. It needs screenshots, so it runs against a
# capture set; this gate holds what can be read from source.
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 2
FAIL=0
say() { printf "  %-52s %s\n" "$1" "$2"; }
bad() { say "$1" "FAIL — $2"; FAIL=1; }

# 1. No chat view branches on size class.
CHAT_VIEWS="Views/MessageBubble.swift Views/RenderProgressRing.swift Views/FirstRunHero.swift"
OFFENDERS=""
for f in $CHAT_VIEWS; do
  CODE=$(grep -vE '^[[:space:]]*(//|///)' "$f")
  if grep -qE "horizontalSizeClass|hSize == \.regular|isPad" <<<"$CODE"; then
    OFFENDERS="$OFFENDERS $(basename "$f")"
  fi
done
[ -z "$OFFENDERS" ] && say "1. no size-class branch in the chat" "PASS" \
  || bad "1. no size-class branch in the chat" "branches in:$OFFENDERS"

# 1b. Nor in the thread's own layout modifiers.
CC=$(sed -n '/^struct ThreadFill/,/^struct BlurredFillImage/p' Views/ConversionColumn.swift)
if grep -qE "horizontalSizeClass|hSize == \.regular" <<<"$CC"; then
  bad "1b. no size-class branch in the thread modifiers" "ThreadFill/ThreadVideo branch again"
else
  say "1b. no size-class branch in the thread modifiers" "PASS"
fi

# 2. The chat is held to the phone's width times k — not the 88% rule, not a
#    column of its own invention.
EV=$(grep -vE '^[[:space:]]*//' Views/EditorView.swift)
N=$(grep -c "ThreadColumn.width(k)" <<<"$EV")
[ "$N" -ge 2 ] && say "2. chat and composer use the scaled-phone column" "PASS" \
  || bad "2. chat and composer use the scaled-phone column" "found $N of the 2 expected"
grep -q "conversionColumn(680)" <<<"$EV" \
  && bad "2b. composer does not use the 88% rule" "conversionColumn(680) is back on the composer" \
  || say "2b. composer does not use the 88% rule" "PASS"

# 3. Every dimension in the ring scales. A bare font size or frame there is a
#    phone-sized part on a scaled frame.
RING=$(grep -vE '^[[:space:]]*(//|///)' Views/RenderProgressRing.swift)
if grep -qE "\.font\(\.system\(size: [0-9]+[,)]" <<<"$RING"; then
  bad "3. the ring's dimensions all scale" "a font size in the ring is not multiplied by k"
else
  say "3. the ring's dimensions all scale" "PASS"
fi

# 4. The finished-video message is the assistant line, the video, the note,
#    Share, the action row. The publishing panel stays cut.
MB=$(grep -vE '^[[:space:]]*(//|///)' Views/MessageBubble.swift)
if grep -q "package.editRationale" <<<"$MB"; then
  grep -qE "package\.(postHook|postCaption)" <<<"$MB" \
    && bad "4. card gone, note kept" "the hook or caption block is back in the thread" \
    || say "4. card gone, note kept" "PASS"
else
  bad "4. card gone, note kept" "the note (editRationale) is not rendered anywhere"
fi
grep -q "Copy caption" <<<"$MB" && bad "4b. no Copy caption in the thread" "the button is back" \
  || say "4b. no Copy caption in the thread" "PASS"

[ $FAIL -eq 0 ] && echo "✓ ipad thread gate: the iPad chat is the iPhone chat, scaled" \
                || echo "✗ ipad thread gate FAILED"
exit $FAIL
