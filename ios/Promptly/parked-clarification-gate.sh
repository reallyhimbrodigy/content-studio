#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# parked-clarification-gate.sh — a parked re-edit must reach the user, and the
# answer must go where the server can take it.
#
# THE DEFECT THIS CLOSES, measured before it was fixed: 19 rows, 8 distinct
# users, oldest parked 62 days, ZERO ever recovered. Every one of them had the
# question sitting in `result.clarification_question` — a field the poll's own
# SELECT had always asked for and nothing ever decoded. The user saw a progress
# bar held at 100% under "Finalizing your video…", forever.
#
# It survived because every half pointed at another half:
#   · the poll's needs_input branch required a renderable `ask`, and deferred
#     the rest to "the SSE clarification path";
#   · that path keys on `event.status == "needs_clarification"`, but the server
#     computes a frame's status purely from pct and the worker sends pct=100
#     with this step — so the frame says "completed" and the branch never ran;
#   · the client's own needs_input carve-out in the SSE handler keys on a
#     status value the server has never put on the wire.
# Three references, no destination. That is what this gate makes impossible.
#
# WHY THE ANSWER ROUTE IS ASSERTED TOO. `/answer-ask` cannot accept these:
# canAcceptAnswer rejects a null `ask` column with ask_id_mismatch, and that
# column has never been written in production. An answer posted there 409s
# silently and the user is parked again. So the route is part of the fix, not an
# implementation detail.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 1

python3 <<'PY'
import sys, pathlib

def decomment(src):
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c == '"':
            out.append(c); i += 1
            while i < n:
                if src[i] == '\\' and i + 1 < n:
                    out.append(src[i:i+2]); i += 2; continue
                out.append(src[i])
                if src[i] == '"': i += 1; break
                i += 1
            continue
        if src.startswith('//', i):
            j = src.find('\n', i); i = n if j < 0 else j; continue
        if src.startswith('/*', i):
            j = src.find('*/', i); i = n if j < 0 else j + 2; continue
        out.append(c); i += 1
    return ''.join(out)

def read(p): return decomment(pathlib.Path(p).read_text(encoding='utf-8'))

def block(src, marker):
    i = src.find(marker)
    if i < 0: return ''
    j = src.index('{', i); depth = 0; k = j
    while k < len(src):
        if src[k] == '{': depth += 1
        elif src[k] == '}':
            depth -= 1
            if depth == 0: return src[j:k+1]
        k += 1
    return ''

fails = []
def check(ok, good, bad):
    print(f"  {'✓' if ok else '✗'} {good if ok else bad}")
    if not ok: fails.append(bad)

ED = read('Views/EditorView.swift')
AC = read('Views/AskCard.swift')
MB = read('Views/MessageBubble.swift')

# ── 1. The question is decoded ───────────────────────────────────────────────
RESULT = block(ED, 'struct JobResult')
check('clarification_question' in RESULT,
      "the poll decodes result.clarification_question",
      "clarification_question is not decoded — the question stays on the wire, unread")

# ── 2. The answer's target is fetched ────────────────────────────────────────
# Both halves: asking for the column, and having somewhere to put it. Either one
# alone leaves the branch permanently unreachable — an inert half.
check('parent_job_id' in block(ED, 'struct JobStatusRow'),
      "the row model carries parent_job_id",
      "parent_job_id is not on the row model — the answer has no target")
check('select=status' in ED and 'parent_job_id' in ED[ED.index('select=status'):ED.index('select=status')+400],
      "the REST select asks for parent_job_id",
      "the select does not request parent_job_id — it would always decode nil")

# ── 3. The needs_input branch surfaces it instead of returning ───────────────
# Scoped to the branch. `clarification` appears all over this file; what matters
# is that THIS branch assigns it, and that the bubble stops feigning a finish.
NEEDS = ED[ED.index('case "needs_input":'):] if 'case "needs_input":' in ED else ''
NEEDS = NEEDS[:NEEDS.find('default:')] if 'default:' in NEEDS else NEEDS
check('ParkedClarification(' in NEEDS,
      "a parked clarification is surfaced to the bubble",
      "the needs_input branch no longer builds a ParkedClarification — the user sees nothing again")
# RETRACTION: a withdrawn question must clear the card, not sit there.
# AND, NOT OR. The first version accepted either the log line or the
# assignment, so deleting the assignment left the log string satisfying it —
# a gate green on a card that never clears. Assert the WRITE, which is the
# behaviour; the log line is not evidence of anything.
check('messages[idx].clarification = nil' in NEEDS,
      "a withdrawn question retracts the card",
      "a cleared question leaves the card on screen with nothing to answer")

check('isFinishing = false' in NEEDS,
      "a parked bubble stops animating a finish it will never reach",
      "isFinishing is not cleared — the bubble holds at 100% under the question")

# ── 4. The answer goes to the re-edit route, never to answer-ask ─────────────
# THE ANSWER MOVED, THE PROPERTIES DID NOT (ruled 2026-09-22). The card used to
# own a composer and post for itself; re-edit is the chat now, so the reply
# travels the same send path a typed change does. These assertions follow it to
# EditorView rather than being dropped with the card — what had to stay true is
# still true, just somewhere else.
SEND = block(ED, 'private func sendReedit(')
check(bool(SEND), "sendReedit is the one place an answer is dispatched",
      "sendReedit is gone — a parked question cannot be answered")
check('reeditFromJob(' in SEND and 'originalJobId: originalJobId' in SEND,
      "the answer starts a new re-edit against the id it was given",
      "sendReedit no longer posts reeditFromJob against its target")
check('answerAsk(' not in SEND,
      "the answer does not go to /answer-ask",
      "the answer posts to /answer-ask — canAcceptAnswer 409s on a null ask column, silently re-parking the user")
check('APIError.reeditInFlight' in SEND,
      "a 409 is distinguished from a transport failure",
      "a 409 falls into the generic catch — the user is told to check their connection over a server decision")

# And the PARENT is what a tapped choice carries, since the parked row itself
# has no render to re-edit.
CHOICE = block(ED, 'private func clarificationChoiceClosure()')
check('parentJobId' in CHOICE and 'sendReedit(' in CHOICE,
      "a tapped choice is sent against the parked row's PARENT",
      "a tapped choice no longer targets the parent — the parked row has no video to re-edit")

# ── 5. The bubble renders it ─────────────────────────────────────────────────
check('ClarificationCard(' in MB,
      "the bubble renders the clarification card",
      "MessageBubble does not render ClarificationCard — decoded and never shown")

# ── controls ─────────────────────────────────────────────────────────────────
assert block("func s() { body }", 'func s') == '{ body }', "CONTROL FAILED: block() broken"
assert block("nope", 'func s') == '', "CONTROL FAILED: block() invents a body"
assert 'x' not in decomment("code // x"), "CONTROL FAILED: decomment dead"
print("  · controls: block() brackets a real body, returns empty for an absent one")

if fails:
    print(f"\nparked-clarification-gate: FAIL ({len(fails)})")
    sys.exit(1)
print("parked-clarification-gate: PASS")
PY
