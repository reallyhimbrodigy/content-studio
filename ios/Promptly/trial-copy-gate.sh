#!/bin/bash
# trial-copy-gate.sh — the freemium-copy gate (companion-rule check for the
# 2026-08-27 conversion build; makes the trial-copy regression impossible).
#
# Promptly is permanent FREE + PRO with NO trials. Two bans, enforced on every
# Swift source under Promptly/:
#   1. Trial-phrased COPY: "free trial", "try free", "trial period", or any
#      "<N> day(s)/week(s) free" — the phrasing App Review and the honesty
#      laws both forbid on a product that charges immediately.
#   2. StoreKit `localizedTitle` CODE reads — plan labels are OUR bare nouns,
#      never ASC product names (the Jul-24 rule; regression closed 2026-08-26).
#   3. LITERAL PERCENTAGE / FRACTION price claims. Every discount number
#      must be COMPUTED from the live per-territory StoreKit prices and
#      floored — a hardcoded "half price" or "50% off" is false wherever
#      Apple's price points land the intro elsewhere (measured 2026-08-27:
#      HUN and POL sit at 40% off, QAT at 57%). Interpolated claims like
#      "\(pct)% off" are FINE — the ban is on literal digits and worded
#      fractions, which are claims we cannot keep in 175 territories.
#   4. COUNTDOWN TIMERS and FAKE SCARCITY (ruled 2026-08-27: "never build a
#      countdown timer; real-scarcity copy only"). Bans the countdown UI
#      primitives on paywall/gate surfaces AND manufactured-urgency copy
#      ("offer ends in", "expires in", "only N left", "limited time",
#      "hurry", "act now", "last chance"). Real scarcity — a finished video
#      waiting, a real per-territory intro price — needs none of these.
#
# Comments are excluded from BOTH checks: the ban is on shipping copy/code,
# and several files (TrialCopy.swift, TrialWallView.swift) deliberately QUOTE
# the banned phrases in doc comments to document the ban itself. String
# literals are preserved through the strip (quote-aware), so banned copy
# hiding inside a Text("...") is always caught.
#
# Exit 0 = clean tree. Exit 1 = offending lines printed as file:line:content.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DIR/Promptly"

TRIAL_RE='free trial|try free|trial period|[0-9]+ ?(day|week)s? free'
TITLE_RE='localizedTitle'
# Countdown/scarcity: UI primitives (a countdown needs a repeating clock bound
# to a deadline) + the manufactured-urgency phrase set.
SCARCITY_COPY_RE='offer ends|ends in [0-9]|expires in|only [0-9]+ (left|remaining|spots?|seats?)|limited time|limited offer|hurry|act now|last chance|don.t miss out'
# Literal price-percentage claims. A digit immediately before % is literal;
# an interpolation renders as \(name)% and never matches this.
PERCENT_RE='[0-9]+ ?% ?(off|discount|cheaper|savings?)|half[- ]?(price|off)|quarter[- ]?price|third off'
SCARCITY_UI_RE='countdown|timeRemaining|secondsRemaining|expiresAt|deadline'

# Strip // line comments and /* */ block comments while preserving line count
# and string literals (a quote-aware scan, so "https://…" inside a string never
# truncates the line and copy inside quotes is never stripped).
strip_comments() {
  awk '
    {
      out = ""; i = 1; n = length($0); instr = 0
      while (i <= n) {
        two = substr($0, i, 2); one = substr($0, i, 1)
        if (inblock) {
          if (two == "*/") { inblock = 0; i += 2 } else { i++ }
          continue
        }
        if (instr) {
          out = out one
          if (one == "\\") { out = out substr($0, i + 1, 1); i += 2; continue }
          if (one == "\"") { instr = 0 }
          i++; continue
        }
        if (one == "\"") { instr = 1; out = out one; i++; continue }
        if (two == "//") { break }
        if (two == "/*") { inblock = 1; i += 2; continue }
        out = out one; i++
      }
      print out
    }
  ' "$1"
}

violations=0
while IFS= read -r -d '' f; do
  stripped="$(strip_comments "$f")"

  hits="$(printf '%s\n' "$stripped" | grep -nEi "$TRIAL_RE" || true)"
  if [ -n "$hits" ]; then
    violations=1
    while IFS= read -r h; do
      echo "TRIAL COPY      $f:$h"
    done <<< "$hits"
  fi

  hits="$(printf '%s\n' "$stripped" | grep -nE "$TITLE_RE" || true)"
  if [ -n "$hits" ]; then
    violations=1
    while IFS= read -r h; do
      echo "localizedTitle  $f:$h"
    done <<< "$hits"
  fi

  hits="$(printf '%s\n' "$stripped" | grep -nEi "$PERCENT_RE" || true)"
  if [ -n "$hits" ]; then
    violations=1
    while IFS= read -r h; do
      echo "LITERAL %       $f:$h"
    done <<< "$hits"
  fi

  hits="$(printf '%s\n' "$stripped" | grep -nEi "$SCARCITY_COPY_RE" || true)"
  if [ -n "$hits" ]; then
    violations=1
    while IFS= read -r h; do
      echo "FAKE SCARCITY   $f:$h"
    done <<< "$hits"
  fi

  # Countdown UI primitives are banned on the money surfaces specifically —
  # elsewhere (upload deadlines, resume TTLs) they are legitimate mechanics.
  case "$f" in
    *Paywall*|*TrialWall*|*ExportGate*|*Offer*)
      hits="$(printf '%s\n' "$stripped" | grep -nEi "$SCARCITY_UI_RE" || true)"
      if [ -n "$hits" ]; then
        violations=1
        while IFS= read -r h; do
          echo "COUNTDOWN UI    $f:$h"
        done <<< "$hits"
      fi
      ;;
  esac
done < <(find "$SRC" -name '*.swift' -print0)

if [ "$violations" -ne 0 ]; then
  echo ""
  echo "trial-copy-gate: FAILED — trial copy, localizedTitle reads, literal-percentage claims, countdown UI, or fake-scarcity copy found (see lines above)."
  exit 1
fi

echo "trial-copy-gate: PASS — no trial copy, no localizedTitle reads, no literal-percentage claims, no countdown timers, no fake scarcity."

# The reader-enumeration check runs from here so ONE invocation covers both:
# a separate script nobody remembers to run is not a gate.
bash "$DIR/compound-key-gate.sh"
bash "$DIR/benefits-parity-gate.sh"
bash "$DIR/uns-reporting-gate.sh"
bash "$DIR/purchase-context-gate.sh"
