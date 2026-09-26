#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# upload-knobs-gate.sh — A PER-USER DECISION CANNOT COME FROM AN ANONYMOUS CALL.
#
# WHAT WENT WRONG. The client read upload_shrink / upload_parallel from
# /api/health, which it fetches WITHOUT auth. That endpoint cannot know who is
# asking, so a per-user allowlist could never reach the device through it — and
# an allowlisted account's row still read shrink_reason="flag_off". The flags
# looked dead for everyone because the client was asking a question the
# endpoint could not answer.
#
# They now come from GET /api/profile/settings (authenticated), whose `upload`
# block the server fills per user: { shrink, parallel, accelerate, state,
# resolved_by }.
#
# FAIL CLOSED, AND SAY SO — the same discipline the server uses. "UNREADABLE"
# means it could not ask, and carries shrink false / parallel 3. A MISSING
# block (an older server) must behave identically: "no opinion" and "could not
# form one" have the same safe answer, and neither is a licence to shrink.
set -uo pipefail
cd "$(dirname "$0")"
O="Promptly/Services/OnboardingState.swift"
E="Promptly/Views/EditorView.swift"
fail=0
note() { echo "  FAIL — $1"; fail=1; }
for f in "$O" "$E"; do
  [ -f "$f" ] || { echo "  FAIL — missing $f (a failed read is not a pass)"; exit 1; }
done

echo "upload-knobs-gate:"

# ── 1. THE ANONYMOUS ENDPOINT NO LONGER DECIDES ────────────────────────────
# Non-comment lines only: the comment that replaced the old read names the
# fields to explain why they went.
if grep -v '^[[:space:]]*//' "$O" | grep -Eq 'obj\?\["upload_shrink"\]|obj\?\["upload_parallel"\]'; then
  note "upload knobs are still parsed from the /api/health payload — that call is unauthenticated, so a per-user allowlist can never reach the device through it"
else
  echo "  ok   — no upload knob is read from the anonymous /api/health payload"
fi

body="$(sed -n '/func refreshUploadKnobs()/,/^    }/p' "$O")"
if [ -z "$body" ]; then
  note "there is no refreshUploadKnobs — nothing reads the per-user block"
  echo "upload-knobs-gate: FAIL"; exit 1
fi

# ── 2. THE AUTHENTICATED CALL ──────────────────────────────────────────────
printf '%s' "$body" | grep -Fq 'api/profile/settings' \
  && echo "  ok   — reads GET /api/profile/settings" \
  || note "refreshUploadKnobs does not call /api/profile/settings"
printf '%s' "$body" | grep -Fq 'AuthService.shared.getValidToken()' \
  && echo "  ok   — with a bearer token, so the server knows who is asking" \
  || note "the knob call is not authenticated — it would get the anonymous answer again"

# ── 3. THE SAFE DEFAULTS ARE SET BEFORE ANYTHING IS PARSED ─────────────────
# Declared up front and applied in a defer, so EVERY early return — no token,
# non-200, unparseable body, missing block — lands on them.
printf '%s' "$body" | grep -Eq '^[[:space:]]*var shrink = false' \
  && echo "  ok   — shrink defaults false before any parse" \
  || note "shrink does not default to false ahead of the parse — an early return could leave it on"
printf '%s' "$body" | grep -Eq '^[[:space:]]*var parallel = MultipartConfig\.defaultPartsInFlight' \
  && echo "  ok   — parallel defaults to the shipped 3" \
  || note "parallel does not default to MultipartConfig.defaultPartsInFlight"
printf '%s' "$body" | grep -Eq '^[[:space:]]*var state = "UNREADABLE"' \
  && echo "  ok   — and the state reported when we could not ask is UNREADABLE" \
  || note "the default state is not UNREADABLE — a failed read would be reported as though it had been measured"
printf '%s' "$body" | grep -Fq 'defer {' \
  && echo "  ok   — applied in a defer, so every early return lands on them" \
  || note "the defaults are not applied in a defer — an early return would leave the previous values in place"

# ── 4. ONLY A MEASURED ANSWER MAY TURN ANYTHING ON ─────────────────────────
printf '%s' "$body" | grep -Fq 'guard reported == "MEASURED" else { return }' \
  && echo "  ok   — UNREADABLE returns before shrink or parallel are read" \
  || note "the code does not gate on state == MEASURED — an UNREADABLE response could still turn shrink on"
# A MISSING block takes the same door as UNREADABLE.
printf '%s' "$body" | grep -Fq 'let up = obj["upload"] as? [String: Any]' \
  && printf '%s' "$body" | grep -Fq 'else { return }' \
  && echo "  ok   — a missing upload block returns onto the same defaults" \
  || note "a missing upload block does not fall to the defaults — an older server would leave the knobs at whatever they were"

# ── 5. EVERY ROW SAYS WHY ──────────────────────────────────────────────────
grep -Fq 'UploadTiming.meta(pending.id.uuidString, "knob_state"' "$E" \
  && echo "  ok   — knob_state rides the upload_timing row" \
  || note "knob_state is not recorded — a row saying shrink was off cannot distinguish 'not allowlisted' from 'could not read the allowlist'"
grep -Fq 'UploadTiming.meta(pending.id.uuidString, "knob_resolved_by"' "$E" \
  && echo "  ok   — and resolved_by, so the deciding rule is named" \
  || note "knob_resolved_by is not recorded — the row cannot say which rule decided"

# ── 6. THE PROXY SKIP DEFAULTS TO TODAY'S BEHAVIOUR ────────────────────────
# MEASURED: extraction is 8-13s of LOCAL work on a 45 MB clip, and B2 has shown
# the worker never reads it on the ChatCut route. Skipping it also releases the
# dispatcher's `sourceUploadCompleted && proxyUploadFinished` gate, so the job
# POSTs as soon as the source lands.
#
# THE DEFAULT RUNS THE OPPOSITE WAY TO shrink AND parallel, deliberately.
# Those default OFF because turning them on is the change. This defaults ON
# because SKIPPING is the change: an absent field, an older server or an
# unreadable answer must never silently drop a proxy the worker still wants.
printf '%s' "$body" | grep -Eq '^[[:space:]]*var proxy = true' \
  && echo "  ok   — proxy defaults TRUE, so absent/unreadable leaves today's behaviour" \
  || note "proxy does not default to true — an older server or an unreadable answer would silently stop sending a proxy the worker may still read"
printf '%s' "$body" | grep -Fq 'if let p = up["proxy"] as? Bool { proxy = p }' \
  && echo "  ok   — only an explicit boolean changes it" \
  || note "the proxy field is not parsed as an explicit Bool — a missing key must not be read as false"

# The gate must be on the EXTRACTION, not merely on the upload: the cost is the
# encode, and uploading nothing still leaves 8-13s of local work spent.
# Window ends at the "FAILED" log line, which is the last line of the else
# branch — an indentation-matched closing brace stopped short of the call.
ext="$(sed -n '/let wantProxy = onboardingState.uploadProxyEnabled/,/proxy-extract FAILED/p' "$E")"
printf '%s' "$ext" | grep -Fq 'if !wantProxy {' \
  && printf '%s' "$ext" | grep -Fq 'VideoProxyExtractor.extract' \
  && echo "  ok   — the extraction itself is skipped, not just the upload" \
  || note "the proxy gate does not wrap VideoProxyExtractor.extract — skipping only the upload still pays the 8-13s encode"

# ── 7. TAP-TO-POST IS RECORDED ─────────────────────────────────────────────
grep -Fq 'UploadTiming.mark(video.id.uuidString, "job_posted")' "$E" \
  && echo "  ok   — t_job_posted marks the moment the server accepted the job" \
  || note "nothing records tap-to-POST — total_ms ends at dispatch and cannot answer how long the user waited before the job existed"

[ "$fail" = 0 ] && echo "upload-knobs-gate: PASS" || echo "upload-knobs-gate: FAIL"
exit "$fail"
