#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# reedit-contract-gate.sh — the client's models must decode the server's actual
# bodies.
#
# BEHAVIOURAL, NOT A GREP, and this gate exists because a grep would have passed
# the bug that prompted it. ReeditInFlight declared `in_flight_job_id`; server.js
# sends `job_id`. Both files read perfectly alone. The decode failed with
# keyNotFound — and it failed behind a `try?` in APIService, so it did not throw:
# `inFlight` came back nil, the `if let` fell through, and the caller got a
# generic "Re-edit failed". Every typed-409 state in the composer — parked,
# locked-rendering — was unreachable, and nothing anywhere said so.
#
# That is the shape this repo keeps paying for: an empty success sitting next to
# a carefully handled throw. So the assertions below run REAL bodies, copied
# from server.js's own response construction, through the REAL models lifted out
# of the shipped file.
#
# The bodies are duplicated here deliberately. This gate's job is to fail when
# the server's shape and the client's model drift apart, so it must hold its own
# copy of what the server sends; deriving it from the client would make the two
# sides agree by construction and prove nothing.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 1

command -v swift >/dev/null 2>&1 || { echo "reedit-contract-gate: SKIPPED — no swift toolchain"; exit 0; }
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

cp Models/ReeditVersions.swift "$WORK/models.swift" || exit 1

# JobCreateResponse lives in Models.swift, which pulls in SwiftUI and cannot be
# compiled standalone. Lift the struct itself — the SHIPPED source, isolated. A
# retyped copy here would test the gate's idea of the model, not the model.
python3 - "$WORK" <<'LIFT'
import sys, pathlib
work = pathlib.Path(sys.argv[1])
src = pathlib.Path('Models/Models.swift').read_text(encoding='utf-8')
# EXACT, NOT A PREFIX. 'struct JobCreateResponse' is a substring of
# 'struct JobCreateResponseX', so a renamed struct lifted cleanly and failed as
# a compiler error instead of this check's own message. Third instance of that
# blind spot today; match the declaration as it is actually written.
m = 'struct JobCreateResponse: Codable'
if m not in src:
    (work / 'jobcreate.swift').write_text('// MISSING\n'); sys.exit(0)
i = src.index(m); j = src.index('{', i); d = 0; k = j
while True:
    if src[k] == '{': d += 1
    elif src[k] == '}':
        d -= 1
        if d == 0: break
    k += 1
(work / 'jobcreate.swift').write_text('import Foundation\n' + src[i:k+1] + '\n', encoding='utf-8')
LIFT
grep -q "MISSING" "$WORK/jobcreate.swift" && { echo "  ✗ JobCreateResponse is gone from Models.swift"; echo "reedit-contract-gate: FAIL"; exit 1; }

cat > "$WORK/main.swift" <<'SWIFT'
import Foundation

var failures = 0
func check(_ ok: Bool, _ good: String, _ bad: String) {
    print("  \(ok ? "✓" : "✗") \(ok ? good : bad)")
    if !ok { failures += 1 }
}
func decode<T: Decodable>(_ t: T.Type, _ json: String) -> T? {
    try? JSONDecoder().decode(t, from: Data(json.utf8))
}

// ── the 409, verbatim from server.js's reedit_in_flight branch ──────────────
let body409 = #"{"error":"reedit_in_flight","job_id":"live-1","status":"needs_input","version":2,"root_job_id":"root-9"}"#
if let f = decode(ReeditInFlight.self, body409) {
    check(true, "the real 409 decodes", "")
    check(f.jobId == "live-1", "the live job id is read from `job_id`",
          "the 409 decodes but its job id is nil — the server spells it `job_id`")
    check(f.isParkedOnAQuestion, "status needs_input reads as parked-on-a-question",
          "needs_input no longer reads as parked — the composer would show rendering copy")
    check(f.version == 2 && f.rootJobId == "root-9", "version and root are read", "version/root not read")
} else {
    check(false, "", "the real 409 body does NOT decode — every typed-409 state is unreachable, silently, behind try?")
}

// A rendering lock must read differently from a parked one.
if let f = decode(ReeditInFlight.self, #"{"error":"reedit_in_flight","job_id":"l","status":"processing","root_job_id":"r"}"#) {
    check(f.isRendering && !f.isParkedOnAQuestion, "status processing reads as rendering",
          "processing does not read as rendering")
} else { check(false, "", "a processing 409 does not decode") }

// TOLERANCE: losing an informational field must not cost the typed error.
check(decode(ReeditInFlight.self, #"{"error":"reedit_in_flight","status":"needs_input"}"#) != nil,
      "a 409 missing its ids still decodes — status is what the copy turns on",
      "a 409 missing an informational id fails to decode, so the user gets a generic failure")

// A 409 with NO status must decode and read as NEITHER state. Without this the
// fallback is untested, and an untested fallback can be any string at all — one
// that accidentally equals "needs_input" would park a rendering job on a
// question nobody asked.
if let f = decode(ReeditInFlight.self, #"{"error":"reedit_in_flight","job_id":"l"}"#) {
    check(!f.isParkedOnAQuestion && !f.isRendering,
          "a statusless 409 reads as neither parked nor rendering",
          "a statusless 409 claims a state the server never sent")
} else { check(false, "", "a statusless 409 does not decode at all") }

// ── GET /api/video-jobs/:id — the additive fields ───────────────────────────
let bodyJob = #"{"id":"p1","status":"needs_input","root_job_id":"root-9","version":null,"version_count":3,"version_provisional":null,"clarification_question":"Just adjust my shirt button","clarification_retry_job_id":"parent-7","ask":null}"#
if let j = decode(ReeditJobFields.self, bodyJob) {
    check(j.clarification_question == "Just adjust my shirt button", "the question is read", "the question is not read")
    check(j.clarification_retry_job_id == "parent-7",
          "the retry target is read, and it is the PARENT not the parked row",
          "the retry target is not read — a reply would go to a row with no video")
    check(j.isParkedOnAQuestion, "a parked job reads as parked", "a parked job does not read as parked")
} else { check(false, "", "GET /api/video-jobs/:id does not decode") }

// Nulls on every park field is the ordinary case — the server sends the keys
// always, so a client never branches on presence.
if let j = decode(ReeditJobFields.self, #"{"clarification_question":null,"clarification_retry_job_id":null}"#) {
    check(!j.isParkedOnAQuestion, "an unparked job reads as unparked", "nulls read as parked")
} else { check(false, "", "a null-park body does not decode") }

// BOTH HALVES OF THE DISCRIMINATOR, separately. A retry target with no question
// must NOT read as parked — that is the original bug's exact shape: a card with
// somewhere to send a reply and nothing to show the user. And a question with
// no target must not either, since the reply would have nowhere to go.
if let j = decode(ReeditJobFields.self, #"{"clarification_question":null,"clarification_retry_job_id":"parent-7"}"#) {
    check(!j.isParkedOnAQuestion, "a retry target without a question is not parked",
          "a job with no question reads as parked — that renders a card asking nothing")
} else { check(false, "", "a target-without-question body does not decode") }
if let j = decode(ReeditJobFields.self, #"{"clarification_question":"why?","clarification_retry_job_id":null}"#) {
    check(!j.isParkedOnAQuestion, "a question without a retry target is not parked",
          "a question with no target reads as parked — the reply would have nowhere to go")
} else { check(false, "", "a question-without-target body does not decode") }

// ── GET /api/video-jobs/:id/versions ────────────────────────────────────────
let bodyVersions = #"{"root_job_id":"root-9","version_count":2,"versions":[{"job_id":"a","version":1,"status":"completed","created_at":"2026-09-01T00:00:00Z","change_request":null,"rendered_video_url":"https://x/a.mp4","thumbnail_url":null},{"job_id":"b","version":2,"status":"completed","created_at":"2026-09-02T00:00:00Z","change_request":"brighter","rendered_video_url":"https://x/b.mp4","thumbnail_url":"https://x/b.jpg"}]}"#
if let v = decode(ReeditVersionsResponse.self, bodyVersions) {
    check(v.versions.count == 2 && v.isConsistent, "the versions body decodes and is self-consistent",
          "versions decoded but version_count disagrees with the list")
    check(v.latest?.job_id == "b", "the latest version is the last entry", "latest is not the last entry")
} else { check(false, "", "the versions body does NOT decode") }

// ── POST /api/video-jobs/re-edit: `job_id` means THREE different things ─────
// 200 create → the NEW job; 409 → the job BLOCKING you; 200 ask-resume → the
// RESUMED job, in a body carrying none of the version fields. The client posts
// change_request and so should never take the third branch — but "should be
// unreachable" is exactly how the ReeditInFlight mismatch came to be written,
// and every one of these decodes behind a `try?` where a miss is a silent nil.
let create200 = #"{"success":true,"job_id":"new-1","status":"queued","mode":"render_only","parent_job_id":"p","root_job_id":"r","version":3,"version_provisional":true,"version_count":3}"#
let resume200 = #"{"success":true,"job_id":"same-1","status":"processing","resumed":true}"#
let minimal200 = #"{"job_id":"bare-1"}"#
for (label, body, expected) in [("create", create200, "new-1"),
                                ("ask-resume", resume200, "same-1"),
                                ("minimal", minimal200, "bare-1")] {
    if let r = decode(JobCreateResponse.self, body) {
        check(r.resolvedJobId == expected,
              "re-edit 200 (\(label)): the job id resolves",
              "re-edit 200 (\(label)): decoded but resolvedJobId is nil — the caller throws 'No job ID returned'")
    } else {
        check(false, "", "re-edit 200 (\(label)) does NOT decode — a silent nil behind try?, and a generic failure")
    }
}

// ── control ─────────────────────────────────────────────────────────────────
// A decoder that accepts anything proves nothing, so prove it still rejects.
check(decode(ReeditVersionsResponse.self, #"{"nope":1}"#) == nil,
      "control: a body missing required fields is still rejected",
      "control FAILED: the decoder accepts anything, so every check above is vacuous")

if failures > 0 {
    print("\nreedit-contract-gate: FAIL (\(failures))")
    exit(1)
}
print("reedit-contract-gate: PASS — client models decode the server's real bodies")
SWIFT

OUT=$(cd "$WORK" && swiftc -o probe models.swift jobcreate.swift main.swift 2>&1 && ./probe 2>&1); RC=$?
printf '%s\n' "$OUT"
exit $RC
