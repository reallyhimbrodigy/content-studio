#!/bin/bash
# THE FUNNEL KEY MUST BE ON EVERY EVENT.
#
# Deferred auth moves the top of the funnel before sign-in, so those events
# carry no user_id. `device_id` is what makes them joinable — and a funnel
# re-keyed onto a field that later stops being attached would go quiet without
# anything failing. That is the "failed read that looks like a recovery" shape
# this project has already paid for once, so the attachment is asserted rather
# than assumed.
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 1
FAIL=0
A="Services/AnalyticsService.swift"
[ -f "$A" ] || { echo "funnel-key-gate: MISSING $A"; exit 1; }

# 1. track() must attach device_id UNCONDITIONALLY (no `if let`, no flag).
BODY=$(awk '/static func track\(/,/^    }$/' "$A")
if ! echo "$BODY" | grep -qE '^\s*enrichedProps\["device_id"\] = deviceId'; then
  echo "  track() does not attach device_id unconditionally"
  FAIL=1
fi
# 2. Both sinks must carry it: PostHog props derive from enrichedProps, and the
#    DB payload must send props.
if ! echo "$BODY" | grep -q 'phProps: \[String: Any\] = enrichedProps'; then
  echo "  PostHog props no longer derive from enrichedProps — device_id may be PostHog-blind"
  FAIL=1
fi
if ! echo "$BODY" | grep -q '"props": propsObj'; then
  echo "  the /api/events payload no longer carries props — device_id would be DB-blind"
  FAIL=1
fi
# 3. It must also be a super-property, for events that never pass through track().
if ! grep -q 'register(\["device_id": deviceIdForJoin\])' "$A"; then
  echo "  device_id is not registered as a PostHog super-property"
  FAIL=1
fi
if ! grep -rq "Analytics.registerDeviceIdSuperProperty()" --include="*.swift" .; then
  echo "  registerDeviceIdSuperProperty() is never called"
  FAIL=1
fi
# 4. Nothing may capture to PostHog outside AnalyticsService (would bypass 1+2).
STRAY=$(grep -rln --include="*.swift" "PostHogSDK.shared.capture" . 2>/dev/null | grep -v "$A" || true)
if [ -n "$STRAY" ]; then
  echo "  PostHog capture called outside AnalyticsService:"; echo "$STRAY" | sed 's/^/    /'
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then echo "funnel-key-gate: FAIL"; exit 1; fi
echo "funnel-key-gate: PASS — device_id rides every event on both sinks"
exit 0
