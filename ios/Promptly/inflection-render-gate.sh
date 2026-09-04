#!/bin/bash
# NO USER-FACING STRING MAY CONTAIN A LITERAL "^[" AT RENDER TIME.
#
# ── WHAT SHIPPED ────────────────────────────────────────────────────────────
# The primary CTA of the top-up screen read:
#
#     Buy ^[20 video](inflect: true)
#
# and every Pro subscriber's account screen read "200 credits a month - about
# ^[20 video](inflect: true)". Inflection markup is resolved by the localization
# system WHEN A LocalizedStringKey IS RENDERED. `String(localized:)` returns a
# plain String — which has nowhere to put grammatical agreement — so it hands
# the markup straight back, and whatever displays that String shows source code
# to the user.
#
# ── WHY THE EXISTING GATES COULD NOT SEE IT ─────────────────────────────────
# Two of them passed it, both correctly by their own rules:
#
#   • localization-gate.sh — the key IS in the catalogue, translated into
#     eleven languages, every placeholder intact.
#   • plain-language-gate.sh (plural-agreement) — the key DOES carry inflection
#     markup, which is the good path it exists to demand.
#
# Both read the CATALOGUE. Neither read the CALL. The defect lives in the seam:
# a correct key, correctly translated, produced through the wrong API.
#
# ── SO THIS GATE READS THE SCREEN ───────────────────────────────────────────
# A third catalogue rule would have the same blind spot. A call-site rule would
# catch `String(localized:)` and miss the next producer — `String(format:)`,
# `NSLocalizedString`, a value read out of the bundle, an interpolation nobody
# has thought of yet.
#
# So layer 2 does not reason about producers at all. It boots the app, renders
# every harness state, screenshots it, and OCRs the pixels. If markup reaches
# the glass, this sees it — whatever produced it. That is the only property
# worth having, because the leak is defined by what reaches the user.
#
# Layer 1 (static) still runs first, because it is instant and it names the
# offending line rather than the offending screen.
#
# RED-PROVEN: planting `String(localized: "Buy ^[\(n) video](inflect: true)")`
# on the CTA makes layer 1 name the line AND layer 2 read the markup off the
# rendered button. Both directions verified, not assumed.
set -uo pipefail
cd "$(dirname "$0")"

# ── LAYER 1: the producers we already know about ────────────────────────────
python3 - <<'PYEOF'
import os, re, subprocess, sys

out = subprocess.run(["find", "Promptly", "-name", "*.swift"], capture_output=True, text=True)
files = [f for f in out.stdout.split() if f.strip()]

# Any API that yields a plain String from a localized key. AttributedString(
# localized:) is deliberately absent: it RESOLVES, so it is the escape hatch
# for the rare case that genuinely needs a value rather than a view.
PRODUCERS = [
    (re.compile(r'\bString\s*\(\s*localized\s*:\s*"((?:[^"\\]|\\.)*)"', re.S), "String(localized:)"),
    (re.compile(r'\bNSLocalizedString\s*\(\s*"((?:[^"\\]|\\.)*)"', re.S), "NSLocalizedString"),
    (re.compile(r'\bString\s*\(\s*format\s*:\s*"((?:[^"\\]|\\.)*)"', re.S), "String(format:)"),
]

bad = []
for f in files:
    if os.path.basename(f).startswith("__"):
        continue
    src = open(f, errors="ignore").read()
    lines = src.splitlines()
    for rx, name in PRODUCERS:
        for m in rx.finditer(src):
            if "inflect:" not in m.group(1):
                continue
            line_no = src[:m.start()].count("\n") + 1
            if lines[line_no - 1].strip().startswith("//"):
                continue          # prose about the defect is not the defect
            bad.append((f, line_no, name, m.group(1)[:60]))

if bad:
    print(f"inflection-render-gate [static]: FAIL — {len(bad)} inflected key(s) produced as String")
    for f, n, api, k in bad:
        print(f"    {f}:{n}  via {api}")
        print(f"        {k!r}")
    print("  Inflection resolves at RENDER. Pass the key to Text(...) directly,")
    print("  or use AttributedString(localized:) if you genuinely need a value.")
    sys.exit(1)

n = sum(1 for f in files if not os.path.basename(f).startswith("__"))
print(f"inflection-render-gate [static]: PASS — {n} files, no inflected key produced as a String")
PYEOF
[ $? -ne 0 ] && exit 1

# ── LAYER 2: what the screen actually says ──────────────────────────────────
DERIVED="${1:-}"
SIM="${INFLECTION_GATE_SIM:-$(xcrun simctl list devices booted | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' | head -1)}"
BID=app.usepromptly.ios
STATES="${INFLECTION_GATE_STATES:-32 33 36 37 22 28 29 23 24 2 3 14}"

if [ -z "$DERIVED" ] || [ -z "$SIM" ]; then
  echo "inflection-render-gate [render]: SKIPPED — needs <derivedDataPath> and a booted simulator"
  echo "  usage: $0 <derivedDataPath>        (layer 1 ran; layer 2 is the one that reads pixels)"
  exit 1
fi

APP="$DERIVED/Build/Products/Debug-iphonesimulator/Promptly.app"
if [ ! -d "$APP" ]; then
  echo "inflection-render-gate [render]: FAIL — no simulator build at $APP"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The OCR helper is built once and cached next to the gate.
OCR="${TMPDIR:-/tmp}/promptly-inflection-ocr"
if [ ! -x "$OCR" ] || [ "$0" -nt "$OCR" ]; then
  cat > "$WORK/ocr.swift" <<'SWIFTEOF'
import Foundation
import Vision
import AppKit
guard CommandLine.arguments.count > 1,
      let img = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(2) }
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false      // must not "correct" markup into prose
try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
for obs in (req.results ?? []) {
    if let c = obs.topCandidates(1).first { print(c.string) }
}
SWIFTEOF
  swiftc -O "$WORK/ocr.swift" -o "$OCR" 2>/dev/null || {
    echo "inflection-render-gate [render]: FAIL — could not build the OCR helper"; exit 1; }
fi

xcrun simctl install "$SIM" "$APP" >/dev/null 2>&1 || {
  echo "inflection-render-gate [render]: FAIL — install failed"; exit 1; }

leaks=0
swept=0
for st in $STATES; do
  xcrun simctl terminate "$SIM" "$BID" >/dev/null 2>&1
  xcrun simctl launch "$SIM" "$BID" -snapshotPayoff YES -snapshotState "$st" >/dev/null 2>&1 || continue
  python3 -c "import time; time.sleep(6)"
  shot="$WORK/state-$st.png"
  xcrun simctl io "$SIM" screenshot "$shot" >/dev/null 2>&1 || continue
  swept=$((swept + 1))
  # "inflect" and "^[" are the two halves of the markup; OCR may render the
  # caret as any of several glyphs, so the WORD is the reliable signal.
  #
  # `**` IS THE SAME DEFECT CLASS. Markdown emphasis in a LocalizedStringKey is
  # resolved by the same pipeline and leaks the same way — bold the wrong side
  # of a String round-trip and the user reads "**$1.50 a video**". The hero
  # uses it, so the gate that exists because markup reached a purchase screen
  # covers both kinds of markup rather than only the one that got there first.
  hits=$("$OCR" "$shot" 2>/dev/null | grep -inE 'inflect|\^\[|\]\(inflect|\*\*' || true)
  if [ -n "$hits" ]; then
    leaks=$((leaks + 1))
    echo "  LEAK on harness state $st:"
    echo "$hits" | sed 's/^/      /'
    cp "$shot" "${TMPDIR:-/tmp}/inflection-leak-state-$st.png"
    echo "      capture: ${TMPDIR:-/tmp}/inflection-leak-state-$st.png"
  fi
done
xcrun simctl terminate "$SIM" "$BID" >/dev/null 2>&1

if [ "$swept" -eq 0 ]; then
  echo "inflection-render-gate [render]: FAIL — swept 0 states (nothing was read)"
  exit 1
fi
if [ "$leaks" -gt 0 ]; then
  echo "inflection-render-gate [render]: FAIL — markup reached the screen on $leaks of $swept state(s)"
  exit 1
fi
echo "inflection-render-gate [render]: PASS — $swept states OCR'd, no markup on any screen"
