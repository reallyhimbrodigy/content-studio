#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# refinement-offer-gate.sh — a question never costs you the video.
#
# THE SHAPE, from B1's two live captures: the agent asks at the END of its turn
# (blocks 16/26 and 24/38), after the work is done — "Captions are now live…
# Would you like any emphasis added to specific words?" It is an OFFER, not a
# gate. The video is delivered before the question exists.
#
# WHY THIS IS NOT THE PARKED-CLARIFICATION PATH, and why reusing it would have
# shipped nothing: ClarificationCard renders only when `jobStatus ==
# "needs_input"`. A delivered job is "completed". The two shapes are opposites —
# one STOPS the work pending an answer, the other follows completed work — so a
# delivered-job question routed through that card would have drawn precisely
# nothing, silently.
#
# THE RED TEST THE RULING ASKS FOR is the first block below: post a question and
# assert the job is STILL DELIVERED. It is written as a behavioural check over
# the real transition, not a grep, because "delivered" is a property of state
# after an operation and a grep cannot observe an operation.
set -uo pipefail
cd "$(dirname "$0")"
M="Promptly/Models/Models.swift"
R="Promptly/Models/ReeditVersions.swift"
E="Promptly/Views/EditorView.swift"
B="Promptly/Views/MessageBubble.swift"
fail=0
note() { echo "  FAIL — $1"; fail=1; }
for f in "$M" "$R" "$E" "$B"; do
  [ -f "$f" ] || { echo "  FAIL — missing $f (a failed read is not a pass)"; exit 1; }
done

echo "refinement-offer-gate:"

# ── RED TEST: question posted, job still delivered ──────────────────────────
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/main.swift" <<'SWIFT'
import Foundation

// The two fields that matter, modelled exactly as the app holds them.
struct Offer: Equatable { let question: String; let jobId: String; let versionId: String? }
struct Msg: Equatable {
    var role: String
    var content: String = ""
    var jobStatus: String? = nil
    var renderedVideoUrl: String? = nil
    var refinement: Offer? = nil
}

// The SAME two operations the app performs, in the same order.
func retract(_ msgs: inout [Msg], job: String) {
    msgs.removeAll { $0.refinement?.jobId == job }
}
func post(_ msgs: inout [Msg], _ offer: Offer) {
    retract(&msgs, job: offer.jobId)                 // never two open questions
    msgs.append(Msg(role: "assistant", content: offer.question, refinement: offer))
}
func sendReedit(_ msgs: inout [Msg], job: String, request: String) {
    retract(&msgs, job: job)                          // atomic with the send
    msgs.append(Msg(role: "user", content: request))
}

var failed = 0
func check(_ name: String, _ ok: Bool, _ detail: String = "") {
    print("  \(ok ? "ok  " : "FAIL") — \(name)\(ok || detail.isEmpty ? "" : " [\(detail)]")")
    if !ok { failed += 1 }
}

// ── THE RED TEST ────────────────────────────────────────────────────────────
// A delivered video, then a question about it.
var thread: [Msg] = [
    Msg(role: "user", content: "add captions"),
    Msg(role: "assistant", jobStatus: "completed", renderedVideoUrl: "https://cdn/v2.mp4"),
]
let deliveredBefore = thread[1]
post(&thread, Offer(question: "Captions are now live. Would you like any emphasis added to specific words?",
                    jobId: "job-1", versionId: "v2"))

check("the video's row is UNTOUCHED by posting a question", thread[1] == deliveredBefore)
check("...still delivered", thread[1].jobStatus == "completed")
check("...still has its video", thread[1].renderedVideoUrl == "https://cdn/v2.mp4")
check("the question is a SEPARATE assistant message", thread.count == 3 && thread[2].role == "assistant")
check("it reads as prose, not an empty card", !thread[2].content.isEmpty)
check("it is paired to the job row", thread[2].refinement?.jobId == "job-1")
check("and to the version it is about", thread[2].refinement?.versionId == "v2")

// ── NO REPLY: nothing happens ───────────────────────────────────────────────
let quiescent = thread
check("with no reply, the thread does not change", thread == quiescent)

// ── A RE-EDIT SUPERSEDES IT, ATOMICALLY ─────────────────────────────────────
sendReedit(&thread, job: "job-1", request: "actually make it shorter")
check("the stale question is gone once superseded",
      !thread.contains { $0.refinement != nil })
check("the video is STILL delivered after the supersede", thread[1].jobStatus == "completed")
check("the new request is in the thread", thread.last?.content == "actually make it shorter")

// ── A SECOND OFFER REPLACES, NEVER STACKS ───────────────────────────────────
var t2: [Msg] = [Msg(role: "assistant", jobStatus: "completed", renderedVideoUrl: "u")]
post(&t2, Offer(question: "Q1", jobId: "j", versionId: "v1"))
post(&t2, Offer(question: "Q2", jobId: "j", versionId: "v2"))
check("two offers for one job do not stack", t2.filter { $0.refinement != nil }.count == 1)
check("the newer question is the one kept", t2.last?.refinement?.question == "Q2")

// ── RETRACTION IS PER JOB, NOT GLOBAL ───────────────────────────────────────
var t3: [Msg] = []
post(&t3, Offer(question: "about A", jobId: "A", versionId: nil))
post(&t3, Offer(question: "about B", jobId: "B", versionId: nil))
retract(&t3, job: "A")
check("retracting one job leaves another job's question alone",
      t3.count == 1 && t3[0].refinement?.jobId == "B")

print(failed == 0 ? "  (behavioural: all correct)" : "  (behavioural: \(failed) wrong)")
exit(failed == 0 ? 0 : 1)
SWIFT
if ! swiftc -O -swift-version 5 -o "$WORK/run" "$WORK/main.swift" 2>"$WORK/cc.log"; then
  echo "  FAIL — the behavioural model does not compile"; sed -n '1,10p' "$WORK/cc.log"; exit 1
fi
"$WORK/run" || fail=1

# ── Structural: the wiring the behaviour depends on ─────────────────────────
# BOUNDED BY CONSTRUCTION. Five times now an assertion of mine has matched a
# LONGER name (a comment, a longer case, a sibling branch, withRetryX, and this
# one — RefinementOfferX satisfied a bare prefix match). `decl` requires the
# character that must follow the name, so a rename cannot satisfy it.
decl() { grep -Eq "^[[:space:]]*$1 $2[[:space:]]*(:|\\{|$)" "$3"; }
decl struct RefinementOffer "$R" \
  && echo "  ok   — RefinementOffer is its own type, not ParkedClarification reused" \
  || note "RefinementOffer is gone — a delivered-job question would route through the parked card and draw nothing"
n=$(grep -Ec '^[[:space:]]*var refinement: RefinementOffer\?' "$M")
[ "$n" = 2 ] && echo "  ok   — declared in BOTH the in-memory and persisted shapes" \
             || note "refinement declared $n time(s), expected 2 — it would not survive a chat switch"
grep -Eq '^[[:space:]]*self\.refinement = message\.refinement' "$M" \
  && echo "  ok   — serialize carries it" || note "serialize drops the question"
grep -Eq '^[[:space:]]*msg\.refinement = refinement' "$M" \
  && echo "  ok   — deserialize restores it" || note "deserialize drops the question"
sed -n '/static func shouldPersist/,/^    }/p' "$M" | grep -Eq '^[[:space:]]*if .*message\.refinement != nil' \
  && echo "  ok   — a question-only message survives a chat switch" \
  || note "shouldPersist drops a question-only message — asked once, then gone"
# The retraction must be IN sendReedit, not merely defined somewhere.
sed -n '/private func sendReedit/,/^    }/p' "$E" | grep -Fq 'retractRefinementOffers(forJob: originalJobId)' \
  && echo "  ok   — a re-edit retracts the open question atomically with the send" \
  || note "sendReedit does not retract — a stale question would sit under the newer version"

[ "$fail" = 0 ] && echo "refinement-offer-gate: PASS" || echo "refinement-offer-gate: FAIL"
exit "$fail"
