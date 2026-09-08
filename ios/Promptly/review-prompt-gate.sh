#!/usr/bin/env bash
# THE REVIEW PROMPT IS ASKED FOR AT ONE MOMENT, AND REFUSED EVERYWHERE ELSE.
#
# WHY THIS EXISTS (2026-09-07). The app DID call AppStore.requestReview — but
# only from `recordThumbsUp`, i.e. a user tapping 👍 on the in-app feedback card,
# which itself only appears when they tap play on a video. It was never asked at
# an export, which is the moment the user actually has what they came for, and
# nothing anywhere refused a user whose render had just failed.
#
# WHAT MAKES A WRONG TRIGGER EXPENSIVE. Apple caps the sheet at three prompts a
# year and SILENTLY DISCARDS the rest — no callback, no error, no way to know
# from inside the app whether anything was shown. So a bad trigger does not fail
# loudly; it burns the quota invisibly. The local count is the only bookkeeping
# there is, which is why it is written on the ATTEMPT rather than on a success
# that cannot be observed.
#
# AND THE ONE-STAR CONDITION IS NOT A NICETY. 13 reviews at 4.1 with two
# one-stars means every rating moves the average hard, and the users who hit a
# dead retry are exactly the cohort that reviews unprompted.
set -uo pipefail
cd "$(dirname "$0")"

G=Promptly/Views/FeedbackGate.swift
M=Promptly/Views/FeedbackManager.swift
B=Promptly/Views/MessageBubble.swift
E=Promptly/Views/EditorView.swift
A=Promptly/Views/AccountView.swift
for f in "$G" "$M" "$B" "$E" "$A"; do [ -f "$f" ] || { echo "  missing $f"; exit 1; }; done
FAIL=0
# COMMENTS ARE NOT CODE — BUT `https://` IS NOT A COMMENT. The first version
# was `s://.*::`, which cut every line at the first `//` and so deleted the
# App Store URL it was checking for, reporting the row as missing when it was
# there. A `//` that follows a colon is a scheme separator.
strip() { sed -E 's,([^:])//.*,\1,; s,^[[:space:]]*//.*,,' "$1"; }

# 1. EVERY CONDITION THE RULING NAMES IS IN THE DECISION.
DEC=$(awk '/static func reviewPromptEligible/,/^    }$/' <<< "$(strip "$G")")
[ -n "$DEC" ] || { echo "  reviewPromptEligible is gone"; FAIL=1; }
grep -q "successfulRenderCount >= REVIEW_MIN_RENDERS" <<< "$DEC" || {
  echo "  the render minimum is gone — a first-timer can be asked"; FAIL=1; }
grep -q "exportCount >= REVIEW_MIN_EXPORTS" <<< "$DEC" || {
  echo "  the export minimum is gone"; FAIL=1; }
grep -q "!state.failedRenderInSession" <<< "$DEC" || {
  echo "  a user whose render just failed can be asked — that is the one-star"; FAIL=1; }
grep -q "REVIEW_REASK_DAYS" <<< "$DEC" || {
  echo "  the once-then-silence rule is gone"; FAIL=1; }

# 2. ONE TRIGGER, AND IT IS AN EXPORT. Anything else calling requestReview is
#    how "never at a gate, never after a failure" stops being true.
MB=$(strip "$M")
CALLS=$(grep -c "requestAppStoreReview()" <<< "$MB")
[ "$CALLS" -eq 2 ] || {
  echo "  requestAppStoreReview appears $CALLS time(s) in FeedbackManager,"
  echo "  expected 2 (its definition + the single export trigger)"; FAIL=1; }
EXP=$(awk '/func recordExportCompleted/,/^    }$/' <<< "$MB")
grep -q "FeedbackGate.reviewPromptEligible" <<< "$EXP" || {
  echo "  recordExportCompleted asks without consulting the decision"; FAIL=1; }
grep -q "requestAppStoreReview()" <<< "$EXP" || {
  echo "  recordExportCompleted no longer asks"; FAIL=1; }

# NOT FROM THE THUMBS-UP ANY MORE. That path could fire on a user whose render
# had failed, and it spends the same rationed attempt.
TU=$(awk '/func recordThumbsUp/,/^    }$/' <<< "$MB")
grep -q "requestAppStoreReview()" <<< "$TU" && {
  echo "  the thumbs-up path still asks for a review — it has none of the"
  echo "  ruled conditions, and spends the same rationed attempt"; FAIL=1; }

# 3. THE ATTEMPT IS RECORDED, because Apple's discard is invisible.
grep -q "defaults.set(now, forKey: Key.lastAppStorePromptAt)" <<< "$EXP" || {
  echo "  the attempt is not recorded — Apple discards silently, so an unrecorded"
  echo "  attempt is one spent with nothing to show for it"; FAIL=1; }
grep -q 'Analytics.track("review_prompt_shown"' <<< "$EXP" || {
  echo "  review_prompt_shown is not emitted — whether the trigger fires at all"
  echo "  would be unanswerable"; FAIL=1; }

# 4. WIRED AT BOTH EXPORT SITES, AND AT THE FAILURE.
BB=$(strip "$B")
[ "$(grep -c 'recordExportCompleted' <<< "$BB")" -eq 2 ] || {
  echo "  the trigger is not wired at BOTH export_completed sites (save and share)"; FAIL=1; }
grep -q "FeedbackManager.shared.recordRenderFailed()" <<< "$(strip "$E")" || {
  echo "  nothing marks a failed render, so the one-star condition can never fire"; FAIL=1; }

# 5. NEVER AT A GATE. The paywall and the export wall must not reach it.
for f in Promptly/Views/TwoStepPaywall.swift Promptly/Views/PaywallView.swift; do
  [ -f "$f" ] || continue
  grep -q "recordExportCompleted\|requestAppStoreReview" <<< "$(strip "$f")" && {
    echo "  $f can trigger a review prompt — never on a paywall"; FAIL=1; }
done

# 6. THE MANUAL PATH, which is always allowed and is not the sheet.
AB=$(strip "$A")
grep -q "action=write-review" <<< "$AB" || {
  echo "  the account page has no Rate Promptly row"; FAIL=1; }
grep -q 'Analytics.track("rate_app_tapped"' <<< "$AB" || {
  echo "  the Rate Promptly row is not instrumented"; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then
  echo "review-prompt-gate: FAIL"
  exit 1
fi
echo "review-prompt-gate: PASS — one trigger (a completed export), every ruled"
echo "                    condition, the attempt recorded, and a manual path."
exit 0
