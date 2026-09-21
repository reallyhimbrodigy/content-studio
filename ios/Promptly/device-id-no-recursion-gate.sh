#!/bin/bash
# device-id-no-recursion-gate.sh — a getter that emits an event is a cycle.
#
# WHAT HAPPENED (2026-09-21). Analytics.deviceId resolved the id and, when the
# Keychain write failed, called Analytics.track(). track() sets
# enrichedProps["device_id"] = deviceId. So the getter called the emitter which
# called the getter: unbounded recursion, stack overflow AT LAUNCH, before any
# UI. Observed as EXC_BAD_ACCESS / "Could not determine thread index for stack
# guard region" with 19 frames of our own binary on the faulting thread.
#
# WHY IT HID. It fires only when Keychain.set returns FALSE. On a healthy
# unlocked device the write succeeds, so ordinary use never touched it.
# kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly cannot be WRITTEN before the
# first unlock after a reboot, and this app is launched in that window by push
# and by background URLSession completions.
#
# WHY A GATE AND NOT A COMMENT. The dangerous edit is one line — adding a
# track() to a diagnostic path inside the resolver — and it is the natural thing
# to do when someone wants to measure a failure. A comment saying "don't" is
# read by whoever is already careful.
#
# Exit 0 = clean. Exit 1 = the getter can reach the emitter again.
set -uo pipefail
cd "$(dirname "$0")"
fail=0

python3 - <<'PY' || fail=1
import re, sys, os, glob
src = open('Promptly/Services/AnalyticsService.swift', encoding='utf8').read()
bad = []

def decomment(t):
    # A call search that matches comments reports code that is not there. The
    # first version of check 3 passed after BOTH track() calls were deleted,
    # because the reporter's own comment says "track()".
    t = re.sub(r'/\*[\s\S]*?\*/', '', t)
    return '\n'.join(re.sub(r'//.*$', '', ln) for ln in t.split('\n'))

def body(sig, text):
    i = text.find(sig)
    if i < 0: return None
    depth, j, started = 0, i, False
    while j < len(text):
        if text[j] == '{': depth += 1; started = True
        elif text[j] == '}':
            depth -= 1
            if started and depth == 0: return text[i:j+1]
        j += 1
    return None

# 1. NEITHER the getter NOR the resolver may emit. This is the cycle itself.
for sig, label in [('private static var deviceId: String {', 'the deviceId getter'),
                   ('private static func resolveDeviceIdLocked() -> String {', 'the resolver')]:
    b = body(sig, src)
    if b is None:
        bad.append(f'{label} is gone — this gate can no longer see the cycle it guards')
        continue
    if re.search(r'\btrack\s*\(', decomment(b)):
        bad.append(f'{label} calls track() — track() reads deviceId, so this is the recursion '
                   f'that crashed the app at launch')
    if re.search(r'Analytics\.', decomment(b)):
        bad.append(f'{label} reaches back through Analytics. — any Analytics entry point can '
                   f'route to track() and close the cycle')

# 2. resolved ONCE and cached, so track()'s read cannot re-enter even if it did.
if 'cachedDeviceId' not in src:
    bad.append('the resolved id is no longer cached — every track() would re-resolve, and a '
               'resolver that ever emits becomes unbounded again')
g = body('private static var deviceId: String {', src) or ''
if not re.search(r'if let \w+ = cachedDeviceId \{[^}]*return', g):
    bad.append('the getter no longer RETURNS from the cache — the name being present is not '
               'the same as the early return, and without it every track() re-resolves')

# 3. the diagnostic still EXISTS and is emitted from a non-getter site.
rep = body('static func reportDeviceIdIssuesIfNeeded() {', src)
if rep is None:
    bad.append('reportDeviceIdIssuesIfNeeded is gone — the Keychain-failure signal is lost '
               'entirely, which is worse than the recursion it replaced being noisy')
else:
    if not re.search(r'\btrack\s*\(', decomment(rep)):
        bad.append('the reporter no longer emits anything — the diagnostic is inert')
    if rep.find('_ = deviceId') < 0:
        bad.append('the reporter does not resolve+cache the id BEFORE emitting — emitting first '
                   'would re-enter the resolver through track()')

# 4. REACHABILITY. A reporter nobody calls is the inert half, and I shipped
#    exactly that for ten minutes when the wiring edit aborted while the build
#    still succeeded on the recursion fix alone.
callers = []
for f in glob.glob('Promptly/**/*.swift', recursive=True):
    if f.endswith('AnalyticsService.swift'): continue
    t = open(f, encoding='utf8').read()
    if 'reportDeviceIdIssuesIfNeeded' in t: callers.append(os.path.basename(f))
if not callers:
    bad.append('nothing outside AnalyticsService calls reportDeviceIdIssuesIfNeeded — the '
               'crash is fixed and the diagnostic never fires, which looks done forever')

if bad:
    print('device-id-no-recursion: FAIL')
    for b in bad: print('  -', b)
    sys.exit(1)
print(f'  the getter and resolver emit nothing; the id is cached; the diagnostic is reported '
      f'after caching, from {callers[0]}.')
PY

[ "$fail" -eq 0 ] || { echo "device-id-no-recursion: FAIL"; exit 1; }
echo "device-id-no-recursion: PASS"
