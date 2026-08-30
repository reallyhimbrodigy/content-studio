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
# TWO-SIDED REFERRAL — an App Review rejection, not a preference (2026-08-29).
#
# Apple permits rewarding the REFERRER. Rewarding the REFEREE — the person who
# receives the invite — for downloading or registering is non-compliant under
# guideline 3.2.2, which targets incentivised installs. Developers have been
# rejected for two-sided rewards even when the referee's reward only paid out on
# subscribe. Two-sided is also the industry default, so it WILL be proposed
# again in good faith by someone who has seen it everywhere else; this ban is
# here so that conversation happens at the gate rather than at App Review.
#
# Matches copy promising the invited person something ("they get", "your friend
# gets", "you both get"), and the invite-quota framing we banned separately.
TWO_SIDED_RE='(they|your friend|the person you invite|whoever you invite|you both|both of you) (get|gets|receive|receives|earn|earns)|gift (them|your friend)|free .{0,20}for (them|your friend)'
# INVITE-QUOTA framing — a separate ban with a separate reason, kept separate.
# "Invite 3 friends" is not an App Review problem; it is a conversion one. It
# states a quota before the user has shared even once, so the first share reads
# as a third of a reward rather than a reward. The ladder exists precisely so
# the FIRST successful invite pays. Merging this into the two-sided ban would
# put a rejection risk and a copy preference under one label and one fix.
INVITE_QUOTA_RE='invite [0-9]+ friends?|[0-9]+ (friends?|people) (to|who)|refer [0-9]+'

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

  hits="$(printf '%s\n' "$stripped" | grep -nEi "$TWO_SIDED_RE" || true)"
  if [ -n "$hits" ]; then
    violations=1
    while IFS= read -r h; do
      echo "TWO-SIDED REF   $f:$h"
      echo "                (rewarding the INVITED person is an App Review rejection — referrer only)"
    done <<< "$hits"
  fi

  hits="$(printf '%s\n' "$stripped" | grep -nEi "$INVITE_QUOTA_RE" || true)"
  if [ -n "$hits" ]; then
    violations=1
    while IFS= read -r h; do
      echo "INVITE QUOTA    $f:$h"
      echo "                (states a quota before the first share; the ladder pays from invite one)"
    done <<< "$hits"
  fi

  # ── COUNTDOWN UI — DEFAULT-DENY across every Swift file ───────────────────
  # Was scoped to filenames matching *Paywall*|*TrialWall*|*ExportGate*|*Offer*,
  # which is the allowlist shape the standing rule warns about: it governs the
  # surfaces you remembered, so a money screen with a name nobody predicted
  # ships a countdown and the gate says PASS. Now every file is checked.
  #
  # PRECISION FIRST, THEN DEFAULT-DENY. Unscoping the old pattern as-written
  # would have flagged eleven files of pure GCD noise — asyncAfter(deadline:)
  # is Swift's scheduling API, not a countdown — and a gate that is wrong ten
  # times out of eleven trains you to skim past the one real hit. So the
  # unambiguous language form is stripped before matching. That is precision,
  # not an exemption.
  #
  # A genuine non-UI use of the remaining vocabulary (an upload settle
  # deadline, a resume TTL) is exempted BY COMMENT — `countdown-ok: <reason>`
  # on the line or the line above — so every exemption is visible, local, and
  # carries its justification, rather than being implied by a filename.
  scan="$(printf '%s\n' "$stripped" | sed 's/asyncAfter(deadline:/asyncAfter(SCHEDULED:/g')"
  hits="$(printf '%s\n' "$scan" | grep -nEi "$SCARCITY_UI_RE" || true)"
  if [ -n "$hits" ]; then
    while IFS= read -r h; do
      [ -z "$h" ] && continue
      ln="${h%%:*}"
      prev=$((ln - 1))
      # Look for the exemption in the RAW file, not in $scan: $scan is
      # comment-STRIPPED, so an exemption comment is invisible there and could
      # never be honoured. Checked over a small window above the hit, because a
      # real justification runs to more than one line.
      lo=$((ln - 4)); [ "$lo" -lt 1 ] && lo=1
      window="$(sed -n "${lo},${ln}p" "$f")"
      case "$window" in
        *countdown-ok:*) continue ;;
      esac
      violations=1
      echo "COUNTDOWN UI    $f:$h"
      echo "                (exempt a legitimate non-UI use with a 'countdown-ok: <reason>' comment)"
    done <<< "$hits"
  fi
done < <(find "$SRC" -name '*.swift' -print0)

if [ "$violations" -ne 0 ]; then
  echo ""
  echo "trial-copy-gate: FAILED — trial copy, localizedTitle reads, literal-percentage claims, countdown UI, or fake-scarcity copy found (see lines above)."
  exit 1
fi

echo "trial-copy-gate: PASS — no trial copy, no localizedTitle reads, no literal-percentage claims, no countdown timers, no fake scarcity, no two-sided referral, no invite quotas."

# The reader-enumeration check runs from here so ONE invocation covers both:
# a separate script nobody remembers to run is not a gate.
bash "$DIR/compound-key-gate.sh"
bash "$DIR/benefits-parity-gate.sh"
bash "$DIR/uns-reporting-gate.sh"
bash "$DIR/purchase-context-gate.sh"
bash "$DIR/post-signup-funnel-gate.sh"
