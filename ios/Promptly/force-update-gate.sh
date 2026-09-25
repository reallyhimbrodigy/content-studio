#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# force-update-gate.sh — THE ONE SCREEN THAT CAN MAKE THE APP UNUSABLE.
#
# A forced update cover is the only surface in the product with no way past it.
# It therefore has exactly two ways to be wrong, and they fail in opposite
# directions:
#
#   IT CANNOT FIRE WHEN IT SHOULD. The floor was `min_supported_version` alone,
#   compared with VersionMath.isOlder. Two builds of ONE version are
#   indistinguishable to it — and that is the live case, not a hypothetical:
#   261 and 262 are both 1.3.39, so `isOlder("1.3.39", than: "1.3.39")` is
#   false and no version floor could ever move anyone off 261. The failure
#   looks exactly like the flag being off, which is why it would have gone
#   unnoticed.
#
#   IT FIRES WHEN IT SHOULD NOT. A missing CFBundleVersion read as build 0 is
#   below every floor. A non-numeric knob parsed with a defaulting `Int(x) ?? 0`
#   is below every floor. Either one blocks the entire install base on a
#   config typo, with no way for the user to get past it and no way for us to
#   reach them except another config push.
#
# So: the build floor must EXIST, and every unreadable path must fall to NOT
# forcing.
set -uo pipefail
cd "$(dirname "$0")"
V="Promptly/Services/VersionAwareness.swift"
fail=0
note() { echo "  FAIL — $1"; fail=1; }
[ -f "$V" ] || { echo "  FAIL — missing $V (a failed read is not a pass)"; exit 1; }

echo "force-update-gate:"

# ── 1. THERE IS A BUILD FLOOR AT ALL ────────────────────────────────────────
grep -Fq 'health?["min_supported_build"]' "$V" \
  && echo "  ok   — a min_supported_build floor is read from config" \
  || note "no min_supported_build is parsed — a version floor alone cannot separate two builds of one version, which is exactly 261 vs 262"

ingest="$(sed -n '/func ingest(/,/^    }/p' "$V")"
printf '%s' "$ingest" | grep -Eq 'updateRequired = forceArmed && \(versionBelowFloor \|\| buildBelowFloor\)' \
  && echo "  ok   — either floor forces: below the version OR below the build" \
  || note "updateRequired does not combine both floors — one of them is dead"

# ── 2. THE BUILD COMES FROM CFBundleVersion, NOT THE VERSION STRING ────────
bb="$(sed -n '/static func bundleBuild()/,/^    }/p' "$V")"
if [ -z "$bb" ]; then
  note "there is no bundleBuild() — nothing reads the build number"
else
  printf '%s' "$bb" | grep -Fq 'CFBundleVersion' \
    && echo "  ok   — bundleBuild reads CFBundleVersion" \
    || note "bundleBuild does not read CFBundleVersion — CFBundleShortVersionString is the VERSION and cannot separate two builds"
  # `?? 0` here is the brick: build 0 is below every floor.
  printf '%s' "$bb" | grep -Eq '\?\?[[:space:]]*0' \
    && note "bundleBuild defaults to 0 — an unreadable build is then below every floor and blocks the whole install base" \
    || echo "  ok   — an unreadable build is nil, not 0"
  printf '%s' "$bb" | grep -Fq -- '-> Int?' \
    && echo "  ok   — bundleBuild is optional, so 'unknown' is representable" \
    || note "bundleBuild is non-optional — 'unknown' has to be spelled as some number, and every number is below or above a floor"
fi

# ── 3. NEVER BRICK ON CONFIG ────────────────────────────────────────────────
bf="$(printf '%s' "$ingest" | sed -n '/let buildBelowFloor/,/}()/p')"
if [ -z "$bf" ]; then
  note "no buildBelowFloor computation found to check"
else
  printf '%s' "$bf" | grep -Fq 'else { return false }' \
    && echo "  ok   — an unreadable floor or build falls to NOT forcing" \
    || note "the build-floor guard does not fall to false — an unreadable config could force the cover on everyone"
  printf '%s' "$bf" | grep -Eq 'Int\(minBuild\)' \
    && echo "  ok   — the floor is parsed strictly, with no defaulting" \
    || note "min_supported_build is not parsed with a failable Int — a typo would become a number"
  printf '%s' "$bf" | grep -Eq 'floor > 0' \
    && echo "  ok   — a zero or negative floor is no opinion" \
    || note "a floor of 0 is not excluded — every build is above 0, or below it, depending on the comparison; neither is 'no opinion'"
fi

# ── 4. DARK UNLESS ARMED ────────────────────────────────────────────────────
printf '%s' "$ingest" | grep -Eq 'let forceArmed = \(health\?\["force_update"\] as\? String\) == "on"' \
  && echo "  ok   — the cover is dark unless force_update is explicitly \"on\"" \
  || note "force_update is not required to be \"on\" — the cover could arm on an absent or malformed field"

[ "$fail" = 0 ] && echo "force-update-gate: PASS" || echo "force-update-gate: FAIL"
exit "$fail"
