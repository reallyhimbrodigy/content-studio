#!/bin/bash
# APP REVIEW CAPTURES, shot and validated in one command.
#
# These have now been re-shot four times, twice for reasons that had nothing to
# do with the design: a size nobody had checked against Apple's list, and an
# alpha channel `simctl` adds to every PNG it writes. Both are mechanical, both
# are invisible in the image, and both are checkable — so they are checked here
# rather than discovered by an upload failing.
#
# WHAT IT ENFORCES
#   • Native capture at an ACCEPTED size. No resampling — a resized screenshot
#     softens text, and text is the entire content of a purchase screen.
#   • No alpha. Apple: "Images can't include alpha channels or transparencies."
#     `simctl io screenshot` always writes RGBA, so every capture violates this
#     until flattened. Composited onto black rather than having the channel
#     dropped, so nothing shifts.
#   • A clean status bar, so iOS chrome does not look like a device mid-update.
#
# WHAT IT DOES NOT KNOW
#   Whether the SCREEN is right. That is what the OCR pass and a human looking
#   at the picture are for.
#
# usage: asc-capture.sh <derivedDataPath> <outputDir> <state:name> [state:name ...]
set -uo pipefail
cd "$(dirname "$0")/.."

DERIVED="${1:-}"; OUTDIR="${2:-}"; shift 2 2>/dev/null
if [ -z "$DERIVED" ] || [ -z "$OUTDIR" ] || [ $# -eq 0 ]; then
  echo "usage: $0 <derivedDataPath> <outputDir> <state:name> [state:name ...]"
  exit 1
fi

DEVICE="${ASC_CAPTURE_DEVICE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max}"
RUNTIME="${ASC_CAPTURE_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-4}"
BID=app.usepromptly.ios
APP="$DERIVED/Build/Products/Debug-iphonesimulator/Promptly.app"

[ -d "$APP" ] || { echo "asc-capture: FAIL — no simulator build at $APP"; exit 1; }
mkdir -p "$OUTDIR"

SIM=$(xcrun simctl list devices | grep "Promptly-asc-review" | grep -oE '[0-9A-F-]{36}' | head -1)
if [ -z "$SIM" ]; then
  SIM=$(xcrun simctl create "Promptly-asc-review" "$DEVICE" "$RUNTIME") || {
    echo "asc-capture: FAIL — could not create the capture device"; exit 1; }
fi
xcrun simctl boot "$SIM" >/dev/null 2>&1
python3 -c "import time; time.sleep(12)"
xcrun simctl install "$SIM" "$APP" >/dev/null 2>&1 || {
  echo "asc-capture: FAIL — install failed"; exit 1; }
xcrun simctl status_bar "$SIM" override --time "9:41" \
  --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 \
  --batteryState charged --batteryLevel 100 >/dev/null 2>&1

shot_ok=0
for pair in "$@"; do
  st="${pair%%:*}"; name="${pair##*:}"
  xcrun simctl terminate "$SIM" "$BID" >/dev/null 2>&1
  xcrun simctl launch "$SIM" "$BID" -snapshotPayoff YES -snapshotState "$st" >/dev/null 2>&1 || {
    echo "  $name: FAIL — launch"; continue; }
  python3 -c "import time; time.sleep(8)"
  raw="$OUTDIR/.$name.raw.png"
  xcrun simctl io "$SIM" screenshot "$raw" >/dev/null 2>&1 || {
    echo "  $name: FAIL — screenshot"; continue; }

  python3 - "$raw" "$OUTDIR/$name.png" <<'PYEOF' || continue
import sys
from PIL import Image
# Apple's accepted iPhone sizes, portrait (6.9" / 6.5" / 6.3").
ACCEPTED = {(1320,2868),(1290,2796),(1260,2736),
            (1284,2778),(1242,2688),
            (1206,2622),(1179,2556)}
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src)
if im.size not in ACCEPTED:
    print(f"      REJECTED {im.size[0]}x{im.size[1]} — not an accepted App Store size")
    sys.exit(1)
flat = Image.new("RGB", im.size, (0, 0, 0))
flat.paste(im, mask=im.split()[3] if im.mode == "RGBA" else None)
flat.save(dst, "PNG", optimize=True)
chk = Image.open(dst)
assert chk.mode == "RGB" and chk.size == im.size
print(f"      {chk.size[0]}x{chk.size[1]}  RGB, no alpha")
PYEOF
  rm -f "$raw"
  echo "  $name: OK"
  shot_ok=$((shot_ok + 1))
done

xcrun simctl terminate "$SIM" "$BID" >/dev/null 2>&1
xcrun simctl status_bar "$SIM" clear >/dev/null 2>&1

if [ "$shot_ok" -ne $# ]; then
  echo "asc-capture: FAIL — $shot_ok of $# captures produced"
  exit 1
fi
echo "asc-capture: $shot_ok capture(s) in $OUTDIR — accepted size, no alpha, clean status bar"
