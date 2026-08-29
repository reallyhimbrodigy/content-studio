#!/bin/bash
# release-build-gate.sh — COMPILE THE CONFIGURATION YOU ACTUALLY SHIP (2026-08-28).
#
# THE DEFECT THIS LOCKS OUT:
#   `motionProof`, `autoDriveKey` and `autoDrive` were declared inside
#   `#if DEBUG` while their call sites were not. That compiles perfectly in
#   Debug and can NEVER compile in Release. Every simulator build passed, every
#   gate passed, the motion recordings were produced from it — and the break
#   surfaced only when the App Store archive failed, at ship time, on the build
#   meant to carry the UNS sub-codes to the fleet. Invisible to the entire
#   development loop, fatal exactly at delivery.
#
# WHY A COMPILE AND NOT A STATIC CHECK:
#   I wrote the static version first — parse `#if DEBUG` regions, find symbols
#   declared inside and referenced outside. It flagged six sites, of which one
#   was real and five were local variables named `a`, `d`, `url`, `top`,
#   `host`. It also could not see `#else` branches that legitimately supply a
#   Release variant. A gate with that false-positive rate is worse than no gate:
#   it trains you to skim past it, and the one real finding drowns. The compiler
#   already answers this question exactly, so ask the compiler.
#
# COST: ~1-3 min, which is why this is a SHIP-TIME gate rather than a
# per-commit one. Run it before any archive.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

# Provisioning must be real before the archive, not just declared in source.
bash "$DIR/associated-domains-gate.sh" || exit 1

echo "release-build-gate: compiling Release (the configuration the archive uses)…"
OUT=$(mktemp)
if xcodebuild -project "$DIR/Promptly.xcodeproj" -scheme Promptly \
     -configuration Release -destination "generic/platform=iOS" \
     -quiet build > "$OUT" 2>&1; then
  echo "release-build-gate: PASS — Release compiles."
  rm -f "$OUT"; exit 0
fi

echo "release-build-gate: FAILED — Release does NOT compile. Debug passing means nothing here."
grep -E "error:" "$OUT" | head -20 || tail -20 "$OUT"
rm -f "$OUT"
exit 1
