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
#
# THE GUARD MOVED (258). The capacity claim no longer follows the credits meter;
# it follows `videos_limit` on /api/usage, so the old `guard creditsEnabled,
# let c = monthlyCredits` is gone. The INVARIANT is unchanged and is what this
# asserts: the claim states a number only when a server supplied one, and falls
# back to wording with no number otherwise.
P=$(strip Promptly/Views/ProBenefits.swift)
if has "$P" 'guard let line = capacityLine(videos: videos) else'; then
  say "✓" "headlineVideoClaim states a number only when the server supplied one"
else
  say "✗" "headlineVideoClaim lost its guard — it would state a number unconditionally"; fail=1
fi

# …and the number must not be RE-DERIVED from credits. `monthlyVideos(credits:)`
# yields Pro 20 (200÷10); the allowance is 50. A capacity line that called it
# would compile, read sensibly, and quietly ship the old figures — the exact
# failure this whole change exists to remove, and invisible in review because
# every line of it looks correct.
CAP=$(printf '%s' "$P" | sed -n '/static func capacityLine/,/^    }/p')
if printf '%s' "$CAP" | grep -q 'monthlyVideos'; then
  say "✗" "capacityLine derives its number from credits — it must read videos_limit"; fail=1
else
  say "✓" "capacityLine does not re-derive the allowance from credits"
fi

# perVideo NO LONGER SETS THE MONTHLY CLAIM — that comes from the server — but
# it still converts the BALANCE and the top-up PACKS, both of which a user reads.
# Two constants spell it (ProBenefits.creditsPerVideo and CreditsService.perVideo)
# and they must agree, or the badge and the packs disagree about one video.
if has "$P" 'static let creditsPerVideo = 10'; then
  say "✓" "ProBenefits.creditsPerVideo = 10"
else
  say "✗" "ProBenefits.creditsPerVideo changed — balance and packs convert through it"; fail=1
fi
C=$(strip Promptly/Services/CreditsService.swift)
if has "$C" 'static let perVideo = 10'; then
  say "✓" "CreditsService.perVideo = 10 — the two spellings agree"
else
  say "✗" "CreditsService.perVideo disagrees with ProBenefits.creditsPerVideo"; fail=1
fi

# INERTNESS IS A DECODING PROPERTY, and it is the whole safety story for 258:
# the client ships before the server field does, so `Snapshot` must decode a
# response that has no `videos_limit` at all. One non-optional member anywhere in
# that subtree and JSONDecoder throws — which does not fail loudly, it makes
# `refresh()` return early and EVERY usage-derived surface go blank, including
# the render limit and the validate token. A capacity line that is merely absent
# is the intended inert state; a snapshot that will not decode is an outage.
U=$(strip Promptly/Services/UsageService.swift)
if has "$U" 'let videos_limit: VideoLimits?'; then
  say "✓" "videos_limit is optional — a server without it still decodes"
else
  say "✗" "videos_limit is not optional — a pre-258 server response would fail to decode"; fail=1
fi
VL=$(printf '%s' "$U" | sed -n '/struct VideoLimits/,/^    }/p')
# `Int[^?]` CANNOT MATCH AT END OF LINE, which is precisely where these
# declarations sit — the first version of this assertion stayed green through
# its own RED-prove. Anchor the alternative explicitly.
if printf '%s' "$VL" | grep -qE 'let (free|pro|max): Int([^?]|$)' ; then
  say "✗" "a VideoLimits tier is non-optional — a server that omits one breaks the whole snapshot"; fail=1
else
  say "✓" "every VideoLimits tier is optional"
fi

# THE FLAG RACES THE BADGE'S TASK. seed() bails when creditsEnabled is still
# false, and /api/health fills it asynchronously — so without a re-seed on the
# flag the badge draws nothing for the whole session on any launch where health
# is slow. Observed on a fresh install with the flag ON and claims healthy.
B=$(strip Promptly/Views/CreditBadge.swift)
if has "$B" 'onChange(of: onboarding.creditsEnabled)'; then
  say "✓" "the badge re-seeds when the credits flag lands"
else
  say "✗" "nothing re-seeds the badge when the flag arrives late — it stays blank all session"; fail=1
fi

[ "$fail" -ne 0 ] && { echo "credits-metering-gate: FAIL"; exit 1; }
echo "credits-metering-gate: PASS"
