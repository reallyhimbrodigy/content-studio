#!/usr/bin/env bash
# FIRST INSTALL — one definition, read by every first-run surface.
#
# WHY THIS EXISTS (2026-09-07). Three surfaces each decided "is this user new"
# for themselves, and only one of them was right:
#
#   showOnboardingV2                    !FirstRun.seen && !isAuthenticated
#                                       && !deviceKnownToServer     (correct)
#   showFirstLaunchPaywall              !FirstRun.seen              (blind to two)
#   maybeAutoOpenPickerOnFirstSession   a UserDefaults bool         (blind to all)
#
# So a user who deleted and reinstalled — same account, same plan, same history,
# restored from the Keychain — was handed the system photo picker on launch, and
# a signed-out reinstall on a device the server knows was sold the first-launch
# paywall again. The ruling: the funnel fires only for a GENUINE first install.
#
# The signals are chosen for one property — they survive a delete-and-reinstall.
# Every flag those surfaces were reading (hasCompletedOnboarding,
# hasSeenFirstLaunchPaywall, first_session_autopicker_fired) lives in
# UserDefaults, which is erased with the app. Storage that gets wiped cannot
# answer "have you been here before".
#
# This gate makes a fourth definition impossible: each decision site must read
# FirstInstall and must not re-derive the rule from the raw signals.
set -uo pipefail
cd "$(dirname "$0")"

FI=Promptly/Services/FirstInstall.swift
APP=Promptly/PromptlyApp.swift
ED=Promptly/Views/EditorView.swift
AUTH=Promptly/Services/AuthService.swift
for f in "$FI" "$APP" "$ED" "$AUTH"; do [ -f "$f" ] || { echo "  missing $f"; exit 1; }; done
FAIL=0

strip() { sed -E 's://.*::' "$1"; }

# 1. THE DEFINITION READS ALL THREE SIGNALS.
FIB=$(strip "$FI")
for sig in "AuthService.shared.restoredExistingSession" "FirstRun.seen" "InstallHistory.deviceKnownToServer"; do
  grep -q "$sig" <<< "$FIB" || { echo "  FirstInstall no longer reads $sig"; FAIL=1; }
done
grep -q "static var isFirstInstall: Bool { !hasBeenHereBefore }" <<< "$FIB" || {
  echo "  isFirstInstall is no longer the negation of hasBeenHereBefore"; FAIL=1; }

# 1b. THE TEST SEAM IS DEBUG-ONLY. `-poseFreshInstall` makes the funnel
#     reachable in a UI test; shipped, it would hand the funnel to every user
#     who passed the flag — and more to the point it would mean the rule can be
#     turned off from outside.
if grep -q "poseFreshInstall" <<< "$FIB"; then
  grep -q "#if DEBUG" <<< "$FIB" || {
    echo "  -poseFreshInstall is not fenced behind #if DEBUG"; FAIL=1; }
  # The fence has to be ABOVE the pose, not merely present in the file.
  POSE_LINE=$(grep -n "poseFreshInstall" <<< "$FIB" | head -1 | cut -d: -f1)
  FENCE_LINE=$(grep -n "#if DEBUG" <<< "$FIB" | head -1 | cut -d: -f1)
  if [ -n "$POSE_LINE" ] && [ -n "$FENCE_LINE" ] && [ "$FENCE_LINE" -ge "$POSE_LINE" ]; then
    echo "  the #if DEBUG fence sits AFTER the pose — it fences nothing"; FAIL=1
  fi
fi

# 2. NOT IP (ruled 2026-09-07). CGNAT plus India-dominant traffic means an IP
#    match suppresses the funnel for genuinely new users on the same carrier.
grep -qiE 'ip_?address|egress|remote_?addr|client_?ip' <<< "$FIB" && {
  echo "  FirstInstall is reading an IP signal — ruled out for CGNAT false positives"; FAIL=1; }

# 3. THE DURABLE SESSION SIGNAL IS A RESTORE, NOT isAuthenticated. Under
#    deferred auth a genuine first install is authenticated within a second of
#    launch, so isAuthenticated answers a different question.
grep -q "AuthService.shared.isAuthenticated" <<< "$FIB" && {
  echo "  FirstInstall reads isAuthenticated — true for a GENUINE first install"
  echo "  once signInAnonymouslyIfNeeded mints a user. Only a restore answers this."
  FAIL=1; }
AB=$(strip "$AUTH")
grep -q "private(set) var restoredExistingSession = false" <<< "$AB" || {
  echo "  restoredExistingSession is gone or no longer read-only from outside"; FAIL=1; }
# SNAPSHOTTED AT CONSTRUCTION, and nowhere else. Setting it from checkSession or
# from signInAnonymouslyIfNeeded's early returns both read TRUE on a GENUINELY
# fresh install — once the anonymous sign-in calls saveSession the Keychain holds
# a token, so "the Keychain has one" stops meaning "one was here before this
# launch". That suppresses the funnel for every new user: a permanent hole in the
# top of the funnel, strictly worse than the reinstall bug. Caught by running the
# fresh-install case on an erased simulator while this gate was green.
INIT=$(awk '/private init\(\) \{/,/^    }$/' <<< "$AB")
grep -q "restoredExistingSession = Keychain.get(tokenKey) != nil" <<< "$INIT" || {
  echo "  restoredExistingSession is no longer snapshotted in init, before any"
  echo "  sign-in can write a session"; FAIL=1; }
SETS=$(grep -c "restoredExistingSession = true" <<< "$AB")
[ "$SETS" -eq 0 ] || {
  echo "  restoredExistingSession is assigned true somewhere ($SETS site(s)) — after"
  echo "  an anonymous sign-in that reads TRUE on a fresh install. init snapshots it."
  FAIL=1; }
OUT=$(awk '/func signOut\(\)/,/^    }$/' <<< "$AB")
grep -q "restoredExistingSession = false" <<< "$OUT" || {
  echo "  signOut no longer clears restoredExistingSession — it would claim a session that is gone"; FAIL=1; }

# 4. EVERY DECISION SITE READS THE DEFINITION, AND NONE RE-DERIVES IT.
check_site() {
  local name="$1" body="$2"
  grep -q "FirstInstall.isFirstInstall" <<< "$body" || {
    echo "  $name does not read FirstInstall.isFirstInstall"; FAIL=1; }
  for raw in "FirstRun.seen" "InstallHistory.deviceKnownToServer" "restoredExistingSession"; do
    grep -q "$raw" <<< "$body" && {
      echo "  $name re-derives the rule from $raw — that is a second definition"; FAIL=1; }
  done
}
AP=$(strip "$APP")
check_site "showFirstLaunchPaywall" "$(awk '/private var showFirstLaunchPaywall: Bool \{/,/^    }$/' <<< "$AP")"
check_site "showOnboardingV2"       "$(awk '/private var showOnboardingV2: Bool \{/,/^    }$/' <<< "$AP")"
check_site "maybeAutoOpenPickerOnFirstSession" \
           "$(awk '/func maybeAutoOpenPickerOnFirstSession\(\)/,/^    }$/' <<< "$(strip "$ED")")"

# 5. AND EACH WAITS FOR THE SIGNALS. Deciding before they resolve is the same
#    defect wearing a race: the answer that would have suppressed the screen
#    arrives a moment after it is shown.
for v in showFirstLaunchPaywall showOnboardingV2; do
  B=$(awk "/private var $v: Bool \{/,/^    }\$/" <<< "$AP")
  grep -q "FirstInstall.hasResolved(deadlinePassed:" <<< "$B" || {
    echo "  $v decides without waiting for the install signals to resolve"; FAIL=1; }
done

if [ "$FAIL" -ne 0 ]; then
  echo "first-install-definition-gate: FAIL"
  exit 1
fi
echo "first-install-definition-gate: PASS — one definition, three signals that survive a"
echo "                    reinstall, read by all three first-run surfaces, none re-deriving."
exit 0
