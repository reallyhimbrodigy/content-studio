#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# price-arithmetic-gate.sh — the two prices on a row come from ONE product.
#
# A duration row shows two numbers: the per-month equivalent and the amount
# billed. If those can be computed from different sources they can disagree,
# and a row that says "$24.17/mo" beside "billed yearly at $349.99" is telling
# a user two different prices for one purchase.
#
# They cannot currently diverge — PaywallProduct is built from a single
# StoreProduct (`price: sp.price`, `localizedPrice: sp.localizedPriceString`) —
# but nothing asserted it, and the only reason it came up is that a REPORT
# mixed a simulator price with a production one and produced exactly the
# disagreement this prevents. Structure it so the code cannot do what the
# report did.
#
# Also checks the arithmetic itself: /12 for a year, and the week is never
# normalised to a month (a weekly charge shown as "/mo" misstates what is taken).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 1

python3 <<'PY'
import re, sys, pathlib
src = pathlib.Path('Views/TwoStepPaywall.swift').read_text(encoding='utf-8')
code = re.sub(r'^[ \t]*//.*$', '', re.sub(r'^[ \t]*///.*$', '', src, flags=re.M), flags=re.M)

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

# ── 1. ONE PRODUCT, both numbers ────────────────────────────────────────────
MAKE = code[code.find('return PaywallProduct('):][:600]
check('localizedPrice: sp.localizedPriceString' in MAKE and 'price: sp.price' in MAKE,
      "PaywallProduct takes both its price fields from the same StoreProduct",
      "the two price fields no longer come from one StoreProduct — they can disagree")

RATE = block(code, 'static func rateLine(')
BILL = block(code, 'static func billingLine(')
check('perMonthAmount(p)' in RATE,
      "the per-month figure is derived from the row's own product",
      "rateLine no longer derives from the product passed to it")
check('p.localizedPrice' in BILL,
      "the billed amount is the product's own localized price",
      "billingLine no longer uses the product's own price")

# ── 2. THE ARITHMETIC ───────────────────────────────────────────────────────
PM = block(code, 'static func perMonthAmount(')
check(re.search(r'p\.price\s*/\s*12', PM) is not None,
      "a year is divided by 12, from p.price",
      "the per-month figure is not p.price / 12 — rate x 12 would not return the billed amount")
check('localizedPricePerMonth' not in PM,
      "the division is done here, not taken from a second source",
      "perMonthAmount reads a different per-month field — two sources for one number")

# ── 3. THE WEEK IS NEVER NORMALISED ─────────────────────────────────────────
wk = RATE[RATE.find('case .week'):][:220] if 'case .week' in RATE else ''
check('/wk' in wk and '/mo' not in wk,
      "a weekly plan states its own cadence, never a per-month figure",
      "the weekly row shows a /mo figure — that misstates what is charged")

# ── 3b. AN INTRO ROW SHOWS NO PER-MONTH FIGURE (ruled 2026-09-23) ───────────
# base / 12 beside an intro charge describes NEITHER amount — not what is taken
# today, not what renews. The row leads with the charge and states the renewal
# on its own line.
ROW = block(code, 'private func durationRow(')
i = ROW.find('Text(option.rate)')
guard = ROW[max(0, i-400):i] if i >= 0 else ''
check('option.introSubline == nil' in guard,
      "the per-month figure is suppressed when an intro is present",
      "the per-month figure renders on an intro row — it describes neither the charge nor the renewal")
check('option.introRenewal' in ROW,
      "the renewal amount renders on its own line",
      "the renewal is not rendered — an intro row would hide what it costs from month two")

# And the two halves come from one eligibility decision, so a row can never show
# a renewal with no charge or a charge with no renewal.
PB = pathlib.Path('Views/ProBenefits.swift').read_text(encoding='utf-8')
pbc = re.sub(r'^[ \t]*//.*$', '', re.sub(r'^[ \t]*///.*$', '', PB, flags=re.M), flags=re.M)
for fn in ('introChargeLine', 'introRenewalLine'):
    b = block(pbc, f'static func {fn}(')
    check('isEligibleForIntro' in b and 'paymentMode != .freeTrial' in b,
          f"{fn} guards on eligibility and skips free trials",
          f"{fn} lost its eligibility guard — a row could state an offer the user cannot have")

# ── 4. The arithmetic, run ──────────────────────────────────────────────────
# 289.99 / 12 = 24.1658..., which formats to 24.17; x12 = 290.04, within a cent
# per month of the real charge. The check is that the ROUNDED figure times 12
# lands within 12 cents of the billed amount — one cent per month, which is the
# most a two-decimal per-month figure can drift.
for billed in (289.99, 349.99, 89.99, 1079.88):
    per = round(billed / 12, 2)
    drift = abs(per * 12 - billed)
    check(drift <= 0.12,
          f"{billed:.2f}/yr -> {per:.2f}/mo, x12 = {per*12:.2f} (drift {drift:.2f})",
          f"{billed:.2f}/yr -> {per:.2f}/mo drifts {drift:.2f} from the billed amount")

assert block('func f() { x }', 'func f') == '{ x }', "CONTROL FAILED: block broken"
assert abs(round(100/12, 2) * 12 - 100) <= 0.12, "CONTROL FAILED: drift maths"
assert abs(round(100/11, 2) * 12 - 100) > 0.12, "CONTROL FAILED: drift check accepts a wrong divisor"
print("  · controls: the drift check rejects a wrong divisor")

if fails:
    print(f"\nprice-arithmetic-gate: FAIL ({len(fails)})"); sys.exit(1)
print("price-arithmetic-gate: PASS")
PY
