#!/usr/bin/env bash
# ENTITLEMENT ON EVERY FOREGROUND — the leg the web purchase lands on.
#
# WHY THIS EXISTS (2026-09-07). Nothing re-read the entitlement when the app
# came back. `identify` and `UsageService.refresh` run in the LAUNCH task;
# `refreshCustomerInfo` runs at bootstrap and on identify. So a purchase that
# completed while the app was backgrounded stayed invisible until a relaunch, or
# until the user happened to open the paywall, the account page, or send a
# message.
#
# That is precisely the web-checkout path. The buyer leaves for Safari, pays,
# and taps "Open Promptly" on /success — which FOREGROUNDS this app rather than
# launching it. The webhook has already written the entitlement to profiles by
# then. "The app shows Pro on next foreground" was false, and the reason was on
# the client, not in the webhook or grantsPro.
#
# BOTH SOURCES are required. effectiveIsPro composes them and they arrive by
# different routes: /api/usage carries the SERVER's view — the only one that can
# see a purchase made on the WEB, which this device never made and RevenueCat's
# local cache has no reason to know about — and customerInfo carries RC's.
# Checking only one would pass while the web path stayed broken.
set -uo pipefail
cd "$(dirname "$0")"

APP=Promptly/PromptlyApp.swift
[ -f "$APP" ] || { echo "  missing $APP"; exit 1; }
FAIL=0

# Comments are not code.
BODY=$(sed -E 's://.*::' "$APP")

# The scenePhase handler, up to the session-start guard. Everything after that
# guard runs ONCE PER SESSION, which is not what a foreground is.
BLOCK=$(awk '/\.onChange\(of: scenePhase\) \{ previous, phase in/,/if !didStartSession \|\| previous == .background \{/' <<< "$BODY")
[ -n "$BLOCK" ] || { echo "  the scenePhase handler no longer has the shape this gate reads"; exit 1; }

grep -q "UsageService.shared.refresh()" <<< "$BLOCK" || {
  echo "  no /api/usage refresh on foreground — the SERVER's view of the entitlement"
  echo "  is the only one that can see a purchase made on the web."; FAIL=1; }

grep -q "SubscriptionService.shared.refreshCustomerInfo()" <<< "$BLOCK" || {
  echo "  no RevenueCat customerInfo refresh on foreground"; FAIL=1; }

# OUTSIDE THE ONCE-PER-SESSION GUARD. Inside it, a foreground that resumes an
# existing session skips the refresh entirely — the exact case the web buyer
# returns through.
AFTER=$(awk '/if !didStartSession \|\| previous == .background \{/,0' <<< "$BODY")
grep -q "await UsageService.shared.refresh()" <<< "$BLOCK" || FAIL=1
if grep -q "SubscriptionService.shared.refreshCustomerInfo()" <<< "$AFTER" \
   && ! grep -q "SubscriptionService.shared.refreshCustomerInfo()" <<< "$BLOCK"; then
  echo "  the refresh sits INSIDE the once-per-session guard — a resumed session skips it"; FAIL=1
fi

# AND IT STILL RUNS AT LAUNCH. Moving it rather than adding it would trade one
# hole for another: a cold launch must not depend on a later foreground.
grep -q "await UsageService.shared.refresh()" <<< "$BODY" || {
  echo "  the launch-time usage refresh is gone"; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then
  echo "entitlement-foreground-gate: FAIL"
  exit 1
fi
echo "entitlement-foreground-gate: PASS — both entitlement sources refresh on every"
echo "                    foreground, outside the once-per-session guard."
exit 0
