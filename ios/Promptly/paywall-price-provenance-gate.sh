#!/bin/bash
# paywall-price-provenance-gate.sh — every price on screen is StoreKit's.
#
# WHAT THIS SETTLES, measured 2026-09-12. ASC's configured customer price for
# promptly_pro_yearly, the number StoreKit hands the app, and the number the
# analytics recorded agree to the paisa in every territory checked:
#
#     IND  INR 17,900     PAK  PKR 49,900
#     SGP  SGD 299.98     NGA  NGN 249,900
#
# So the app was NOT fabricating a price and the charge never disagreed with
# the screen. The tier is simply what Apple was told to charge. That is a
# pricing decision, and this gate exists so it stays the ONLY way a price can
# ever be wrong — a number on the paywall must be traceable to a price sheet
# somebody set, never to arithmetic or a literal in here.
#
# IT WAS NOT UNIFORMLY TRUE. CreditsTopUpView rendered
# `maxMonthlyPrice ?? "$89.99"` — a US-dollar literal shown to every storefront,
# including the Indian user who has no dollar price at all. A quote the store
# never gave is worse than no quote: the user can hold us to it and the charge
# would contradict the screen. That is the shape this makes impossible.
#
# THE RULE, in one line: the only sources of a displayed price are
# `localizedPriceString` and `storeProduct.price` formatted through that
# product's own `priceFormatter`. Never a base price, never a conversion, never
# a string we assemble. Symbol, placement and digit grouping belong to the
# locale — INR groups as 17,900 in en-IN and ١٧٬٩٠٠ in ar, and neither is
# something we should be spelling out.
#
# SAME SHAPE AS saved_pct: derive from the two real prices, never assert the
# number. `CheckoutSheet.savedPct` and `PlanSavings.percentOff` already do;
# this keeps them that way, because a hand-set percentage is how the sheet once
# read "Save 15%" over a price that was higher.
#
# AND THE SAME FOR LANGUAGE. Twelve locales are translated. A sentence built by
# concatenating a number onto English fragments breaks word order in most of
# them — ja puts the price before です, hi and ne put it mid-clause, ar and ur
# run right-to-left. Every price-bearing sentence must therefore be one
# localized key with a placeholder, so a translator owns the whole sentence.
#
# Exit 0 = clean. Exit 1 = offending lines as file:line:content.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
fail=0

python3 - <<'PY' || fail=1
import json, os, re, sys

PAYWALL = [
    "Promptly/Views/PaywallView.swift",
    "Promptly/Views/TwoStepPaywall.swift",
    "Promptly/Views/CheckoutSheet.swift",
    "Promptly/Views/CreditsTopUpView.swift",
    "Promptly/Views/TrialWallView.swift",
    "Promptly/Views/ProBenefits.swift",
    "Promptly/Services/TrialCopy.swift",
    "Promptly/Services/StorefrontService.swift",
]
present = [p for p in PAYWALL if os.path.exists(p)]
# POSITIVE CONTROL. A path typo would empty the scan and pass everything; the
# count is asserted so "no findings" means "looked and found none".
if len(present) < 6:
    print("  FAIL  the paywall path resolved to only %d files — the scan is empty, "
          "not clean" % len(present)); sys.exit(1)

def code_lines(path):
    """Source with comments removed, string literals preserved, 1-indexed."""
    out, inblock = [], False
    for i, raw in enumerate(open(path, encoding="utf8"), 1):
        line, res, j, instr = raw, [], 0, False
        if inblock:
            k = line.find("*/")
            if k == -1:
                out.append((i, "")); continue
            inblock = False; line = line[k + 2:]
        while j < len(line):
            c = line[j]
            if instr:
                res.append(c)
                if c == "\\" and j + 1 < len(line): res.append(line[j + 1]); j += 2; continue
                if c == '"': instr = False
                j += 1; continue
            if c == '"': instr = True; res.append(c); j += 1; continue
            if line.startswith("//", j): break
            if line.startswith("/*", j):
                k = line.find("*/", j + 2)
                if k == -1: inblock = True; break
                j = k + 2; continue
            res.append(c); j += 1
        out.append((i, "".join(res)))
    return out

bad = []
def flag(f, n, text, why):
    bad.append("  %s:%d: %s\n          -> %s" % (f, n, text.strip()[:96], why))

# ── 1. NO CURRENCY LITERAL. `$0`..`$9` is Swift's closure shorthand, so the
#       fingerprint is a symbol followed by a grouped or decimal amount.
CURRENCY = re.compile(r'"[^"]*(?:\$\s?\d[\d,]*[.,]\d|[€£₹¥₦₨﷼]\s?\d)')
# ── 2. NO CONVERSION ARITHMETIC. Dividing a yearly by 52 or 12 to quote a
#       per-week figure IS the endorsed derivation; multiplying a price by
#       anything else is an invented exchange rate.
PERIOD_OK = {"12", "52", "100", "1", "0"}
CONVERT = re.compile(r'\b([A-Za-z_][\w.]*[Pp]rice[\w.]*)\s*([*/])\s*([\d.]+)')
CONVERT2 = re.compile(r'([\d.]+)\s*\*\s*\b([A-Za-z_][\w.]*[Pp]rice[\w.]*)')
# ── 3. NO FORMATTER WE STEER. The locale must come from the product.
HARD_LOCALE = re.compile(r'\.currencyCode\s*=|Locale\(identifier:\s*"')

for f in present:
    for n, line in code_lines(f):
        if CURRENCY.search(line):
            flag(f, n, line, "a currency literal. The store quotes the price; we render it.")
        m = CONVERT.search(line) or CONVERT2.search(line)
        if m:
            num = m.group(3) if m.re is CONVERT else m.group(1)
            if num.rstrip(".0") not in {x.rstrip(".0") for x in PERIOD_OK}:
                flag(f, n, line, "price arithmetic against the literal %s — a period "
                                 "divisor (12/52) is derivation; anything else is an "
                                 "invented rate." % num)
        if HARD_LOCALE.search(line) and "priceFormatter" not in line:
            flag(f, n, line, "a formatter whose currency/locale we set. It must come "
                             "from the product's own priceFormatter.")

# ── 4. THE DERIVED-PERCENT RULE (the saved_pct shape) ─────────────────────
src = "\n".join(t for f in present for _, t in code_lines(f))
if "var savedPct" in src:
    blk = src[src.index("var savedPct"): src.index("var savedPct") + 400]
    if not re.search(r'(appleFee|applePrice|webPrice)[\s\S]{0,120}(/|\*)', blk):
        bad.append("  savedPct no longer divides the two real prices — a hand-set "
                   "percentage is how the sheet read 'Save 15%' over a HIGHER price.")

# ── 5. EVERY PRICE SENTENCE IS ONE LOCALIZED KEY, IN TWELVE LOCALES ───────
CAT = "Promptly/Localizable.xcstrings"
if not os.path.exists(CAT):
    bad.append("  the string catalogue is missing — locale coverage unverifiable")
else:
    cat = json.load(open(CAT, encoding="utf8"))
    strings = cat.get("strings", {})
    ALL = {"ar","bn","de","en","es","fr","hi","id","ja","ne","pt-BR","ur"}
    # en is the development language: the KEY is its English text, so an entry
    # with the other eleven is fully covered.
    money_key = re.compile(r'charged|a month for|saved|for only|Intro price|start monthly')
    checked = 0
    for k, v in strings.items():
        if "%@" not in k or not money_key.search(k): continue
        locs = set(v.get("localizations", {})) | {"en"}
        checked += 1
        if ALL - locs:
            bad.append("  price sentence missing %s: %s"
                       % (",".join(sorted(ALL - locs)), k[:60]))
    if checked < 5:
        bad.append("  only %d price sentences found in the catalogue — the locale "
                   "check is scanning nothing" % checked)

if bad:
    print("paywall-price-provenance-gate: FAIL")
    for b in bad: print(b)
    sys.exit(1)
print("  every displayed price traces to StoreKit; no currency literal, no invented "
      "rate, no formatter we steer; savedPct derived from the two real prices; every "
      "price sentence is one localized key across twelve locales.")
PY

[ "$fail" -eq 0 ] || { echo "paywall-price-provenance-gate: FAIL"; exit 1; }
echo "paywall-price-provenance-gate: PASS"
