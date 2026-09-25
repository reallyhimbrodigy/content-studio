#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# upload-parallel-gate.sh — PARTS IN FLIGHT IS A KNOB, AND THE SPAN CAN READ IT.
#
# THE EXPERIMENT THAT ALREADY FAILED. Concurrency here was 6 and was cut to 3
# on measurement: six concurrent 16 MiB parts put 96 MB in flight on one uplink
# and starved each other into the idle timeout. The thing that starved is BYTES
# in flight, and the part size has since dropped to 5 MiB — so 3 parts is 15 MB
# today and 6 would be 30 MB. That makes 6 plausible, NOT measured, and the
# difference between those two words is this gate.
#
# So three properties, each of which has a way of failing quietly:
#
#   1. THE DEFAULT IS UNCHANGED. An install that never sees the knob must
#      behave exactly as it does today. A knob whose "off" is not the shipped
#      value is a silent rollout to everyone.
#   2. BOTH HALVES OF THE KNOB EXIST. The background URLSession fixes its
#      connection limit when it is constructed, during launch — before the
#      config fetch returns. So the value must be WRITTEN THROUGH on arrival
#      and READ BACK at construction. A reader with no writer never changes;
#      a writer with no reader is a value nobody consumes.
#   3. THE SPAN CARRIES BOTH NUMBERS. parts_in_flight alone cannot tell 6 small
#      parts from 6 large ones — which is exactly the difference between the
#      configuration that works and the one that broke.
set -uo pipefail
cd "$(dirname "$0")"
R="Promptly/Services/ResumableMultipartUploader.swift"
O="Promptly/Services/OnboardingState.swift"
fail=0
note() { echo "  FAIL — $1"; fail=1; }
for f in "$R" "$O"; do
  [ -f "$f" ] || { echo "  FAIL — missing $f (a failed read is not a pass)"; exit 1; }
done

echo "upload-parallel-gate:"

# ── 1. THE DEFAULT IS TODAY'S BEHAVIOUR ─────────────────────────────────────
grep -Eq '^[[:space:]]*static let defaultPartsInFlight = 3[[:space:]]*$' "$R" \
  && echo "  ok   — the default is 3, so an install that never sees the knob is unchanged" \
  || note "defaultPartsInFlight is not 3 — the knob's \"off\" no longer matches the shipped behaviour, which is a rollout to everyone"

# ── 2. THE SESSION READS THE KNOB, NOT A LITERAL ────────────────────────────
if grep -Eq '^[[:space:]]*config\.httpMaximumConnectionsPerHost = [0-9]+' "$R"; then
  note "httpMaximumConnectionsPerHost is set to a LITERAL — the knob cannot move it"
else
  grep -Eq '^[[:space:]]*config\.httpMaximumConnectionsPerHost = MultipartConfig\.partsInFlight' "$R" \
    && echo "  ok   — the background session takes its connection limit from the knob" \
    || note "httpMaximumConnectionsPerHost does not read MultipartConfig.partsInFlight — parts in flight is not actually server-driven"
fi

# ── 3. BOTH HALVES: WRITTEN ON ARRIVAL, READ AT CONSTRUCTION ────────────────
# The number now arrives from the AUTHENTICATED per-user block
# (/api/profile/settings), not from a flag string on the anonymous /api/health
# — that endpoint cannot know who is asking, which is why an allowlisted
# account still read flag_off. The write-through is what makes it take effect
# at all: the background session fixes its connection limit at construction,
# before any fetch returns.
grep -Eq 'UserDefaults\.standard\.set\(parallel, forKey: MultipartConfig\.partsInFlightKey\)' "$O" \
  && echo "  ok   — the per-user number is written through when it arrives" \
  || note "the resolved parallel value is not persisted — the uploader reads it before the fetch returns, so an unpersisted value never takes effect"
grep -Eq 'UserDefaults\.standard\.integer\(forKey: partsInFlightKey\)' "$R" \
  && echo "  ok   — and read back where the session is built" \
  || note "partsInFlight does not read the persisted key — the written value is consumed by nobody"
grep -Fq 'obj["upload"] as? [String: Any]' "$O" \
  && echo "  ok   — sourced from the authenticated upload block" \
  || note "nothing reads the per-user upload block — the knob has no source"

# ── 4. CLAMPED WHERE IT IS RESOLVED ────────────────────────────────────────
# A server that sends 60 must not open sixty connections.
sed -n '/func refreshUploadKnobs()/,/^    }/p' "$O" \
  | grep -Fq 'min(max(p, MultipartConfig.minPartsInFlight), MultipartConfig.maxPartsInFlight)' \
  && echo "  ok   — the resolved number is clamped between min and max" \
  || note "refreshUploadKnobs does not clamp the server's number"
grep -Eq 'min\(max\(stored, minPartsInFlight\), maxPartsInFlight\)' "$R" \
  && echo "  ok   — and clamped again at the read" \
  || note "the reading side does not clamp the stored value"

# ── 5. THE SPAN CARRIES BOTH NUMBERS ───────────────────────────────────────
span="$(sed -n '/func transfer(/,/^    }/p' "$R")"
printf '%s' "$span" | grep -Fq 'UploadTiming.meta(manifest.messageId, "parts_in_flight"' \
  && echo "  ok   — parts_in_flight rides the upload_timing span" \
  || note "parts_in_flight is not recorded on the transfer span — the knob would roll out unmeasured"
printf '%s' "$span" | grep -Fq 'UploadTiming.meta(manifest.messageId, "part_size_mib"' \
  && echo "  ok   — beside part_size_mib, so bytes-in-flight is recoverable" \
  || note "part_size_mib is missing from the span — parts_in_flight alone cannot tell 6 small parts from 6 large ones, which is the whole failure mode"

[ "$fail" = 0 ] && echo "upload-parallel-gate: PASS" || echo "upload-parallel-gate: FAIL"
exit "$fail"
