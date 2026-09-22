#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# source-poster-gate.sh — a job's card shows the clip, never a black box.
#
# THE CAUSE, for anyone reading this later: the picked clip's frame was attached
# to the USER message; the card that draws render progress is the ASSISTANT
# message beside it. RenderProgressRing therefore received nil for both its
# image and its URL and painted its empty ground — from pick until the finished
# video's own poster loaded. The thumbnail pipeline worked the entire time.
# Nothing carried its result to the card, so every assertion here is about the
# CARRY, not about generation.
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

def read(p):
    f = pathlib.Path(p)
    return decomment(f.read_text(encoding='utf-8')) if f.exists() else ''

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
    """Token not followed by another identifier char — a plain `in` has cost
    five assertions in this repo, each staying green through a rename."""
    return re.search(re.escape(token) + r'(?![A-Za-z0-9_])', src) is not None

fails = []
def check(ok, good, bad):
    print(f"  {'✓' if ok else '✗'} {good if ok else bad}")
    if not ok: fails.append(bad)

SP = read('Services/SourcePoster.swift')
ED = read('Views/EditorView.swift')
RING = read('Views/RenderProgressRing.swift')
MB = read('Views/MessageBubble.swift')

# ── 1. Generation rules ─────────────────────────────────────────────────────
# THE VALUE, NOT THE NAME. Asserting the symbol appears is true whether it is
# set to true or to false — flipping it off passed this check's first version.
# Presence-vs-value is the same family as presence-vs-declaration.
check(re.search(r'appliesPreferredTrackTransform\s*=\s*true', SP) is not None,
      "the generator applies the preferred track transform",
      "the transform flag is absent or false — phone-shot video posters come out sideways")
m = re.search(r'luminanceFloor: Double = ([0-9.]+)', SP)
check(bool(m) and float(m.group(1)) > 0,
      f"a luminance floor rejects black frames (={m.group(1) if m else '?'})",
      "the luminance floor is gone or zero — a clip that opens on black reproduces the black box")
check(has_token(SP, 'candidateSeconds'),
      "more than one candidate frame is tried",
      "only one offset is sampled — an opening black frame has no alternative to fall back from")

# ── 2. Persistence keyed by JOB id, which is what survives a relaunch ───────
check('cachesDirectory' in SP, "posters live in caches",
      "posters are not written to the caches directory")
check(has_token(SP, 'static func load') and has_token(SP, 'static func save'),
      "posters can be written and read back by job id",
      "the persist/load pair is gone — a relaunch mid-render would show nothing")

# ── 3. THE CARRY — the defect itself ────────────────────────────────────────
# Scoped to the blocks that build each processing message: `videoAttachment`
# appears throughout EditorView for the USER message, which is precisely how
# this bug read as correct.
UPLOAD = ED[ED.find('processingMsg.jobId = UUID()'):][:2000]
check('processingMsg.videoAttachment' in UPLOAD,
      "the uploading card's own message carries the poster",
      "the processing message has no attachment again — the card is a black box from pick to finish")
check(has_token(UPLOAD, 'SourcePoster.save') or has_token(UPLOAD, 'SourcePoster.capture'),
      "the poster is persisted under the job id at pick time",
      "nothing persists the poster at pick time — a relaunch mid-render shows an empty frame")

REEDIT = block(ED, 'private func sendReedit(')
check('processingMsg.videoAttachment' in REEDIT,
      "a re-edit in progress shows the previous version's poster",
      "the re-edit card has no poster — same black box by another route")

# ── 4. The card resolves and shapes itself to it ────────────────────────────
RESOLVED = block(RING, 'private var resolvedPoster')
check(has_token(RESOLVED, 'SourcePoster.load'),
      "the card falls back to the persisted poster",
      "the card no longer reads the persisted poster — relaunch mid-render goes black")
ASPECT = block(RING, 'private var frameHeight')
check(has_token(ASPECT, 'posterAspect'),
      "the card takes the poster's aspect ratio",
      "the card is back to a fixed 9:16 — a landscape clip gets black bars, which is the same defect")
check(has_token(MB, 'jobId: message.jobId'),
      "the bubble passes the job id to the card",
      "the job id is not passed — the card cannot find the persisted poster")

# ── controls ────────────────────────────────────────────────────────────────
assert has_token('let onChoose: X', 'onChoose'), "CONTROL FAILED: has_token misses an exact match"
assert not has_token('let onChooseX: X', 'onChoose'), "CONTROL FAILED: has_token matches a longer name"
assert re.search(r'appliesPreferredTrackTransform\s*=\s*true', 'x.appliesPreferredTrackTransform = true'), "CONTROL FAILED: value match"
assert not re.search(r'appliesPreferredTrackTransform\s*=\s*true', 'x.appliesPreferredTrackTransform = false'), "CONTROL FAILED: value match accepts false"
assert block('func s() { body }', 'func s') == '{ body }', "CONTROL FAILED: block() broken"
assert len(SP) > 500 and len(RING) > 500, "CONTROL FAILED: a source file read empty — the sweep is not reaching the target"
print("  · controls: has_token rejects a longer name; sources read non-empty")

if fails:
    print(f"\nsource-poster-gate: FAIL ({len(fails)})"); sys.exit(1)
print("source-poster-gate: PASS")
PY
