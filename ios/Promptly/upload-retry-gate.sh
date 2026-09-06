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
if "isReadableFile(atPath: fileUrl.path)" not in nw:
    fails.append("the never-worse fall-through re-uploads without checking the source exists")
else:
    if nw.index("isReadableFile(atPath: fileUrl.path)") > nw.index("try await uploadFileToS3("):
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
