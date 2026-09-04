#!/bin/bash
# INFLECTION MARKUP MUST REACH A RENDERER, NOT A STRING.
#
# `^[\(n) video](inflect: true)` is resolved by the LOCALIZATION SYSTEM AT
# RENDER TIME, from a LocalizedStringKey. `String(localized:)` returns a plain
# String, and a plain String has nowhere to put grammatical agreement — so it
# hands back the markup verbatim and the user reads:
#
#     Buy ^[10 video](inflect: true)
#
# That is exactly what shipped onto the top-up screen's primary CTA and the Max
# upsell line, and it is invisible to every check we had. The localization gate
# passes: the key IS in the catalogue, translated into eleven languages. The
# plural gate passes: the key HAS inflection markup, which is the good path it
# asks for. Both gates were satisfied by a string that rendered as source code
# on the most important button on a purchase screen.
#
# It took a screenshot to find, which is the failure mode worth naming: the two
# gates checked the CATALOGUE and neither checked the CALL. The defect lives in
# the seam between them.
#
# So: an inflected key may reach `Text(...)`, `Label(...)`, `Button("...")`,
# `AttributedString(localized:)` — anything that takes a LocalizedStringKey or
# resolves attributes. It may NOT go through `String(localized:)`.
set -uo pipefail
cd "$(dirname "$0")"

python3 - <<'PYEOF'
import os, re, subprocess, sys

root = os.path.join("Promptly")
out = subprocess.run(["find", root, "-name", "*.swift"], capture_output=True, text=True)
files = [f for f in out.stdout.split() if f.strip()]

# String(localized: "...") — possibly spanning lines — whose literal carries
# inflection markup. AttributedString(localized:) is fine: it resolves.
CALL = re.compile(r'\bString\s*\(\s*localized\s*:\s*"((?:[^"\\]|\\.)*)"', re.S)

bad = []
for f in files:
    if os.path.basename(f).startswith("__"):
        continue
    src = open(f, errors="ignore").read()
    lines = src.splitlines()
    for m in CALL.finditer(src):
        if "inflect:" not in m.group(1):
            continue
        line_no = src[:m.start()].count("\n") + 1
        # A commented example is prose about the defect, not the defect.
        if lines[line_no - 1].strip().startswith("//"):
            continue
        bad.append((f, line_no, m.group(1)[:64]))

if bad:
    print(f"inflection-render-gate: FAIL — {len(bad)} inflected key(s) go through String(localized:)")
    for f, n, k in bad:
        print(f"    {f}:{n}")
        print(f"        {k!r}")
    print("  Inflection resolves at RENDER. Pass the key to Text(...) directly,")
    print("  or use AttributedString(localized:) if you genuinely need a value.")
    sys.exit(1)

checked = sum(1 for f in files if not os.path.basename(f).startswith("__"))
print(f"inflection-render-gate: PASS — {checked} files, no inflected key round-trips through String")
PYEOF
