#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# reedit-entry-point-gate.sh — ONE way into re-edit, and it is the pill.
#
# RULED 2026-09-21 (Zac, for 258): the existing pill opens ReeditSheet, keeps
# its Pro wall and its reedit_tap event. No hold gesture. No second path.
#
# WHAT THIS IS ACTUALLY GUARDING. Before 258 the pill armed the COMPOSER — a
# context chip above the input and a branch in send() that called reeditFromJob
# instead of uploading. That was a complete, working second implementation of
# the same feature. It became unreachable the moment the pill was repointed,
# and unreachable is one assignment away from live: anything that sets
# `reeditSession` resurrects the old UI with nothing to say it had.
#
# So this asserts the removal as well as the wiring. A gate that only checked
# "the sheet is presented" would stay green through the exact regression it
# exists to prevent, because both paths can be true at once.
#
# Assertions are scoped to the BRANCH under test, not the file: a name that
# survives in a comment, on a success path, or in a sibling catch is how three
# gates in this repo passed their own load-bearing mutation.
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

def read(p): return decomment(pathlib.Path(p).read_text(encoding='utf-8'))

def block(src, marker):
    """The brace-matched body that follows `marker`. Empty string if absent."""
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

MB   = read('Views/MessageBubble.swift')
ED   = read('Views/EditorView.swift')
SRC  = read('Services/ReeditVersionsSource.swift')
ALL  = {p: read(p) for p in map(str, pathlib.Path('.').rglob('*.swift'))}

# ── 1. The pill's handler, scoped to its own body ────────────────────────────
H = block(MB, 'private func buildReeditHandler')
check(bool(H), "buildReeditHandler found", "buildReeditHandler is gone — the pill has no handler")
# THE EXACT LITERAL, QUOTES INCLUDED. `'reedit_tap' in H` is a substring test,
# and it stays true for "reedit_tapped" — the event renamed, the funnel head
# dark, the gate green. Same shape as adoptOAuthSession matching
# adoptOAuthSessionX.
check('Analytics.track("reedit_tap"' in H, "the pill still emits reedit_tap",
      "reedit_tap left the pill's handler — the re-edit funnel head goes dark")

# THE WALL IS A BRANCH, NOT A NAME. Asserting `effectiveIsPro` appears in the
# handler passes with the guard deleted, because the analytics line two rows up
# reads the same property for its `isPro` prop. Scope to the guard's own body
# and assert what that body DOES: present the paywall and return before any
# session is posted.
GUARD = block(H, 'if !SubscriptionService.shared.effectiveIsPro')
check(bool(GUARD), "re-edit is walled on effectiveIsPro",
      "the effectiveIsPro guard is gone from the handler — re-edit would be free")
check('presentPaywall(.reedit)' in GUARD and 'return' in GUARD,
      "the wall presents the re-edit paywall and returns",
      "the wall no longer presents-and-returns — a free user would fall through to the sheet")
check('pendingReedit = ReeditSession' in H,
      "the handler routes through AppState.pendingReedit",
      "the handler no longer posts a session — the sheet cannot open")

# ── 2. EditorView opens the SHEET from it ────────────────────────────────────
check('.sheet(item: $reeditSheetSession)' in ED and 'ReeditSheet(jobId:' in ED,
      "EditorView presents ReeditSheet from the posted session",
      "EditorView does not present ReeditSheet — the pill would open nothing")

# ── 3. The composer path stays dead ──────────────────────────────────────────
# Named symbols, not a loose word: `reeditSession` was the state, `reeditChip`
# the context chip, `reeditActive` the send() flag. Any of them back means the
# second implementation is back.
for sym in ('reeditSession', 'reeditChip', 'reeditActive'):
    check(sym not in ED, f"{sym} is gone from EditorView",
          f"{sym} is back in EditorView — the old composer re-edit path is a second way in")

# ── 4. No hold gesture anywhere reaches re-edit ──────────────────────────────
# Tree-wide, because the forbidden thing is a GESTURE, and a surface written
# tomorrow can add one. A long-press is only a violation if it leads to re-edit,
# so this looks for the two together inside one gesture body.
hold = []
for path, src in ALL.items():
    for m in re.finditer(r'onLongPressGesture|LongPressGesture\(', src):
        tail = src[m.start():m.start()+400]
        if 'eedit' in tail:
            hold.append(f"{path}:{src[:m.start()].count(chr(10))+1}")
check(not hold, "no long-press gesture leads to re-edit",
      f"a hold gesture reaches re-edit ({', '.join(hold)}) — ruled out, the pill is the only entry")

# ── 4b. The sheet's load path must DEGRADE, not fail ────────────────────────
# VersionsOutcome being correct proves nothing if load() ignores it — that is
# the inert-half shape this repo keeps paying for. Scoped to load()'s own body:
# a `.failed` anywhere in this function is the error state the ruling forbids,
# and it would be the ONLY state real users see until the server half merges.
SH_ = read('Views/ReeditSheet.swift')
LOAD = block(SH_, 'private func load() async')
check(bool(LOAD), "ReeditSheet.load() found", "ReeditSheet.load() is gone")
check('VersionsOutcome' in LOAD,
      "load() routes its result through the tested decision",
      "load() no longer uses VersionsOutcome — the tested rule is not the one running")
check('.failed' not in LOAD,
      "load() cannot put the sheet into an error state",
      "load() can set .failed — a missing /versions would tell the user their video is broken")
check('composer = .ready' in LOAD,
      "load() always brings the composer up",
      "load() does not set the composer ready — a failed fetch would leave it stuck loading")

# ── 5. The stub cannot ship ──────────────────────────────────────────────────
# The #if DEBUG must WRAP the declaration. Asserting both strings appear
# somewhere in the file would pass on a stub declared above the guard.
# BOTH stubs must be unshippable, not just the one that returns data. A failing
# stub in Release would hide the strip from every user permanently.
fail_i = SRC.find('struct FailingReeditVersions')
fail_guards = [(m.start(), m.group()) for m in re.finditer(r'#if DEBUG|#endif', SRC)]
fail_depth = 0
for pos, tok in fail_guards:
    if pos > fail_i: break
    fail_depth += 1 if tok == '#if DEBUG' else -1
check(fail_i >= 0 and fail_depth > 0,
      "FailingReeditVersions is inside #if DEBUG — it cannot ship",
      "FailingReeditVersions is not DEBUG-guarded — a Release build could hide the strip for everyone")

stub_i = SRC.find('struct StubReeditVersions')
guards = [(m.start(), m.group()) for m in re.finditer(r'#if DEBUG|#endif', SRC)]
depth_at_stub = 0
for pos, tok in guards:
    if pos > stub_i: break
    depth_at_stub += 1 if tok == '#if DEBUG' else -1
check(stub_i >= 0 and depth_at_stub > 0,
      "StubReeditVersions is declared inside #if DEBUG — it cannot ship",
      "StubReeditVersions is not inside #if DEBUG — a stub would ship to users")

# ── controls ─────────────────────────────────────────────────────────────────
assert block("func x() { alpha }", 'func x') == '{ alpha }', "CONTROL FAILED: block() is broken"
assert block("zzz", 'func x') == '', "CONTROL FAILED: block() invents a body"
assert 'note' not in decomment("code // note"), "CONTROL FAILED: decomment is dead"
print("  · controls: block() brackets a real body and returns empty for an absent one")

if fails:
    print(f"\nreedit-entry-point-gate: FAIL ({len(fails)})")
    sys.exit(1)
print("reedit-entry-point-gate: PASS")
PY
