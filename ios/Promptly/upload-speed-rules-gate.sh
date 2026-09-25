#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# upload-speed-rules-gate.sh — THE TWO RULES THAT DECIDE A DEMO.
#
# 1. THE SHRINK HAS TO EARN ITS TIME. Shrinking is a full decode-and-re-encode
#    before a single byte is sent. If it costs more than it saves it makes the
#    upload SLOWER while looking like an optimisation, and the row still reads
#    "shrunk". The rule is: over the size floor, or on cellular (where the
#    field p10 is 0.58 Mbps and halving a file saves minutes). On Wi-Fi under
#    the floor, the original goes up untouched.
#
#    It is a CODE rule, not a flag, because it has to be right BEFORE the flag
#    reaches everyone — a rule that needs a flip to become correct is one more
#    thing to get wrong on the day.
#
# 2. A TOKEN PROBLEM MUST NOT COST A CLIP. A 257 user hit "Please sign in" at
#    the presign step, standing in front of a video they had just picked. The
#    expiry pre-check cannot see a session the SERVER has stopped accepting, so
#    a 401 gets one refresh and one retry of the same presign — once, because a
#    401 that survives a fresh token is an answer rather than a race.
set -uo pipefail
cd "$(dirname "$0")"
S="Promptly/Services/SourceShrinker.swift"
E="Promptly/Views/EditorView.swift"
A="Promptly/Services/APIService.swift"
U="Promptly/Services/AuthService.swift"
fail=0
note() { echo "  FAIL — $1"; fail=1; }
for f in "$S" "$E" "$A" "$U"; do
  [ -f "$f" ] || { echo "  FAIL — missing $f (a failed read is not a pass)"; exit 1; }
done

echo "upload-speed-rules-gate:"

# ── 1. THE SHRINK RULE EXISTS, IS PURE, AND IS 40 MB ───────────────────────
grep -Eq '^[[:space:]]*static let shrinkSizeFloor: Int64 = 40 \* 1024 \* 1024[[:space:]]*$' "$S" \
  && echo "  ok   — the size floor is 40 MB" \
  || note "shrinkSizeFloor is not 40 MB — the rule is not the one that was ruled"

worth="$(sed -n '/static func isWorthTheEncode/,/^    }/p' "$S")"
if [ -z "$worth" ]; then
  note "there is no isWorthTheEncode — the rule cannot be asserted without an asset and a network"
else
  printf '%s' "$worth" | grep -Fq 'if connection == "cellular" { return true }' \
    && echo "  ok   — cellular always shrinks, at any size" \
    || note "cellular is not an unconditional yes — on a 0.58 Mbps uplink that is minutes thrown away"
  printf '%s' "$worth" | grep -Fq 'return fileSize > shrinkSizeFloor' \
    && echo "  ok   — otherwise only files over the floor" \
    || note "the non-cellular branch does not gate on the size floor"
fi

# ── 2. THE RULE IS ACTUALLY CONSULTED, BEFORE THE TRACKS ARE READ ──────────
dec="$(sed -n '/static func decide(for asset: AVURLAsset,/,/^    }/p' "$S")"
printf '%s' "$dec" | grep -Fq 'guard isWorthTheEncode(fileSize: fileSize, connection: connection)' \
  && echo "  ok   — decide refuses on the rule before paying for a demux" \
  || note "decide does not consult isWorthTheEncode — the rule exists and governs nothing"

# ── 3. THE CALL SITE PASSES REAL VALUES, NOT CONSTANTS ─────────────────────
# A hardcoded connection here would make every upload look like Wi-Fi.
grep -Eq 'connection: ReachabilityMonitor\.currentConnectionType' "$E" \
  && echo "  ok   — the upload path passes the live connection type" \
  || note "the upload path does not pass ReachabilityMonitor.currentConnectionType — the cellular half of the rule can never fire"
grep -Eq 'fileSize: sourceSize' "$E" \
  && echo "  ok   — and the real source size" \
  || note "the upload path does not pass the real source size"

# ── 4. A BITRATE TARGET, NOT A QUALITY PRESET ──────────────────────────────
grep -Fq 'AVVideoAverageBitRateKey: targetBitrate' "$S" \
  && echo "  ok   — the export is driven by an average bitrate" \
  || note "no AVVideoAverageBitRateKey — an export preset has no bitrate API, which is why 4K/22Mbps only halved"
# NON-COMMENT LINES ONLY. The doc comment above the bitrate constant names the
# old preset to explain why it went, and a check that cannot tell an
# explanation from a call reports the comment as the defect — which is how a
# useful comment gets deleted to make a gate green.
if grep -v '^[[:space:]]*//' "$S" | grep -v '^[[:space:]]*///' | grep -Fq 'AVAssetExportPresetHEVC1920x1080'; then
  note "still CALLING AVAssetExportPresetHEVC1920x1080 — a quality preset cannot be told a bitrate"
else
  echo "  ok   — the quality preset is gone from the code (its explanation may stay in a comment)"
fi

# ── 5. THE 401 GETS ONE REFRESH AND ONE RETRY ──────────────────────────────
pres="$(sed -n '/func getUploadUrl(/,/^    }/p' "$A")"
printf '%s' "$pres" | grep -Fq 'if (response as? HTTPURLResponse)?.statusCode == 401 {' \
  && echo "  ok   — a 401 at presign is recognised" \
  || note "a 401 at presign is not handled — the user is told to sign in for a token they cannot fix"
printf '%s' "$pres" | grep -Fq 'await AuthService.shared.forceRefreshToken() != nil' \
  && echo "  ok   — and forces a refresh the expiry clock would not ask for" \
  || note "the 401 path does not force a refresh — getValidToken only refreshes near expiry, which is not this case"
# ONCE. A loop here retries an answer.
n=$(printf '%s' "$pres" | grep -c 'try await presignOnce()')
if [ "$n" -eq 2 ]; then
  echo "  ok   — exactly one retry: the first call and one after the refresh"
else
  note "presignOnce is called $n time(s) — expected exactly 2 (the attempt and one retry); a loop retries an answer"
fi

# ── 6. THE NEAR-EXPIRY REFRESH IS STILL THERE ──────────────────────────────
# The 401 retry is the SECOND line of defence; removing the first would make
# every long session depend on it.
# COUNTED, NOT MERELY PRESENT. There are TWO token-validity paths — the
# session restore on launch and getValidToken before every call — and both
# carry the 5-minute margin. A presence check passes while either one survives,
# so half the protection could be removed under a green gate.
margins=$(grep -c 'Date()\.timeIntervalSince1970 > (expiry - 300)' "$U")
if [ "$margins" -eq 2 ]; then
  echo "  ok   — both token paths still refresh within 5 minutes of expiry"
else
  note "expected 2 pre-expiry refresh margins (launch restore + getValidToken), found $margins — a near-expiry upload on the unprotected path takes a 401 round trip first"
fi

# ── 7. THE CLIP-INJECTION SEAMS MUST NOT EXIST IN A SHIPPED BINARY ─────────
# `-attachClip <path>` hands a local file straight into handlePickedVideos —
# the same entry a real pick uses. That is the only way to drive the upload
# rail without a device, because the system picker runs out of process and does
# not present under XCUITest. It is also, in a Release build, a launch argument
# that makes the app upload a file of someone else'"'"'s choosing.
#
# Checked the same way as -apiBase, and for the same reason. Each seam is
# looked up in its own function body: a single #if DEBUG somewhere in a
# 5000-line file proves nothing about the function next to it.
for seam in debugAttachClipIfRequested debugSendChatIfRequested; do
  body="$(sed -n "/private func ${seam}()/,/^    }/p" "$E")"
  if [ -z "$body" ]; then
    echo "  ok   — no ${seam} present"
    continue
  fi
  if printf '%s' "$body" | grep -Fq '#if DEBUG'; then
    echo "  ok   — ${seam} is inside #if DEBUG"
  else
    note "${seam} is NOT inside #if DEBUG — a shipped build would take a file path from a launch argument and upload it"
  fi
done

[ "$fail" = 0 ] && echo "upload-speed-rules-gate: PASS" || echo "upload-speed-rules-gate: FAIL"
exit "$fail"
