#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# localization-gate.sh — makes English-only conversion copy impossible to ship.
#
# WHAT WENT WRONG THAT THIS PREVENTS
# The whole first-launch funnel — paywall, three questions, offer reveal, the
# benefit claims — shipped rendering English in all twelve otherwise-localized
# languages, in markets where India alone is 55% of wall views. Nothing caught
# it: the strings were never added to the catalog, and a missing entry falls
# back to the key, which IS the English text. It renders perfectly. There is no
# crash, no blank, no log line. It looks correct in every screenshot.
#
# THREE CHECKS, because there are three distinct ways to ship English:
#
#   1 UNEXTRACTED — a user-facing literal that never reaches the catalog at all.
#     `title: "How did you hear about us?"` in a struct is a plain String, not a
#     LocalizedStringKey, so the compiler never emits it and no catalog check can
#     see it. That is exactly how Q3 shipped. Checked against the compiler's own
#     .stringsdata, so the question is "did the compiler see it", not "did a
#     regex find it".
#
#   2 UNTRANSLATED — extracted and present, but with no value for a language.
#     Falls back to English silently.
#
#   3 BROKEN PLACEHOLDER — translated, but the format specifier was dropped or
#     changed. "Your first year is %lld%% off" with the %lld dropped renders
#     "Your first year is % off"; worse, a translator who writes %@ where the
#     compiler emits %lld produces a lookup that never matches, so the string
#     falls back to English while the catalog looks complete and green.
#     The existing banned-percentage gate cannot catch any of this — it scans
#     SOURCE for literal percentages, and a translation is not source.
#
# Positional specifiers (%1$@) are correct and expected: a language that
# reorders arguments MUST use them. So the comparison is on the multiset of
# argument TYPES with position stripped, not on the raw strings.
#
# Exemptions are by content, not by filename: a key with no letters in any
# script (punctuation, "%@ %@", "·") has nothing to translate.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")"

DERIVED="${1:-}"
if [ -z "$DERIVED" ] || [ ! -d "$DERIVED" ]; then
  echo "usage: $0 <derivedDataPath>   (needs a build's .stringsdata)"
  exit 2
fi

# Assert we are reading the DEPLOYED tree, not a stale build: the standing
# stale-tree rule. A .stringsdata older than the newest Swift source on a
# conversion surface means the extraction predates the code it claims to cover.
NEWEST_SRC=$(find Promptly -name "*.swift" -newer "$DERIVED" -print -quit 2>/dev/null || true)
if [ -n "$NEWEST_SRC" ]; then
  echo "STALE: $NEWEST_SRC is newer than the build at $DERIVED"
  echo "       rebuild before gating, or the gate reports on code that is not there."
  exit 1
fi

python3 - "$DERIVED" <<'PY'
import json, os, re, subprocess, sys
sys.path.insert(0, "Scripts")
import loc_sync as L

derived = sys.argv[1]
keys = L.extract(derived)
cat = L.load_catalog()["strings"]
targets = [l for l in L.LANGS if l != "en"]   # en is the source language

# A key with no letter in ANY script has nothing to translate.
HAS_LETTER = re.compile(r"[^\W\d_]", re.UNICODE)
# %%, %@, %lld, %d, and their positional forms %1$@ / %2$lld.
SPEC = re.compile(r"%(?:%|(?:(\d+)\$)?(@|lld|ld|d|f|\.\df))")

def types(s):
    """Multiset of argument types, position stripped; %% counted separately."""
    args, escapes = [], 0
    for m in SPEC.finditer(s):
        if m.group(0) == "%%":
            escapes += 1
        else:
            args.append(m.group(2))
    return sorted(args), escapes

conv = {k: v for k, v in keys.items() if L.CONVERSION_SURFACES & set(v)}
unextracted, untranslated, broken = [], [], []

for k, srcs in sorted(conv.items()):
    if not HAS_LETTER.search(k):
        continue
    entry = cat.get(k)
    if entry is None:
        unextracted.append((k, srcs))
        continue
    locs = entry.get("localizations") or {}
    want_args, want_esc = types(k)
    gaps = []
    for lang in targets:
        val = (locs.get(lang) or {}).get("stringUnit", {}).get("value")
        if not val:
            gaps.append(lang)
            continue
        got_args, got_esc = types(val)
        if got_args != want_args or got_esc != want_esc:
            broken.append((k, lang, val, want_args, want_esc, got_args, got_esc))
    if gaps:
        untranslated.append((k, srcs, gaps))

fail = 0
if unextracted:
    fail = 1
    print(f"\n✗ NOT IN CATALOG ({len(unextracted)}) — renders English in all {len(targets)} languages:")
    for k, srcs in unextracted[:25]:
        print(f"    {k[:64]!r}  <- {','.join(srcs)}")
if untranslated:
    fail = 1
    print(f"\n✗ UNTRANSLATED ({len(untranslated)}) — silent English fallback:")
    for k, srcs, gaps in untranslated[:25]:
        print(f"    {k[:52]!r} missing {len(gaps)}: {','.join(gaps)}")
if broken:
    fail = 1
    print(f"\n✗ PLACEHOLDER BROKEN ({len(broken)}) — a false claim in that language:")
    for k, lang, val, wa, we, ga, ge in broken[:25]:
        print(f"    [{lang}] {k[:46]!r}")
        print(f"          want args={wa} %%={we}   got args={ga} %%={ge}")
        print(f"          {val[:72]!r}")

checked = sum(1 for k in conv if HAS_LETTER.search(k))
if not fail:
    print(f"✓ localization gate: {checked} conversion-surface strings, "
          f"all present and translated into {len(targets)} languages, "
          f"all placeholders intact")
sys.exit(fail)
PY
