#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# upload-terminality-gate.sh — NO STARTED UPLOAD MAY END IN SILENCE.
#
# THE MEASURED PROBLEM (7 days, signed-in users): 882 started an upload and 415
# never reached a job. 148 were the intended free wall. Of the rest, 131 emitted
# NO terminal event of any kind — the largest class in the product was invisible
# by construction, so it was simultaneously the biggest and the least
# characterised.
#
# THE INVARIANT. Every pick enters the ledger at `recordPick`. It may leave by
# exactly four doors, and every one of them must EMIT:
#
#     dispatched   a job row exists          → the goal; record dropped
#     failed       died in this session      → recordFailed(reason:)
#     cancelled    user or teardown          → recordCancelled(reason:)
#     evicted      ledger overflowed         → emitted, not dropped
#     app_killed   previous session, swept   → sweepOnLaunch
#
# Two of those doors used to be silent, and both are asserted here:
#
#   1. EVICTION. `records.removeFirst(...)` discarded the oldest picks with no
#      emit at all, so a heavy user's early uploads left the ledger having
#      produced nothing.
#   2. IN-SESSION FAILURE. The catch emitted `upload_failed` but never resolved
#      the record, so the NEXT LAUNCH swept the same upload again as
#      never-started: one upload, two terminals, filed under different causes.
#
# WHY A REASON IS REQUIRED. A terminal that does not say why is the condition
# this ledger exists to end. 187 `upload_failed` events over 7 days carried the
# bare string "Upload failed", pct 0, no key and a null transport error — a
# terminal that answered nothing. So the gate checks that the resolving calls
# take a reason, not merely that they exist.
set -uo pipefail
cd "$(dirname "$0")"
R="Promptly/Services/UploadOutcomeReporter.swift"
E="Promptly/Views/EditorView.swift"
A="Promptly/Services/APIService.swift"
M="Promptly/Services/ResumableMultipartUploader.swift"
fail=0
note() { echo "  FAIL — $1"; fail=1; }
for f in "$R" "$E" "$A" "$M"; do
  [ -f "$f" ] || { echo "  FAIL — missing $f (a failed read is not a pass)"; exit 1; }
done
# Comments must never satisfy an assertion: every pattern is anchored at line
# start. A gate of mine passed on commented-out code once already.
has() { grep -Eq "^[[:space:]]*$2" "$1"; }

echo "upload-terminality-gate:"

# ── 1. All four in-session doors exist and resolve the record ────────────────
has "$R" 'func recordFailed\(id: UUID, reason: String\)' \
  && echo "  ok   — failed is a door, and it takes a reason" \
  || note "recordFailed(id:reason:) is missing — an in-session failure leaves the record open"
has "$R" 'func recordCancelled\(id: UUID, reason: String\)' \
  && echo "  ok   — cancelled is its own door, with a reason" \
  || note "recordCancelled(id:reason:) is missing — cancellation is not failure and needs its own class"
has "$R" 'func recordDispatched\(id: UUID\)' \
  && echo "  ok   — dispatched closes the record" \
  || note "recordDispatched is missing — a successful upload would be swept as never-started"
has "$R" 'func sweepOnLaunch\(\)' \
  && echo "  ok   — app_killed is swept on the next launch" \
  || note "sweepOnLaunch is missing — an app killed mid-upload reports nothing, ever"

# ── 2. EVICTION MUST NOT BE A SILENT EXIT ───────────────────────────────────
if grep -Eq '^[[:space:]]*records\.removeFirst' "$R"; then
  # It may only remove AFTER emitting for what it is about to drop.
  if grep -B4 '^[[:space:]]*records\.removeFirst' "$R" | grep -Eq 'emitTerminal\(.*outcome: "evicted"'; then
    echo "  ok   — evicted records are reported before they are dropped"
  else
    note "the ledger evicts records with no terminal — a heavy user's early uploads vanish"
  fi
else
  echo "  ok   — no unguarded removeFirst in the ledger"
fi

# ── 3. THE FAILURE PATH MUST CLOSE THE RECORD ───────────────────────────────
# Scoped to the catch that emits upload_failed, not the whole file.
if grep -A14 -F 'Analytics.track("upload_failed", props: failProps' "$E" \
   | grep -Eq 'UploadOutcomeReporter\.shared\.record(Failed|Cancelled)\(' ; then
  echo "  ok   — the failure catch resolves the ledger record"
else
  note "the upload_failed catch does not resolve the record — the next launch counts it AGAIN as never-started"
fi
grep -A14 -F 'Analytics.track("upload_failed", props: failProps' "$E" \
  | grep -Eq 'CancellationError|NSURLErrorCancelled' \
  && echo "  ok   — cancellation is separated from failure at the catch" \
  || note "the catch files cancellation as failure — different cause, different fix"

# ── 4. THE UPLOAD DOOR MUST NAME ITS REFUSAL ────────────────────────────────
has "$A" 'case uploadURLRefused\(status: Int, reason: String\)' \
  && echo "  ok   — the upload door has a typed, reasoned refusal" \
  || note "uploadURLRefused is gone — a refused presign would be a bare 'Upload failed' again"
if sed -n '/func getUploadUrl/,/^    }/p' "$A" \
   | grep -Fq 'guard (200...299).contains(status)'; then
  echo "  ok   — getUploadUrl checks the HTTP status before decoding"
else
  note "getUploadUrl does not check status — an all-optional error body decodes cleanly as success"
fi

# ── 4b. REPORTING IS NOT RECOVERING ─────────────────────────────────────────
# The orphan reconcile correctly REPORTED killed uploads and gave the user
# nothing back: 94 people re-picked and re-waited in one week. Recovery must
# survive the two things that actually happen — no stuck message to attach to,
# and a staged file the OS reclaimed between launches.
sed -n '/private func reconcileStaleUploads/,/^    }/p' "$E" | grep -Fq 'offerOrphanRecovery' \
  && echo "  ok   — a recoverable orphan with no stuck message is still offered back" \
  || note "reconcileStaleUploads returns without offering recovery — it reports the loss and stops"
grep -Fq 'var isRetryable: Bool { sourcePath != nil || assetLocalIdentifier != nil }' "$R" \
  && echo "  ok   — recoverable means staged file OR library asset" \
  || note "retryability is staged-file-only — an OS-cleared temp copy writes off a video still in the library"
sed -n '/private func offerOrphanRecovery/,/^    }/p' "$E" | grep -Fq 'needsRematerialize' \
  && echo "  ok   — auto-restart when staged, ask first when it costs an iCloud pull" \
  || note "recovery does not distinguish a staged restart from an iCloud re-materialize"
grep -Fq 'assetLocalIdentifier: pending.assetLocalIdentifier' "$E" \
  && echo "  ok   — the library identity is recorded at pick time" \
  || note "recordPick does not persist the asset identifier — nothing to recover from once the temp copy is gone"

# ── 4c. THE SHRINK SHIPS DARK, AND FAILS SOFT ───────────────────────────────
# It changes the bytes of every upload, so it must default OFF and an absent
# server field must never read as enabled. And a failed optimisation must never
# cost someone their upload — the original has to survive a bad export.
O="Promptly/Services/OnboardingState.swift"
S2="Promptly/Services/SourceShrinker.swift"
if [ ! -f "$O" ] || [ ! -f "$S2" ]; then note "missing shrink files"; else
  grep -Eq '^[[:space:]]*@Published private\(set\) var uploadShrinkEnabled = false' "$O" \
    && echo "  ok   — the shrink flag defaults OFF" \
    || note "uploadShrinkEnabled does not default to false — an absent field could arm it"
  grep -Fq 'uploadShrinkEnabled = (obj?["upload_shrink"] as? String) == "on"' "$O" \
    && echo "  ok   — it arms only on an explicit \"on\"" \
    || note "the shrink flag arms on something other than an explicit \"on\""
  # try? , not try: a throw must leave `shrunk` nil so the ORIGINAL uploads.
  grep -Fq 'shrunk = try? await SourceShrinker.shrink(sourceUrl)' "$E" \
    && echo "  ok   — a failed shrink falls back to the original, never fails the upload" \
    || note "the shrink is not fail-soft — a bad export would cost the user their upload"
  sed -n '/static func shrink/,/^    }/p' "$S2" | grep -Fq 'AVAssetExportPresetHEVC1920x1080' \
    && echo "  ok   — HEVC 1080p, the target B1 confirmed both ways" \
    || note "the shrink is not exporting HEVC 1080p"
  sed -n '/static func shrink/,/^    }/p' "$S2" | grep -Fq 'AVVideoTransferFunction_ITU_R_709_2' \
    && echo "  ok   — HDR is tone-mapped in the same pass" \
    || note "no tone-mapping — an HDR source would land grey and washed out"
fi

# ── 5. ERROR CODES MUST BE STABLE ACROSS BUILDS ─────────────────────────────
# Implicit enum tags renumber when a case is inserted; that is why one error
# read as 7 on 1.3.34 and 8 on 1.3.37 and cost most of an investigation.
grep -Eq '^extension APIError: CustomNSError[[:space:]]*\{' "$A" \
  && echo "  ok   — APIError codes are explicit, not declaration-order tags" \
  || note "APIError has no CustomNSError conformance — inserting a case silently renumbers every other error"

# ── 6. ONE TERMINAL PER UPLOAD, NOT ONE PER PART ────────────────────────────
sed -n '/private func giveUp/,/^    }/p' "$M" | grep -Fq 'guard !gaveUp.contains(uploadId)' \
  && echo "  ok   — a multi-part failure gives up once, not once per part" \
  || note "giveUp is not idempotent — one failed upload emits one event per part (measured: 353 events, 2 uploads)"

[ "$fail" = 0 ] && echo "upload-terminality-gate: PASS" || echo "upload-terminality-gate: FAIL"
exit "$fail"
