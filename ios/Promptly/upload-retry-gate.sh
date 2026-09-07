#!/bin/bash
# A CONFIRMED UPLOAD IS NEVER RETRIED — and no upload task is ever created from
# a source that is not on disk.
#
# THE DEFECT (PROMPTLY-IOS-2Y/2Z/31/37, ~625 users). The staged source copy is
# deleted the instant its upload confirms. Two paths then re-entered the upload
# with that path: the multipart scheduler rebuilt chunks from a manifest whose
# `sourcePath` was gone, and `uploadSourceNeverWorse` fell through to a single
# PUT of the same vanished file. Both handed a dead path to
# `uploadTask(with:fromFile:)`, which raises an ObjC NSInvalidArgumentException
# — not a Swift error — and killed the app.
#
# The fences at the task-creation sites stop the CRASH. They do not stop the
# retry, and a retry that can only ever fail is the actual bug. This gate holds
# the state machine: a missing source is TERMINAL (give up, clear state), never
# something to reschedule.
set -uo pipefail
cd "$(dirname "$0")"
python3 - <<'PYEOF'
import re, sys
fails = []

mp = open("Promptly/Services/ResumableMultipartUploader.swift").read()
sched = mp[mp.index("private func scheduleRemaining"):]
sched = sched[:sched.index("\n    /// Called on app foreground")] if "\n    /// Called on app foreground" in sched else sched[:6000]
if "isReadableFile(atPath: manifest.sourcePath)" not in sched:
    fails.append("scheduleRemaining does not verify the manifest source is still on disk")
if "giveUp(uploadId:" not in sched:
    fails.append("scheduleRemaining does not GIVE UP on a vanished source — it must not reschedule")
# The guard must come BEFORE any chunk write, or we write from a dead path first.
if "isReadableFile(atPath: manifest.sourcePath)" in sched and "MultipartChunker.writePart" in sched:
    if sched.index("isReadableFile(atPath: manifest.sourcePath)") > sched.index("MultipartChunker.writePart"):
        fails.append("the source guard sits AFTER the chunk write — it guards nothing")

api = open("Promptly/Services/APIService.swift").read()
nw = api[api.index("func uploadSourceNeverWorse"):]
nw = nw[:nw.index("func uploadFileToS3Foreground")]
if "isReadableFile(atPath: sourceUrl.path)" not in nw:
    fails.append("the never-worse fall-through re-uploads without checking the source exists")
# The check may now RECOVER instead of throwing, but it must still gate: a
# re-stage that returns nil, or no re-stage at all, still has to fail.
if "guard let restaged = await restageSource?()" not in nw:
    fails.append("the missing-source guard no longer requires a usable re-staged file")
if "restageSource: (() async -> URL?)?" not in nw:
    fails.append("uploadSourceNeverWorse cannot be handed a fresh source")
# And the fresh copy must be what is uploaded — not the path already proven gone.
if "fileUrl: sourceUrl" not in nw:
    fails.append("the upload still sends the original path after re-staging")
else:
    if nw.index("isReadableFile(atPath: sourceUrl.path)") > nw.index("try await uploadFileToS3("):
        fails.append("the never-worse guard sits after the fall-through upload — it guards nothing")

# Every background upload-task creation stays fenced (the crash fence itself).
for f, needle in [("Promptly/Services/BackgroundUploadManager.swift", "isReadableFile"),
                  ("Promptly/Services/ResumableMultipartUploader.swift", "isReadableFile")]:
    src = open(f).read()
    if "uploadTask(with:" in src and needle not in src:
        fails.append(f"{f}: creates an upload task with no source fence")

if fails:
    print("upload-retry-gate: FAIL")
    for x in fails: print("   ✗", x)
    sys.exit(1)
print("upload-retry-gate: PASS — a vanished source is terminal (give up + clear), "
      "never rescheduled; both retry paths guard before re-uploading; task sites fenced")
PYEOF
# THE HEREDOC'S EXIT CODE WAS BEING DISCARDED. `sys.exit(1)` inside it printed
# "upload-retry-gate: FAIL" and the script carried on to `exit 0`, so every
# assertion in that block was advisory — it could fail loudly and still pass.
# Found by RED-proving four new assertions and watching all four stay green.
PY_RC=$?
if [ "$PY_RC" -ne 0 ]; then
  echo "upload-retry-gate: FAIL — source-guard assertions"
  exit 1
fi

# ── UNS 2-6 (ruled 2026-09-06) ───────────────────────────────────────────────
# 316 users in 14 days, split `picked` 246 / `uploaded` 133. These assert the
# four mechanisms that close it, in source, so none can quietly come back.
UNS_FAIL=0
API=Promptly/Services/APIService.swift
EV=Promptly/Views/EditorView.swift
REP=Promptly/Services/UploadOutcomeReporter.swift
# NO PIPE INTO grep -q. Under `set -o pipefail` the -q exits on first match and
# the upstream takes SIGPIPE, so the pipeline reports failure on a SUCCESSFUL
# match — which silently inverts every check. Read once, match against the text.
API_CODE=$(grep -vE '^[[:space:]]*(//|///)' "$API")
EV_CODE=$(grep -vE '^[[:space:]]*(//|///)' "$EV")
REP_CODE=$(grep -vE '^[[:space:]]*(//|///)' "$REP")

# 2. EVERY upload is a background upload. A foreground session drops the task
#    the moment the app suspends, which is the whole `picked` class.
if grep -q "uploadFileToS3Foreground" <<<"$EV_CODE"; then
  echo "  a foreground upload is back — it will die on suspend"; UNS_FAIL=1
fi
grep -q "BackgroundUploadManager.shared.upload" <<<"$API_CODE" || {
  echo "  uploads no longer route through the background session"; UNS_FAIL=1; }

# 3. No job row until the bytes are in. The coordinator must wait for the upload
#    to complete before it calls createVideoJob — a job row with nothing behind
#    it IS UploadNeverStarted.
if ! awk '/func dispatch\(/,/createVideoJob/' Promptly/Services/JobDispatchCoordinator.swift \
     | grep -q "waitForUpload"; then
  echo "  createVideoJob no longer waits for the upload"; UNS_FAIL=1
fi

# 4. Retries with backoff before any message reaches the user.
grep -q "static let backoff: \[TimeInterval\]" Promptly/Services/JobDispatchCoordinator.swift || {
  echo "  the dispatch backoff schedule is gone"; UNS_FAIL=1; }

# 5. The launch reconcile. Reporting a dead upload is not recovering it: the old
#    sweep emitted an obituary and deleted the record, leaving the job hanging.
grep -q "reconcileStaleUploads" <<<"$EV_CODE" || {
  echo "  the launch reconcile is gone"; UNS_FAIL=1; }
grep -qF "func sweepOnLaunch() -> [StaleUpload]" <<<"$REP_CODE" || {
  echo "  sweepOnLaunch no longer classifies stale uploads"; UNS_FAIL=1; }
grep -q "isRetryable" <<<"$REP_CODE" || {
  echo "  stale uploads are no longer split into retryable and terminal"; UNS_FAIL=1; }
grep -q "upload_reconcile_failed" <<<"$EV_CODE" || {
  echo "  a terminal upload is no longer failed-and-refunded"; UNS_FAIL=1; }

if [ "$UNS_FAIL" -ne 0 ]; then
  echo "upload-retry-gate: FAIL — UNS 2-6"
  exit 1
fi
echo "upload-retry-gate: UNS 2-6 — background everywhere, job after bytes, backoff, reconcile."


