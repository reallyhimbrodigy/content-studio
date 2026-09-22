#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# reedit-is-the-chat-gate.sh — re-edit happens in the thread, and nowhere else.
#
# RULED 2026-09-22, on sight, after a sheet was built and rejected: "the re-edit
# path should literally just be through the chat like it has been." The user
# types the change under the finished video, in the composer they already have;
# the new version arrives as the next video message in the same thread. Nothing
# opens, nothing navigates, no chips, no selector.
#
# WHAT THIS GUARDS. A separate surface is easy to reintroduce and reads as
# progress while it is being written — the last one shipped a version strip, two
# DEBUG stubs, an endpoint fetch and a gate before anyone saw it. So the
# forbidden thing here is a SURFACE, and it is checked tree-wide rather than in
# the files that happen to exist today.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 1

python3 <<'PY'
import re, sys, pathlib

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

def block(src, marker):
    i = src.find(marker)
    if i < 0: return ''
    j = src.index('{', i); d = 0; k = j
    while k < len(src):
        if src[k] == '{': d += 1
        elif src[k] == '}':
            d -= 1
            if d == 0: return src[j:k+1]
        k += 1
    return ''

def has_token(src, token):
    """`token` NOT followed by another identifier character.

    Written once and used everywhere, because a plain `in` has cost five
    assertions in this repo in one day: reedit_tap matched reedit_tapped,
    onChoose matched onChooseX, adoptOAuthSession matched adoptOAuthSessionX,
    and `struct JobCreateResponse` matched `struct JobCreateResponseX`. Every
    one stayed green through the exact rename it existed to catch.
    """
    return re.search(re.escape(token) + r'(?![A-Za-z0-9_])', src) is not None

fails = []
def check(ok, good, bad):
    print(f"  {'✓' if ok else '✗'} {good if ok else bad}")
    if not ok: fails.append(bad)

ALL = {str(p): decomment(p.read_text(encoding='utf-8')) for p in pathlib.Path('.').rglob('*.swift')}
ED = ALL.get('Views/EditorView.swift', '')

# ── 1. No separate surface, anywhere in the target ──────────────────────────
# Declarations as written, not bare names: 'ReeditSheet' as a substring would
# also match a comment mentioning it, and this file's own history is full of
# them.
for decl, what in [('struct ReeditSheet', 'the re-edit sheet'),
                   ('protocol ReeditVersionsProviding', 'the versions provider'),
                   ('struct LiveReeditVersions', 'the live versions source'),
                   ('struct StubReeditVersions', 'the versions stub'),
                   ('struct FailingReeditVersions', 'the failing versions stub'),
                   ('enum VersionsOutcome', 'the strip-or-hide decision')]:
    hits = [p for p, s in ALL.items() if decl in s]
    check(not hits, f"{what} is gone", f"{what} is back ({', '.join(hits)}) — re-edit is the chat")

# The endpoint itself must not be called from anywhere.
vhits = [p for p, s in ALL.items() if '/versions' in s]
check(not vhits, "nothing fetches /versions",
      f"/versions is fetched again ({', '.join(vhits)}) — the client does not call it")

# ── 2. The composer IS the re-edit, and it runs before the chat path ────────
SEND = block(ED, 'private func send() {')
check(bool(SEND), "send() found", "send() is gone")
check('mostRecentFinishedVideoJobId()' in SEND,
      "a typed message resolves the video above it",
      "send() no longer resolves the video above — a change request would go to chat as text")
check('sendReedit(' in SEND,
      "send() dispatches the re-edit itself",
      "send() no longer dispatches a re-edit")
# ORDER IS THE BEHAVIOUR. The text fast path returns, so if it runs first every
# re-edit is silently swallowed as a chat message and nothing renders.
i_re = SEND.find('sendReedit(')
i_txt = SEND.find('sendTextChatMessage(')
check(i_re != -1 and i_txt != -1 and i_re < i_txt,
      "the re-edit branch runs BEFORE the text fast path",
      "the text fast path runs first — it returns, so every re-edit would be swallowed as chat")

# ── 3. The wall and the funnel head, IN THE RE-EDIT BRANCH ──────────────────
# SCOPED TO THE BRANCH, NOT TO send(). Asserting these against the whole
# function passes on calls that have nothing to do with re-edit: send() is 27k
# characters and already contains a `presentPaywall(.reedit)` on the upload
# path, so deleting the re-edit guard entirely left the check green. Fourth
# instance of that blind spot today — a name surviving somewhere else in the
# same region it is asserted over.
BRANCH = block(SEND, 'if !hasVideos, !text.isEmpty, let target = mostRecentFinishedVideoJobId()')
check(bool(BRANCH), "the re-edit branch is identifiable",
      "the re-edit branch is gone from send()")
check('presentPaywall(.reedit)' in BRANCH,
      "the Pro wall guards the re-edit branch itself",
      "the Pro wall is not in the re-edit branch — a free user's change request would dispatch")
check('effectiveIsPro' in BRANCH,
      "the wall reads effectiveIsPro, so server-comped users work",
      "the re-edit branch no longer reads effectiveIsPro")
check(has_token(BRANCH, 'Analytics.track("reedit_tap"'),
      "reedit_tap fires in the re-edit branch",
      "reedit_tap is not in the re-edit branch — the funnel head goes dark")

# ── 4. The answer to a question is a message, not a second rail ─────────────
AC = ALL.get('Views/AskCard.swift', '')
CARD = block(AC, 'struct ClarificationCard')
check(bool(CARD), "ClarificationCard found", "ClarificationCard is gone — a parked question shows nothing")
check('reeditFromJob' not in CARD and 'APIService' not in CARD,
      "the card does not post its own answer",
      "the card posts directly again — two ways to answer, which is how they drift")
# THE DECLARATION, not the name. `onChoose` alone is satisfied by the argument
# LABEL on the inner call (`onChoose:`), which survives renaming the property —
# the same within-region survival as effectiveIsPro in a sibling line.
check(has_token(CARD, 'let onChoose'),
      "a tapped choice is handed back to the one send path",
      "the card no longer surfaces choices to the caller")

# ── controls ────────────────────────────────────────────────────────────────
assert block('func s() { body }', 'func s') == '{ body }', "CONTROL FAILED: block() broken"
assert block('nope', 'func s') == '', "CONTROL FAILED: block() invents a body"
assert has_token('let onChoose: (String) -> Void', 'onChoose'), "CONTROL FAILED: has_token misses an exact match"
assert not has_token('let onChooseX: (String) -> Void', 'onChoose'), "CONTROL FAILED: has_token matches a longer name"
assert not has_token('Analytics.track("reedit_tapped"', 'Analytics.track("reedit_tap"'), "CONTROL FAILED: quoted-literal boundary"
assert len(ALL) > 50, f"CONTROL FAILED: only {len(ALL)} files scanned — the sweep is not reaching the target"
print(f"  · controls: block() brackets a real body; has_token rejects a longer name; {len(ALL)} swift files swept")

if fails:
    print(f"\nreedit-is-the-chat-gate: FAIL ({len(fails)})"); sys.exit(1)
print("reedit-is-the-chat-gate: PASS")
PY
