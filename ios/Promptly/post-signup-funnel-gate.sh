#!/bin/bash
# post-signup-funnel-gate.sh — THE FUNNEL RUNS AFTER SIGNUP (2026-08-30).
#
# A real-install trace showed the whole conversion funnel executing INSIDE the
# signup window:
#   session_started -> signup_start -> every onboarding_v2_step ->
#   offer_reveal_viewed -> onboarding_completed -> signup_complete ->
#   picker_opened   <- the FIRST event carrying a user_id
#
# So every funnel event was anonymous and unjoinable, and any purchase taken
# there landed on an anonymous RevenueCat identity requiring aliasing — the
# known no_profile_matched failure. The canonical revenue-per-wall-view read
# cannot attribute a single one of them.
#
# This was DELIBERATE, not incidental: showFirstLaunchPaywall guarded on
# `!auth.isAuthenticated`, i.e. show only when signed out. That is why a gate is
# warranted rather than a comment — a design someone chose on purpose will be
# chosen again unless something refuses it.
#
# THE RULE: no surface in the conversion sequence may gate on being signed OUT.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/Promptly/PromptlyApp.swift"
fail=0

[ -f "$APP" ] || { echo "post-signup-funnel: FAILED — PromptlyApp.swift missing."; exit 1; }

# Any conversion surface guarding on signed-OUT re-opens the anonymous window.
hits=$(grep -nE '^\s*!auth\.isAuthenticated else \{ return false \}' "$APP" || true)
if [ -n "$hits" ]; then
  echo "PRE-AUTH FUNNEL SURFACE — a conversion screen gates on being signed OUT:"
  printf '%s\n' "$hits" | sed 's/^/     /'
  fail=1
fi

# And each named surface must positively REQUIRE auth, not merely not-forbid it.
for fn in showFirstLaunchPaywall showOnboardingV2 showAttributionGate; do
  block=$(awk "/private var ${fn}: Bool \{/,/^    \}/" "$APP")
  [ -n "$block" ] || continue
  if ! printf '%s' "$block" | grep -qE '(^|[^!])auth\.isAuthenticated'; then
    echo "UNGUARDED       $fn does not require auth.isAuthenticated"
    echo "                a funnel step without a user_id cannot be attributed to anyone"
    fail=1
  fi
done

# ── AND NEVER TO AN EXISTING SUBSCRIBER ─────────────────────────────────────
# This became possible only BECAUSE of the reordering this gate enforces. While
# the surfaces were gated on `!auth.isAuthenticated`, a signed-out user had no
# known Pro status and the case could not arise. Requiring auth opened it: a
# paying subscriber would be sold what they already pay for, once per install.
# The fix for one defect created the other, so both are asserted together.
for fn in showFirstLaunchPaywall showOnboardingV2; do
  block=$(awk "/private var ${fn}: Bool \{/,/^    \}/" "$APP")
  [ -n "$block" ] || continue
  if ! printf '%s' "$block" | grep -q 'isPro'; then
    echo "SELLS TO A SUBSCRIBER  $fn does not exclude !subscription.isPro"
    echo "                       an existing Pro user would be shown an upsell"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "post-signup-funnel: FAILED — the funnel would run before signup again."
  echo "Every step must carry a user_id, and a purchase must be made under an"
  echo "identified RevenueCat customer, or the money is anonymous at the moment"
  echo "it is taken."
  exit 1
fi
echo "post-signup-funnel: PASS — every conversion surface requires a signed-in user."
exit 0
