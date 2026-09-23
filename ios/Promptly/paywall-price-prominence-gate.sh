#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# paywall-price-prominence-gate.sh — the amount Apple charges is the prominent
# price, and monthly is the preselected row.
#
# WHAT THIS IS FOR. The Year row rendered "$29.17/mo" at 15pt bold and
# "$289.99 billed yearly" at 10pt / 60% opacity. Yearly then took 318 purchase
# attempts in 30 days — 53% of all buying intent, because it was preselected
# and RECOMMENDED — and completed ZERO, in every storefront measured, with a
# 90% cancel rate at Apple's sheet. A user who taps expecting $29 and is asked
# for $289.99 cancels; that they did so in every market is what makes it a
# display defect rather than a pricing one. Apple's 3.1.2 requires the charged
# amount to be the prominent one.
#
# So two properties, both structural: the billed-today line outranks the
# per-month figure, and the default selection is monthly.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 1

python3 <<'PY'
import re, sys, pathlib

src = pathlib.Path('Views/TwoStepPaywall.swift').read_text(encoding='utf-8')
# Comments stripped so the prose above a line cannot satisfy a check.
code = re.sub(r'^[ \t]*///.*$', '', src, flags=re.M)
code = re.sub(r'^[ \t]*//.*$', '', code, flags=re.M)

fails = []
def check(ok, good, bad):
    print(f"  {'✓' if ok else '✗'} {good if ok else bad}")
    if not ok: fails.append(bad)

def block(s, marker):
    i = s.find(marker)
    if i < 0: return ''
    j = s.index('{', i); d = 0; k = j
    while k < len(s):
        if s[k] == '{': d += 1
        elif s[k] == '}':
            d -= 1
            if d == 0: return s[j:k+1]
        k += 1
    return ''

ROW = block(code, 'private func durationRow(')
check(bool(ROW), "durationRow found", "durationRow is gone")

# THE TWO PRICES, EACH FOUND BY THE VALUE IT RENDERS, not by position.
def size_after(fragment):
    """The cType point size on the Text that renders `fragment`."""
    i = ROW.find(fragment)
    if i < 0: return None
    m = re.search(r'\.cType\((\d+)(?:\s*,\s*\.(\w+))?\)', ROW[i:i+400])
    if not m: return None
    return (int(m.group(1)), m.group(2) or 'regular')

billed = size_after('option.introSubline')      # the amount charged today
rate   = size_after('Text(option.rate)')         # the per-month equivalent

check(billed is not None, f"the billed-today line renders (cType {billed})",
      "could not find the billed-today line's type size")
check(rate is not None, f"the per-month figure renders (cType {rate})",
      "could not find the per-month figure's type size")

if billed and rate:
    WEIGHT = {'regular': 0, 'medium': 1, 'semibold': 2, 'bold': 3, 'heavy': 4}
    bpt, bw = billed
    rpt, rw = rate
    check(bpt >= rpt,
          f"the charged amount is at least as large as the per-month figure ({bpt}pt vs {rpt}pt)",
          f"the per-month figure is LARGER than the amount Apple charges ({rpt}pt vs {bpt}pt) — 3.1.2")
    check((bpt, WEIGHT.get(bw,0)) > (rpt, WEIGHT.get(rw,0)),
          f"the charged amount outranks it overall ({bpt}pt/{bw} vs {rpt}pt/{rw})",
          f"the charged amount does not outrank the per-month figure ({bpt}pt/{bw} vs {rpt}pt/{rw})")

# DIMMING IS PROMINENCE TOO. 60% opacity on the charged amount is how it was
# buried the first time, so size alone is not the whole property.
i = ROW.find('option.introSubline')
seg = ROW[i:i+400] if i >= 0 else ''
m = re.search(r'foregroundColor\(\.white(?:\.opacity\(([\d.]+)\))?\)', seg)
op = float(m.group(1)) if (m and m.group(1)) else 1.0
check(op >= 0.9, f"the charged amount is not dimmed (opacity {op})",
      f"the charged amount is dimmed to {op} — it was 0.6 when yearly converted zero")

# ── the default row ─────────────────────────────────────────────────────────
PREF = block(code, 'private func preferredRow(')
check(bool(PREF), "preferredRow found", "preferredRow is gone")
check('_monthly' in PREF,
      "the preselected row is the monthly product",
      "preferredRow no longer prefers monthly")
check('isAnnual }) ??' not in PREF and 'first(where: { $0.isAnnual })' not in PREF,
      "annual is no longer preferred",
      "preferredRow prefers the annual row again — 0 of 318 completed")

# ── controls ────────────────────────────────────────────────────────────────
assert size_after('option.introSubline') is not None, "CONTROL FAILED: size_after finds nothing"
assert size_after('no_such_fragment_xyz') is None, "CONTROL FAILED: size_after invents a size"
assert block('func f() { x }', 'func f') == '{ x }', "CONTROL FAILED: block broken"
print("  · controls: size_after reads a real size and returns None for an absent one")

if fails:
    print(f"\npaywall-price-prominence-gate: FAIL ({len(fails)})"); sys.exit(1)
print("paywall-price-prominence-gate: PASS")
PY
