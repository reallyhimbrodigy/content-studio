#!/bin/bash
# PLAIN-LANGUAGE GATE — no engineering vocabulary in front of a user.
#
# WHY: the render stage names shipped as "Final encode", "Transcribing every
# word", "Sourcing B-roll cutaways" and "Rendering your edit". Every user reads
# all seventeen of them during every render, so the highest-traffic copy in the
# product was also the least readable — a machine describing its own internals
# to someone who just wants to know how long their video will be.
#
# The failure is not that the words are long. It is that they describe OUR
# process instead of THEIR video. "Final encode" is a true statement about a
# codec and tells the user nothing; "Almost done" is what they actually asked.
#
# WHAT IT BANS: terms from the engineering vocabulary, in user-visible string
# literals only. Same shape as the trial-copy and literal-percentage bans that
# already run: a word list, a scoped search, and a documented escape hatch.
#
# THE ESCAPE HATCH IS DELIBERATE AND NARROW. Some banned words are legitimate in
# a comment, a log line, an analytics event name or an API path — none of which
# a user reads. Those are excluded by scope, not by exemption. A genuine
# user-facing exception (a legal disclosure that must use a specific term) takes
# a `plain-ok: <reason>` comment on the line, so the reason is in the diff.
#
# Exit 0 = clean. Exit 1 = engineering vocabulary is reaching users.

set -uo pipefail
cd "$(dirname "$0")" || exit 2

# Words no ten-year-old uses, that describe machinery rather than the user's
# video. Deliberately NOT a general readability score: a checkable list is one
# people can argue with and add to, which a score is not.
BANNED=(
  encode encoding encoder transcode
  transcribe transcribing transcription
  render rendering   # "your video" — never "your render"
  dispatch dispatching
  normalize normalizing normalization
  parse parsing
  buffer buffering
  initialize initializing
  metadata
  payload endpoint
  codec compression
  concatenate
  asynchronous asynchronously
  authenticate authenticating
  validate validating validation
  " sync " " syncing "
  "B-roll"
  "frame-by-frame"
)

# Only files that put words in front of a user.
FILES=$(find Promptly -name "*.swift" -not -name "__*" 2>/dev/null)

fails=0
checked=0

for f in $FILES; do
  # User-visible string literals: String(localized:), Text("…"), and the
  # PipelineStage title: field. NOT comments, NOT Analytics.track names, NOT
  # URL paths, NOT UserDefaults keys — a user reads none of those, and flagging
  # them is how a gate earns a reputation for crying wolf.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    num="${line%%:*}"
    text="${line#*:}"

    # Skip anything carrying a documented exception.
    case "$text" in *"plain-ok:"*) continue ;; esac
    # Skip pure comment lines.
    trimmed="$(printf '%s' "$text" | sed 's/^[[:space:]]*//')"
    case "$trimmed" in "//"*|"///"*|"*"*) continue ;; esac

    checked=$((checked + 1))

    # ONLY THE QUOTED CONTENT, not the whole line. Matching the raw line made
    # `videoUrl: job.rendered_video_url` trip the 'render' ban because it shared
    # a line with a String(localized:) — a property name no user will ever read.
    # A gate with false positives gets ignored, and then it protects nothing.
    # ONLY the copy, not every quoted token on the line. Matching all quotes
    # made `PipelineStage(id: "transcribe", title: String(localized: "Writing
    # down what you said"))` fail on its own stage ID — an internal key no user
    # reads, on a line whose actual copy is already correct. Seven of the first
    # twenty hits were that. Capture what follows the user-facing markers only.
    quoted="$(printf '%s' "$text" \
      | grep -oE '(String\(localized: *"[^"]*"|Text\( *"[^"]*"|title: *"[^"]*")' \
      | sed -E 's/^(String\(localized: *|Text\( *|title: *)//' | tr '\n' ' ')"
    [ -n "$quoted" ] || continue

    for w in "${BANNED[@]}"; do
      # Native bash matching, case-insensitive — NOT `printf | grep -q`, which
      # returns 141 under `set -o pipefail` when grep exits early on a large
      # file (SIGPIPE) and makes the verdict depend on file size.
      shopt -s nocasematch
      if [[ "$quoted" == *"$w"* ]]; then
        echo "  $f:$num"
        echo "      banned term '$w' in user-facing copy"
        echo "      $(printf '%s' "$trimmed" | cut -c1-96)"
        fails=$((fails + 1))
        shopt -u nocasematch
        break
      fi
      shopt -u nocasematch
    done
  done < <(grep -nE 'String\(localized:|Text\("|title: "' "$f" 2>/dev/null)
done

echo "plain-language-gate: checked $checked user-facing string lines"

if [ "$checked" -eq 0 ]; then
  echo "plain-language-gate: CANNOT READ — zero user-facing strings matched."
  echo "  The scan is broken, which is NOT the same as the copy being clean."
  exit 2
fi

if [ "$fails" -gt 0 ]; then
  echo "plain-language-gate: FAIL — $fails user-facing string(s) use engineering words."
  echo "  Say what is happening to the user's video, not what the system is doing."
  echo "  If a banned word is the only precise word, the SENTENCE is wrong."
  echo "  A genuine exception takes a 'plain-ok: <reason>' comment on the line."
  exit 1
fi

echo "plain-language-gate: PASS — no engineering vocabulary in user-facing copy."
