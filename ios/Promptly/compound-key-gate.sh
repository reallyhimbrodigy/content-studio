#!/bin/bash
# compound-key-gate.sh — THE READER-ENUMERATION CHECK (2026-08-27).
#
# THE DEFECT CLASS, paid for three times in one week:
#   A stored key's SHAPE changes, and the readers aren't all updated. Nothing
#   errors. A `switch` on the raw value silently falls through to `default`,
#   so a personalised string quietly becomes the generic one and the screen
#   still renders "fine".
#     1. exportContentNoun read only the wall flow's `intents`, so a v2 user
#        could never get a personalised export gate.
#     2. Q2 keys became "type:style" ("podcast:fast") — OfferReveal.benefitLines
#        kept switching on the raw key and lost the personalised benefit.
#     3. ...and so did PaywallView's export-gate benefit page, the same day.
#   Caught by a render and a video respectively. Neither was caught by review,
#   because the code reads perfectly: `case "podcast":` is valid Swift that
#   simply never matches any more.
#
# THE RULE THIS ENFORCES:
#   A field whose values are COMPOUND (carry more than one datum in one
#   string) may only be read THROUGH ITS PARSER. Any Swift file that
#   references a compound key must also reference one of the parsers — so
#   "who reads this key?" is answered by the gate, not by memory.
#
# TO EXTEND: when you add a compound key, add it to COMPOUND_KEYS and its
# parser(s) to PARSERS. If you make a key compound that wasn't before, this
# gate immediately enumerates every file that must be revisited.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DIR/Promptly"

# Fields whose stored values are "a:b" shaped.
COMPOUND_KEYS='v2VideoType|v2Making'
# Functions that parse them. Reading through any of these is correct.
# Reading the key is also safe when a file HANDS it to a component that parses
# it. ProBenefits is such a boundary — it takes videoType: and resolves it via
# contentTypeV2 internally. That delegation is verified below rather than
# trusted: if ProBenefits ever stops parsing, this gate fails loudly instead of
# quietly licensing every caller.
PARSERS='contentTypeV2|styleV2|makingLabelV2|vibeV2|ProBenefits'
PARSING_BOUNDARY="$SRC/Views/ProBenefits.swift"
# Files exempt from the rule: where the key is DEFINED or WRITTEN, and the
# proof harness which seeds values directly.
EXEMPT='OnboardingState.swift|__PayoffSnapshotHarness.swift'

# The delegation boundary must really parse, or naming it would be a loophole.
if [ ! -f "$PARSING_BOUNDARY" ] || ! grep -qE 'contentTypeV2' "$PARSING_BOUNDARY"; then
  echo "compound-key-gate: FAILED — ProBenefits.swift is accepted as a parsing"
  echo "boundary but no longer calls contentTypeV2. Every file that delegates to"
  echo "it would be reading a compound key raw."
  exit 1
fi

violations=0
while IFS= read -r -d '' f; do
  case "$f" in
    *OnboardingState.swift|*__PayoffSnapshotHarness.swift) continue ;;
  esac
  if grep -qE "$COMPOUND_KEYS" "$f"; then
    if ! grep -qE "$PARSERS" "$f"; then
      violations=1
      echo "UNPARSED KEY    $f reads a compound key ($COMPOUND_KEYS) without any parser ($PARSERS)"
      grep -nE "$COMPOUND_KEYS" "$f" | sed 's/^/                  /'
    fi
  fi
done < <(find "$SRC" -name '*.swift' -print0)

if [ "$violations" -ne 0 ]; then
  echo ""
  echo "compound-key-gate: FAILED — a compound key is being read raw (see above)."
  echo "A raw switch on \"podcast\" cannot match \"podcast:fast\"; it falls through"
  echo "to default and the personalised string silently becomes the generic one."
  exit 1
fi

echo "compound-key-gate: PASS — every reader of a compound key parses it."
exit 0
