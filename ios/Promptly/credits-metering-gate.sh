#!/bin/bash
# credits-metering-gate.sh — the claim must follow the meter that MOVES.
#
# THE LIVE DEFECT THIS CLOSES. `creditsEnabled` read the server's `credits`
# flag, which only says the meter may be DRAWN. That flag is ON in production
# while CREDITS_DEBIT_ENABLED is off, so on build 254:
#   - ProBenefits told an entitled Pro subscriber "20 videos a month" while
#     their App Store listing says "Unlimited renders" and they really do get
#     unlimited — underselling, the failure direction that reads as conservative;
#   - CreditBadge showed a balance that never decreased.
# Two questions, one flag. They were one thing when that line was written.
set -u
cd "$(dirname "$0")"
fail=0
say() { printf '  %s %s\n' "$1" "$2"; }
strip() { sed -e 's://.*::' "$1"; }   # comments stripped: this gate would
                                      # otherwise flag the paragraph above it
S=$(strip Promptly/Services/OnboardingState.swift)
has() { printf '%s' "$1" | grep -q "$2"; }

if has "$S" 'creditsEnabled = (obj?\["credits"\] as? String)'; then
  say "✗" "creditsEnabled is back on the DISPLAY flag — it will claim a cap the meter does not enforce"; fail=1
else
  say "✓" "creditsEnabled does not read the bare display flag"
fi
if has "$S" 'creditsEnabled = (obj?\["credits_metering"\] as? String) == "on"'; then
  say "✓" "creditsEnabled follows credits_metering (the meter that moves)"
else
  say "✗" "creditsEnabled does not read credits_metering"; fail=1
fi

# The claim must still be GATED at all — an ungated number is worse than either.
P=$(strip Promptly/Views/ProBenefits.swift)
if has "$P" 'guard creditsEnabled, let c = monthlyCredits, c > 0 else'; then
  say "✓" "headlineVideoClaim still falls back to the unlimited wording when the meter is off"
else
  say "✗" "headlineVideoClaim lost its guard — it would state a number unconditionally"; fail=1
fi

# Max's listing says "100 videos a month". That is 1000/10, and the client does
# the same division, so a drift on either side is a public promise breaking.
if has "$P" 'static let creditsPerVideo = 10'; then
  say "✓" "creditsPerVideo = 10, so Max's 1000 renders as the 100/month its listing promises"
else
  say "✗" "creditsPerVideo changed — Max's App Store description says 100 videos a month"; fail=1
fi

[ "$fail" -ne 0 ] && { echo "credits-metering-gate: FAIL"; exit 1; }
echo "credits-metering-gate: PASS"
