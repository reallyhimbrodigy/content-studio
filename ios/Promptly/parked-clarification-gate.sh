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
check('isFinishing = false' in NEEDS,
      "a parked bubble stops animating a finish it will never reach",
      "isFinishing is not cleared — the bubble holds at 100% under the question")

# ── 4. The answer goes to the re-edit route, never to answer-ask ─────────────
SUBMIT = block(AC[AC.index('struct ClarificationCard'):], 'private func submit') if 'struct ClarificationCard' in AC else ''
check(bool(SUBMIT), "ClarificationCard has a submit path",
      "ClarificationCard.submit is gone — the question cannot be answered")
check('reeditFromJob(' in SUBMIT and 'parentJobId' in SUBMIT,
      "the answer starts a new re-edit against the PARENT",
      "the answer does not target the parent — the parked row has no render to re-edit")
check('answerAsk(' not in SUBMIT,
      "the answer does not go to /answer-ask",
      "the answer posts to /answer-ask — canAcceptAnswer 409s on a null ask column, silently re-parking the user")

# A 409 MUST NOT BE REPORTED AS A NETWORK FAULT. No 409 exists yet — the module
# that would raise it has no caller — but it arms with the versioning half, and
# `needs_input` is in its IN_FLIGHT_STATUSES, so a parked question can come back
# as the thing blocking its own answer. If that happens the user must not be
# told to check their connection.
check('APIError.reeditInFlight' in SUBMIT,
      "a 409 is distinguished from a transport failure",
      "a 409 falls into the generic catch — the user is told to check their connection over a server decision")

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
