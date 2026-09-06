#!/bin/bash
# IPAD THREAD GATE — the four rules the thread was ruled to follow, asserted so
# they cannot regress silently. Each check names the defect it prevents.
#
# The pixel half of this check is scripts/layout_symmetry.py, which reads a
# capture and fails a torn or off-centre surface. It needs screenshots, so it is
# run against a capture set rather than from here; this gate holds the rules that
# CAN be read from source.
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 2
FAIL=0
say() { printf "  %-52s %s\n" "$1" "$2"; }
bad() { say "$1" "FAIL — $2"; FAIL=1; }

# 1. The card is gone, the note stays. PostPackageView must render editRationale
#    and must NOT render the hook headline or the caption block.
if grep -q "package.editRationale" Views/MessageBubble.swift; then
  if grep -qE "package\.(postHook|postCaption)" Views/MessageBubble.swift; then
    bad "1. card gone, note kept" "the hook or caption block is back in the thread"
  else
    say "1. card gone, note kept" "PASS"
  fi
else
  bad "1. card gone, note kept" "the note (editRationale) is not rendered anywhere"
fi
# Comments may still explain what was cut, so only count real code.
if grep -v '^\s*//' Views/MessageBubble.swift | grep -q "Copy caption"; then
  bad "1b. no Copy caption in the thread" "the Copy caption button is back"
else
  say "1b. no Copy caption in the thread" "PASS"
fi

# 2. The iPad empty state is the vibe rows as the hero, not a black screen.
grep -q "iPadWelcomeState" Views/EditorView.swift \
  || bad "2. iPad empty state" "the regular-width welcome branch is gone"
grep -q "private var isPad" Views/FirstRunHero.swift \
  || bad "2b. hero is size-class aware" "FirstRunHero no longer distinguishes iPad"

# 3. Thread text scales with k. A bare .body font in the thread is the defect.
if grep -qE "\.font\(\.system\(\.body" Views/MessageBubble.swift; then
  bad "3. thread text scales with k" "a non-scaling .body font is back in the thread"
else
  say "3. thread text scales with k" "PASS"
fi

# 4. THE MEDIA BOX FOLLOWS THE ORIENTATION.
if grep -q "func mediaBox(isPortrait" Views/ConversionColumn.swift; then
  P=$(grep -A3 "func mediaBox(isPortrait" Views/ConversionColumn.swift | grep -oE "width: 394, height: 700" | head -1)
  L=$(grep -A3 "func mediaBox(isPortrait" Views/ConversionColumn.swift | grep -oE "maxWidth - videoInset, height: 480" | head -1)
  [ -n "$P" ] && [ -n "$L" ] && say "4. media box follows orientation" "PASS" \
    || bad "4. media box follows orientation" "the portrait/landscape shapes changed"
else
  bad "4. media box follows orientation" "mediaBox(isPortrait:) is gone"
fi
grep -q "windowIsPortrait" PromptlyApp.swift \
  || bad "4b. orientation is published" "RootScale no longer publishes windowIsPortrait"
for f in Views/ThreadVideo Views/ConversionColumn Views/RenderProgressRing; do :; done
grep -q "windowIsPortrait" Views/RenderProgressRing.swift \
  || bad "4c. ring consumes orientation" "the ring no longer reads windowIsPortrait"

# The thread keeps its own column.
grep -q "maxWidth: CGFloat = 820" Views/ConversionColumn.swift \
  || bad "5. thread column is 820pt" "ThreadColumn.maxWidth changed"

[ $FAIL -eq 0 ] && echo "✓ ipad thread gate: the four ruled thread rules hold" || echo "✗ ipad thread gate FAILED"
exit $FAIL
