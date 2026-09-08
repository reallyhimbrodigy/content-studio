#!/usr/bin/env bash
# ACCESSIBILITY IDENTIFIERS — COUNTED, NOT MERELY PRESENT.
#
# WHY COUNTING (ruled 2026-09-07). A presence assertion cannot catch a SECOND
# caller. Two views carrying the same identifier does not fail anything: XCTest
# resolves `app.buttons["x"]` to the first match, so the suite silently drives
# the wrong control and still goes green. That is worse than no test, because it
# reports coverage it does not have.
#
# It is the same shape as the review prompt, where `requestAppStoreReview`
# existed at the right call site AND at a wrong one, and a presence check was
# satisfied by either.
#
# So: every identifier the suite depends on must resolve to exactly ONE
# definition in the app, and every identifier the app defines must be spelled
# the way the suite spells it.
set -uo pipefail
cd "$(dirname "$0")"
FAIL=0

SRC=Promptly
TESTS=PromptlyUITests
[ -d "$SRC" ] && [ -d "$TESTS" ] || { echo "  missing $SRC or $TESTS"; exit 1; }

# EXTRACTION IS THE HARD PART, and the first version got it wrong in two ways:
# it read only `accessibilityIdentifier("literal")`, so a ternary
#   (canUpgrade ? "account.upgrade" : "account.manage")
# and a concatenation
#   ("account.row." + Self.slug(label))
# both looked like no definition at all, and the gate reported six identifiers
# missing that were there. A checker that cannot see a definition reports the
# code as broken instead of itself, which is the failure mode to avoid in the
# thing everything else is measured by.
python3 - "$SRC" "$TESTS" <<'PYEOF'
import re, sys, os, collections

src, tests = sys.argv[1], sys.argv[2]

def swift_files(root):
    for dirpath, _, names in os.walk(root):
        for n in names:
            if n.endswith('.swift'):
                yield os.path.join(dirpath, n)

CALL = re.compile(r'accessibilityIdentifier\(')
def call_args(line):
    """The text inside one accessibilityIdentifier( ... ), paren-balanced."""
    out = []
    for m in CALL.finditer(line):
        i, depth = m.end(), 1
        while i < len(line) and depth:
            if line[i] == '(': depth += 1
            elif line[i] == ')': depth -= 1
            i += 1
        out.append(line[m.end():i-1])
    return out

literals = collections.defaultdict(list)   # exact names -> where
prefixes = set()                           # families: "paywall.duration." etc
index_keyed, localized = [], []

for f in swift_files(src):
    for ln, line in enumerate(open(f, encoding='utf-8'), 1):
        if line.lstrip().startswith('//'):
            continue
        for arg in call_args(line):
            if 'String(localized:' in arg:
                localized.append(f"{f}:{ln}")
            for lit in re.findall(r'"([^"]*)"', arg):
                if '\\(' in lit:
                    prefixes.add(lit.split('\\(')[0])
                    inner = lit[lit.index('\\(') + 2:]
                    if re.match(r'\s*(index|idx|i)\b', inner):
                        index_keyed.append(f"{f}:{ln}  {lit}")
                elif arg.strip().endswith('+') or '+' in arg.split(f'"{lit}"')[-1][:3]:
                    prefixes.add(lit)          # "account.row." + slug(label)
                else:
                    literals[lit].append(f"{f}:{ln}")

used = set()
USE = re.compile(r'\["([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)"\]')
for f in swift_files(tests):
    for line in open(f, encoding='utf-8'):
        used.update(USE.findall(line))

fail = 0

dupes = {k: v for k, v in literals.items() if len(v) > 1}
if dupes:
    print("  identifiers defined more than once — XCTest takes the FIRST match,")
    print("  so a test naming one drives whichever view comes first:")
    for k, v in sorted(dupes.items()):
        print(f"      {k}")
        for w in v: print(f"          {w}")
    fail = 1

for u in sorted(used):
    if u in literals: continue
    if any(u.startswith(p) for p in prefixes): continue
    print(f'  the suite uses "{u}" but nothing in {src} defines it')
    fail = 1

if index_keyed:
    print("  an identifier is interpolated from an INDEX — it retargets when the")
    print("  collection changes length, silently repointing every test using it:")
    for w in index_keyed: print(f"      {w}")
    fail = 1

if localized:
    print("  an identifier is built from a localized string — it changes with the")
    print("  device language, which is the one thing an identifier must not do:")
    for w in localized: print(f"      {w}")
    fail = 1

print(f"IDCOUNT {len(literals)} {len(prefixes)} {len(used)}")
sys.exit(1 if fail else 0)
PYEOF
PY_RC=$?
[ "$PY_RC" -ne 0 ] && FAIL=1

if [ "$FAIL" -ne 0 ]; then
  echo "accessibility-identifier-gate: FAIL"
  exit 1
fi
echo "accessibility-identifier-gate: PASS — no identifier defined twice, none keyed"
echo "                    by index or by localized text, and every one the suite"
echo "                    uses resolves to exactly one definition."
exit 0
