#!/bin/bash
# poll-cadence-gate.sh — the poll cap and the progress bar's tether are ONE
# decision spread across two files, and nothing but this connects them.
#
# THE COUPLING. TricklePacing fills the bar at scheduledCap/estimateSeconds
# pct/sec and permits it to run at most `overshootMargin` past the last CONFIRMED
# backend milestone. A poll gap of G seconds delays learning a milestone by up to
# G, spending fill_rate·G of that margin. Raise the poll cap without raising the
# margin and the tether starts binding: the bar holds still while the render is
# perfectly fine. That is the "looks stuck" this cadence change exists to avoid,
# and it would arrive as a UX complaint about the progress bar rather than as
# anything pointing at the poll interval.
#
# The margin also absorbs real worker jitter, so the gate demands HEADROOM — the
# gap may claim at most half of it.
#
# Exit 0 = clean. Exit 1 = the cadence and the bar have drifted apart.
set -uo pipefail
cd "$(dirname "$0")"
fail=0

python3 - <<'PY' || fail=1
import re, sys
ed = open('Promptly/Views/EditorView.swift', encoding='utf8').read()
tp = open('Promptly/Views/TricklePacing.swift', encoding='utf8').read()
bad = []

def num(src, name):
    m = re.search(rf'var {name}: Double = ([0-9.]+)', src)
    return float(m.group(1)) if m else None

sched, est, margin = num(tp,'scheduledCap'), num(tp,'estimateSeconds'), num(tp,'overshootMargin')
if None in (sched, est, margin):
    bad.append('could not read scheduledCap / estimateSeconds / overshootMargin from TricklePacing')
else:
    cap = re.search(r'min\(15\.0, 3\.0 \* pow\(2\.0, Double\(steps \+ 1\)\)\)', ed)
    if not cap:
        bad.append('the backoff is no longer 3s doubling to a 15s cap — if the cap moved, the '
                   'tether coupling below was computed against a number that is gone')
    else:
        fill = sched / est                 # pct per second
        spend = fill * 15.0                # points of margin a max gap costs
        if spend > margin / 2:
            bad.append(f'a 15s poll gap now spends {spend:.1f} of {margin:.0f} points of '
                       f'overshootMargin — over half. Either lower the cap or raise the margin, '
                       f'or the bar holds still on a healthy render')

# the fast first minute is the point of the change
if not re.search(r'if elapsed < 60 \{[\s\S]{0,120}?\.seconds\(3\)', ed):
    bad.append('the first minute is no longer polled at 3s — the window where the user is '
               'actually watching is the one this cadence was for')

# and the clock must RESET, or a long session starts every render already backed off
if not re.search(r'else \{ inFlightSince = nil \}', ed):
    bad.append('inFlightSince is never cleared — the backoff would measure app uptime rather '
               'than this render, so a second render in a long session starts fully backed off')

if bad:
    print('poll-cadence: FAIL')
    for b in bad: print('  -', b)
    sys.exit(1)
fill = sched/est
print(f'  3s first minute, doubling to a 15s cap; that gap spends {fill*15:.1f} of '
      f'{margin:.0f} margin points (binds at {margin/fill:.0f}s); the in-flight clock resets.')
PY

[ "$fail" -eq 0 ] || { echo "poll-cadence: FAIL"; exit 1; }
echo "poll-cadence: PASS"
