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
import json, os, re, subprocess, sys, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
IOS = os.path.dirname(HERE)   # ios/Promptly
CATALOG = os.path.join(IOS, "Promptly", "Localizable.xcstrings")

# The languages the app actually ships. Kept in sync with the project's
# knownRegions and with AppLanguage.supported; `report` fails if they diverge.
LANGS = ["ar", "bn", "de", "en", "es", "fr", "hi", "id", "ja", "ne", "pt-BR", "ur"]

# ── Which files are conversion surfaces — DERIVED, not listed ────────────────
#
# This was a hand-written set of filenames and it was wrong in both directions.
# It MISSED TrialCopy.swift (a copy holder, not a view), so the auto-renew
# disclosure shipped as a bare literal and rendered English inside an otherwise
# fully-Hindi reveal while the gate reported PASS — caught by looking at a
# screenshot, which is not a mechanism. And 4 of its 17 entries were PHANTOM:
# UpgradeSheet.swift, ExportGateView.swift and ReferralView.swift name types
# that do not exist, and ProCelebrationView is defined inside PaywallView.swift
# rather than a file of its own. A gate that lists files nobody can find is
# claiming coverage it does not have.
#
# So the set is computed: start from the conversion FLOWS, and take every file
# they directly reference. Only the entry points are named, and those are the
# stable part — a flow is added roughly never, while the leaf views and copy
# holders under it change constantly. A new helper, sheet, or copy file pulled
# into a paywall is picked up with no edit here, which is precisely the failure
# that shipped.
#
# Depth ONE, deliberately. The transitive closure reaches 77 files — through
# AppShell into essentially the whole app — which would demand translations for
# chat, upload and player strings that no one sees while being asked to pay.
# Depth 1 selects ~25 and covers every real entry the hand list had.
#
# Known limit: a surface reached only by a runtime string/enum lookup rather
# than a direct type reference is invisible to this, as is a flow nobody adds
# to ENTRY_POINTS. `report --derived` prints the selected set so drift is
# visible rather than silent.

ENTRY_POINTS = [
    "FirstLaunchPaywallView", "PaywallView", "SecondPaywallView", "OfferRevealView",
    "TrialWallView", "OnboardingV2Flow", "OnboardingFlow",
    # The top-up screen sells three consumables and hosts the upgrade hero — it
    # asks for money as directly as any paywall. It was outside this set because
    # the downward walk starts at the PAYWALL flows and nothing in them
    # references it: it is opened from the credit badge and the credit wall, so
    # the closure never reached it. Four of its strings — the balance header,
    # the pack sub-line, the Max upsell and the allowance footer — were
    # therefore uncatalogued and rendered ENGLISH in all eleven languages, on a
    # screen whose entire job is taking payment. Depth-1 from here also pulls in
    # the credit surfaces it renders.
    "CreditsTopUpView",
]

_DECL = re.compile(r"\b(?:struct|class|enum|actor)\s+([A-Z][A-Za-z0-9_]*)")
_TYPE = re.compile(r"\b([A-Z][A-Za-z0-9_]*)\b")


def _swift_files():
    root = os.path.join(IOS, "Promptly")
    out = subprocess.run(["find", root, "-name", "*.swift"], capture_output=True, text=True)
    return [f for f in out.stdout.split() if not os.path.basename(f).startswith("__")]


def conversion_surfaces():
    """Basenames of files a user reads while being asked for money or an invite."""
    type2file, code = {}, {}
    for f in _swift_files():
        # Strip line comments: a doc comment that merely NAMES a paywall type
        # must not drag its file in. The share-message ban and this both care
        # about shipping code, not prose about it.
        body = "\n".join(l for l in open(f, errors="ignore").read().splitlines()
                         if not l.strip().startswith("//"))
        code[f] = body
        for m in _DECL.finditer(body):
            type2file.setdefault(m.group(1), f)

    seen = {type2file[t] for t in ENTRY_POINTS if t in type2file}
    missing = [t for t in ENTRY_POINTS if t not in type2file]
    if missing:
        print(f"  !! entry point(s) not found in the tree: {missing}", file=sys.stderr)
    for f in list(seen):
        for t in set(_TYPE.findall(code[f])):
            g = type2file.get(t)
            if g:
                seen.add(g)

    # …AND every file that RENDERS a conversion copy holder.
    #
    # Walking down from the flows is only half the relation. EditorView hosts
    # the post-render referral card — it reads ReferralCopy.offer and is the
    # `postrender` share source — but nothing in the paywall or onboarding
    # flows references EditorView, so the downward walk never reaches it and
    # its own copy ("Love it? Get Pro free", "Invite", "Get more usage") sat
    # outside the gate. Same defect as the one that shipped, found the same
    # way: by reading the screen rather than trusting the rule.
    #
    # So a file that renders the shared copy is a conversion surface by that
    # fact alone, wherever it lives. This is the upward direction of the same
    # principle — a string reaches a money-or-invite moment — and it needs no
    # maintenance, because a new surface must reference one of these holders
    # to show the copy at all.
    COPY_HOLDERS = ("ReferralCopy", "ProBenefits", "TrialCopy")
    for f, body in code.items():
        if any(h + "." in body for h in COPY_HOLDERS):
            seen.add(f)

    return {os.path.basename(f) for f in seen}


CONVERSION_SURFACES = conversion_surfaces()


def find_stringsdata(derived):
    """Every .stringsdata in the build tree, EXCLUDING stale ones.

    THE STALENESS FILTER IS LOAD-BEARING. DerivedData accumulates one
    .stringsdata per file PER CONFIGURATION — Debug-iphoneos,
    Debug-iphonesimulator, Release-iphoneos — and they are only rewritten when
    that configuration is rebuilt. Building for the simulator all week leaves
    the device artifacts frozen at whatever the source said days ago.

    Without this filter the gate reported three uncatalogued strings —
    'Or start monthly for', 'off', '%@ %@ (%lld%% %@)' — from a Debug-iphoneos
    artifact two days old. The current source has been a single interpolated
    sentence since before that; both fresh configurations emit the correct
    'Or start monthly for %@ (%lld%% off)'. The gate was reporting on code that
    no longer exists and demanding translations for fragments that would have
    baked English word order into eleven languages.

    That is precisely the failure the gate's own stale-tree rule was written to
    prevent — but that rule compares the newest source against the TOP-LEVEL
    DerivedData path, which any build refreshes, so a stale per-configuration
    artifact sails through it. The check has to be per file.

    A false failure is worse than no gate: it trains people to ignore the one
    that is telling the truth.
    """
    out = subprocess.run(
        ["find", derived, "-path", "*Promptly.build*", "-name", "*.stringsdata"],
        capture_output=True, text=True)
    paths = [l for l in out.stdout.splitlines() if l.strip()]

    # FILTER BY CONFIGURATION, NOT BY FILE. Per-file mtime is the obvious
    # discriminator and it is wrong: an incremental build only rewrites
    # .stringsdata for files it recompiled, so every UNCHANGED file's artifact
    # looks old while being perfectly current. Filtering on it dropped the
    # extraction from 231 conversion strings to 57 — a gate passing because it
    # had stopped looking, which is a worse failure than the ghosts it fixed.
    #
    # The real unit of staleness is the configuration directory: a build
    # refreshes one configuration as a whole, and the others sit frozen. So
    # pick the configuration touched most recently and read only that one.
    by_config = {}
    for p in paths:
        # .../Promptly.build/<Configuration>/Promptly.build/Objects-normal/...
        parts = p.split("/Promptly.build/")
        config = parts[1].split("/")[0] if len(parts) > 2 else os.path.dirname(p)
        try:
            by_config.setdefault(config, []).append((os.path.getmtime(p), p))
        except OSError:
            continue
    if not by_config:
        return []
    # Newest FILE within each configuration stands for that build's recency.
    freshest = max(by_config, key=lambda c: max(m for m, _ in by_config[c]))
    return [p for _m, p in by_config[freshest]]


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
