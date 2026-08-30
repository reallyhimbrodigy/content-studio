#!/usr/bin/env python3
"""
loc_sync.py — the String Catalog's tooling, in one place.

WHY THIS EXISTS RATHER THAN "just build in Xcode":
Xcode merges compiler-extracted strings back into Localizable.xcstrings only on
some builds — a full build does it, an incremental one may not. That is fine for
a human in the IDE and useless for a gate, which needs the same answer every
time. So extraction is read straight from the compiler's own .stringsdata files,
which are emitted on EVERY build and are the same source of truth Xcode itself
merges from.

The keys matter more than they look. `String(localized: "…\\(pct)% off")` with an
Int interpolation compiles to the key "…%lld%% off" — NOT "%@". A catalog entry
written with the wrong specifier never matches the runtime lookup, so the string
silently falls back to English while the catalog looks complete. Reading keys
from the compiler removes the guess entirely.

Subcommands:
  extract  — dump the authoritative key set (key -> source files) as JSON
  merge    — add any missing extracted key to the catalog (no translations)
  apply    — write translations from a JSON map into the catalog
  report   — per-language coverage, plus the untranslated set by surface
"""
import json, os, subprocess, sys, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
IOS = os.path.dirname(HERE)   # ios/Promptly
CATALOG = os.path.join(IOS, "Promptly", "Localizable.xcstrings")

# The languages the app actually ships. Kept in sync with the project's
# knownRegions and with AppLanguage.supported; `report` fails if they diverge.
LANGS = ["ar", "bn", "de", "en", "es", "fr", "hi", "id", "ja", "ne", "pt-BR", "ur"]

# Surfaces where a user is being asked for money or for an invite. A string here
# that is not in the catalog renders English at the payment moment.
#
# THIS LIST IS THE GATE'S WEAK POINT, and it has already failed once. The first
# version omitted TrialCopy.swift — a copy holder, not a view — and the
# auto-renew disclosure under the offer reveal shipped as a bare literal and
# rendered English inside an otherwise fully-Hindi screen. The gate was green.
# It was caught by looking at a screenshot, which is not a mechanism.
#
# So: a file belongs here if its strings can REACH a conversion surface, not
# only if it draws one. Copy holders (TrialCopy, ProBenefits, ReferralCopy)
# count. When adding a paywall/onboarding/referral surface, add it here too —
# `report` prints the per-file key counts to make an omission visible.
CONVERSION_SURFACES = {
    "OfferRevealView.swift", "OnboardingV2Flow.swift", "OnboardingQuestionView.swift",
    "VideoTypeQuestionView.swift", "AttributionAskView.swift", "ProBenefits.swift",
    "FirstLaunchPaywallView.swift", "PaywallView.swift", "SecondPaywallView.swift",
    "ReferralCopy.swift", "ReferralView.swift", "ResultsWallView.swift",
    "TrialCopy.swift", "TrialWallView.swift", "ProCelebrationView.swift",
    "UpgradeSheet.swift", "ExportGateView.swift",
}


def find_stringsdata(derived):
    out = subprocess.run(
        ["find", derived, "-path", "*Promptly.build*", "-name", "*.stringsdata"],
        capture_output=True, text=True)
    return [l for l in out.stdout.splitlines() if l.strip()]


def extract(derived):
    """key -> sorted list of source files that produce it."""
    keys = {}
    for f in find_stringsdata(derived):
        r = subprocess.run(["plutil", "-convert", "json", "-o", "-", f], capture_output=True)
        if r.returncode:
            continue
        try:
            j = json.loads(r.stdout)
        except Exception:
            continue
        src = os.path.basename(f).replace(".stringsdata", ".swift")
        for rows in (j.get("tables") or {}).values():
            for row in rows:
                k = row.get("key")
                if k:
                    keys.setdefault(k, set()).add(src)
    return {k: sorted(v) for k, v in keys.items()}


def load_catalog():
    with open(CATALOG) as f:
        return json.load(f)


def save_catalog(cat):
    with open(CATALOG, "w") as f:
        json.dump(cat, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")


def cmd_merge(args):
    keys = extract(args.derived)
    cat = load_catalog()
    added = 0
    for k in keys:
        if k not in cat["strings"]:
            cat["strings"][k] = {"extractionState": "manual", "localizations": {}}
            added += 1
    save_catalog(cat)
    print(f"extracted {len(keys)} keys; added {added} missing to the catalog")


def cmd_apply(args):
    """translations JSON: {key: {lang: value}}"""
    with open(args.translations) as f:
        tr = json.load(f)
    cat = load_catalog()
    wrote = skipped = 0
    for key, per in tr.items():
        entry = cat["strings"].setdefault(key, {"extractionState": "manual", "localizations": {}})
        locs = entry.setdefault("localizations", {})
        for lang, val in per.items():
            if lang not in LANGS:
                print(f"  !! unknown language {lang} for {key[:40]}", file=sys.stderr)
                skipped += 1
                continue
            locs[lang] = {"stringUnit": {"state": "translated", "value": val}}
            wrote += 1
    save_catalog(cat)
    print(f"wrote {wrote} translations ({skipped} skipped)")


def cmd_report(args):
    cat = load_catalog()["strings"]
    keys = extract(args.derived) if args.derived else {k: [] for k in cat}
    total = len(cat)
    print(f"catalog entries: {total}\n")
    print("per-language coverage (a gap here is a silent English fallback):")
    for lang in LANGS:
        have = sum(1 for v in cat.values()
                   if (v.get("localizations") or {}).get(lang, {}).get("stringUnit", {}).get("value"))
        pct = 100.0 * have / total if total else 0
        print(f"  {lang:6s} {have:4d}/{total}  {pct:5.1f}%")

    if keys:
        conv = {k: v for k, v in keys.items() if CONVERSION_SURFACES & set(v)}
        missing = {}
        for k, v in conv.items():
            entry = cat.get(k) or {}
            locs = entry.get("localizations") or {}
            gaps = [l for l in LANGS if l != "en"
                    and not locs.get(l, {}).get("stringUnit", {}).get("value")]
            if gaps:
                missing[k] = (v, gaps)
        print(f"\nconversion-surface keys: {len(conv)}   with gaps: {len(missing)}")
        for k, (srcs, gaps) in sorted(missing.items())[:40]:
            print(f"  {k[:52]:54s} missing {len(gaps):2d}: {','.join(gaps[:6])}")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn in (("merge", cmd_merge), ("report", cmd_report)):
        s = sub.add_parser(name)
        s.add_argument("--derived", required=(name == "merge"))
        s.set_defaults(fn=fn)
    s = sub.add_parser("extract"); s.add_argument("--derived", required=True)
    s.set_defaults(fn=lambda a: print(json.dumps(extract(a.derived), ensure_ascii=False, indent=1)))
    s = sub.add_parser("apply"); s.add_argument("--translations", required=True)
    s.set_defaults(fn=cmd_apply)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
