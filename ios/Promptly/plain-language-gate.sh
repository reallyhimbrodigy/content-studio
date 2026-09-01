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

# ── DESTRUCTIVE PAIRS ────────────────────────────────────────────────────
# A confirmation dialog's two buttons must never be a MINIMAL PAIR — one being
# the other with a negation bolted on. "Nicht weitermachen" against
# "Weitermachen" is one word apart in a dialog where the wrong tap destroys work
# in progress, and it is the shape careless translation produces by default: the
# translator sees "Keep going" and its opposite, and negates.
#
# This checks the CATALOG rather than the source, because the defect only exists
# per-language — the English pair is fine and every translation is a fresh
# chance to reintroduce it.
python3 - <<'PYEOF'
import json, sys, unicodedata

PAIRS = [("Stop making it", "Keep going")]
# Negation words that turn one button into the other.
NEG = ["nicht", "kein", "no", "not", "non", "pas", "ne", "tidak", "jangan",
       "नहीं", "मत", "नगर", "ない", "しない", "لا", "نہیں", "না", "não"]

cat = json.load(open("Promptly/Localizable.xcstrings"))["strings"]
bad = []
for destructive, safe in PAIRS:
    if destructive not in cat or safe not in cat:
        print(f"destructive-pair: CANNOT READ — {destructive!r} or {safe!r} missing from catalog")
        sys.exit(2)
    dl = cat[destructive]["localizations"]
    sl = cat[safe]["localizations"]
    for lang in sorted(set(dl) & set(sl)):
        a = dl[lang]["stringUnit"]["value"].strip().lower()
        b = sl[lang]["stringUnit"]["value"].strip().lower()
        if a == b:
            bad.append(f"{lang}: both buttons read {a!r}")
            continue
        # Strip any negation word from each and see if they collapse together.
        def bare(t):
            for n in NEG:
                t = t.replace(n, "")
            return " ".join(t.split())
        if bare(a) and bare(a) == bare(b):
            bad.append(f"{lang}: {a!r} vs {b!r} differ only by a negation")

if bad:
    print("destructive-pair: FAIL — a mis-tap here destroys work in progress")
    for b in bad:
        print("   ", b)
    sys.exit(1)
print(f"destructive-pair: PASS — {len(PAIRS)} dialog pair(s) lexically distinct in every language")
PYEOF
pair_rc=$?
[ "$pair_rc" -ne 0 ] && exit "$pair_rc"

# ── PLURAL AGREEMENT ─────────────────────────────────────────────────────
# A count next to a countable noun with no plural variation renders "1 videos".
# This was live on the paywall in EVERY language including English, because
# FREE_DAILY_RENDERS is 1 — so the broken form was not an edge case, it was what
# 100% of free users read. It survived a full localisation pass, a plain-language
# pass and a register pass, because every one of those checks the WORDS and none
# of them checks the NUMBER.
#
# Only flags strings that pair a count with a listed countable noun. A bare
# "%lld%% off" or "Step %lld of %lld" has nothing to agree with.
python3 - <<'PYEOF'
import json, re, sys
NOUNS = r"(videos?|clips?|chats?|messages?|credits?|days?|weeks?|months?|years?|friends?|people|person)"
cat = json.load(open("Promptly/Localizable.xcstrings"))["strings"]
bad = []
for k, e in cat.items():
    if not re.search(r"%(\d+\$)?lld", k):
        continue
    # Inflection markup handles agreement automatically — that is the good path.
    if "inflect:" in k:
        continue
    if not re.search(r"%(\d+\$)?lld\s+\w*\s*" + NOUNS, k, re.I):
        continue
    en = e.get("localizations", {}).get("en", {})
    if "variations" not in en:
        bad.append(k)
if bad:
    print(f"plural-agreement: FAIL — {len(bad)} count string(s) can render \"1 videos\"")
    for b in sorted(bad):
        print("   ", b[:88])
    print("  Add a plural variation, or use ^[%lld thing](inflect: true).")
    sys.exit(1)
print("plural-agreement: PASS — every count+noun string handles the singular")
PYEOF
plural_rc=$?
[ "$plural_rc" -ne 0 ] && exit "$plural_rc"

echo "plain-language-gate: PASS — no engineering vocabulary in user-facing copy."
