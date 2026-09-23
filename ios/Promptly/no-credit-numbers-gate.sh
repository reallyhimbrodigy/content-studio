#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# no-credit-numbers-gate.sh — makes a credit number on a user-facing surface
# impossible to ship.
#
# RULED 2026-09-21 (Zac, for 258): videos are the only unit that any
# user-facing surface states.
#
# AMENDED 2026-09-23 (for 259): two surfaces are exempt — the credits button and
# the top-up screen. They are where the currency is HELD and SPENT, and a person
# buying credits has to be told how many they are buying. Everywhere else the
# unit is still videos, which is the part that mattered: a capacity claim, a
# paywall, an allowance, a cap message.
#
# The exemption is BY FILE and listed here, not by a flag or a regex someone can
# widen. Adding a file to it should require arguing for it.
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 1

python3 - "$@" <<'PY'
import re, sys, pathlib

RENDERERS = r'(?:Text|String\(localized:|LocalizedStringKey|Label|accessibilityLabel|accessibilityHint|accessibilityValue|navigationTitle|confirmationDialog|alert)'
FORBIDDEN = re.compile(r'(?i)\bcredits?\b')
# \( ... ) with one level of nesting, which covers every call in this codebase.
INTERPOLATION = re.compile(r'\\\((?:[^()]|\([^()]*\))*\)')

def decomment(src: str) -> str:
    """Strip // line comments and /* */ blocks WITHOUT eating string literals."""
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c == '"':                      # copy a string literal verbatim
            out.append(c); i += 1
            while i < n:
                if src[i] == '\\' and i + 1 < n:
                    out.append(src[i:i+2]); i += 2; continue
                out.append(src[i])
                if src[i] == '"':
                    i += 1; break
                i += 1
            continue
        if src.startswith('//', i):
            j = src.find('\n', i); i = n if j < 0 else j
            continue
        if src.startswith('/*', i):
            j = src.find('*/', i); i = n if j < 0 else j + 2
            continue
        out.append(c); i += 1
    return ''.join(out)

# A string literal that sits inside a renderer call. Deliberately not a full
# parser: it takes the literal and looks BACKWARD on the same line for a
# renderer, which is how every user-facing string in this codebase is written.
LITERAL = re.compile(r'"((?:[^"\\]|\\.)*)"')

# The two surfaces where credits ARE the unit: held, and spent.
EXEMPT = {"Views/CreditBadge.swift", "Views/CreditsTopUpView.swift"}

violations = []
scanned = files = exempted = 0
for path in sorted(pathlib.Path('.').rglob('*.swift')):
    files += 1
    src = decomment(path.read_text(encoding='utf-8', errors='replace'))
    for lineno, line in enumerate(src.splitlines(), 1):
        for m in LITERAL.finditer(line):
            # INTERPOLATIONS ARE CODE, NOT COPY. "\(monthlyVideos(credits: n))
            # videos" renders "20 videos" and states no credit — the word is an
            # argument LABEL. Matching it would be the gate crying wolf on the
            # very file that removed the credit copy, and a gate that is wrong
            # five times in six trains you to skim past the one that is right.
            body = INTERPOLATION.sub(' ', m.group(1))
            scanned += 1
            if not FORBIDDEN.search(body):
                continue
            before = line[:m.start()]
            if not re.search(RENDERERS + r'[^"]*$', before):
                continue
            if str(path) in EXEMPT:
                exempted += 1
                continue
            violations.append((str(path), lineno, body.strip()))

print(f"[no-credit-numbers] scanned {scanned} string literals across {files} files "
      f"({exempted} on the two exempt surfaces)")
# THE EXEMPTION MUST BE LOAD-BEARING, not decorative. If those files stop
# stating credits the exemption is stale and should be removed rather than
# left as a licence nobody is using.
if exempted == 0:
    print("  ✗ the exempt surfaces state no credits at all — remove the exemption")
    sys.exit(1)

# POSITIVE CONTROL. A detector that finds nothing because it is looking in the
# wrong place, or because decomment ate the source, reports exactly what a clean
# tree reports. So prove the matcher fires on a known-bad line before believing
# a zero.
probe = 'Text("200 credits a month")'
assert FORBIDDEN.search('200 credits a month'), "CONTROL FAILED: matcher is dead"
assert re.search(RENDERERS + r'[^"]*$', probe[:probe.index('"')]), "CONTROL FAILED: renderer detection is dead"
assert not FORBIDDEN.search('credits_topup_upgrade_tap'), "CONTROL FAILED: snake_case not exempt"
# The interpolation stripper must remove an argument label WITHOUT removing
# prose next to it — both directions, or it silently exempts real copy.
assert not FORBIDDEN.search(INTERPOLATION.sub(' ', r'\(monthlyVideos(credits: a)) videos')), \
    "CONTROL FAILED: interpolated argument label still matches"
assert FORBIDDEN.search(INTERPOLATION.sub(' ', r'^[\(n) credit](inflect: true) left')), \
    "CONTROL FAILED: stripping interpolations ate real copy"
print("[no-credit-numbers] control: matcher fires on a known-bad line, ignores snake_case")
print("[no-credit-numbers] control: strips interpolated code, keeps prose beside it")

if violations:
    print(f"\nFAIL — {len(violations)} user-facing credit string(s):\n")
    for f, l, t in violations:
        print(f"  {f}:{l}\n      {t[:100]}")
    print("\nVideos are the unit everywhere except the credits button and top-up (259).")
    sys.exit(1)

print("[no-credit-numbers] PASS — no user-facing surface states credits")
PY
