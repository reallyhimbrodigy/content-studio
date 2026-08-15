#!/usr/bin/env python3
"""PHASE-1 COMPONENT SCORECARD — every component scored against the two references
as it lands `[§7.1, §3.1]`.

Runs the reference-calibrated battery (`lumen_video_dimensions.py`) against a
component's rendered artifact and reports each dimension against the bar the
REFERENCES set — not against our own past output. Scoring against history only
proves we did not regress; scoring against the bar is what proves we arrived.

APPLICABILITY IS THE WHOLE DESIGN, and it is a discipline point, not a
convenience. A component is a FRAGMENT: a name-plate is a 2s static overlay, an
end-card is a held frame, a music bed has no picture at all. Applying a
whole-edit bar to a fragment manufactures false failures — a static end-card
would "fail" the 3.5s stillness ceiling by doing exactly what an end-card is
supposed to do. So each component declares which dimensions APPLY, and every
other dimension is reported N/A rather than scored. **An N/A is not a pass and
must never be counted as one.**

Component applicability is declared from the build sheet's own descriptions:

  B insert_scenes      motion, palette, canvas          (a moving inserted scene)
  H music_bed          audio ONLY                       (no picture)
  C text_behind        palette, canvas                  (a compositing layer)
  A keyword_captions   motion, canvas                   (kinetic type)
  F end_cards          palette, canvas                  (held frame — NOT motion)
  D name_plate         palette, canvas                  (held overlay — NOT motion)
  landscape_canvas     canvas ONLY                      (a format, not content)
  full_edit            ALL                              (the only whole-video case)

TASTE DIMENSIONS REMAIN [UNCALIBRATED] pending the owner's blind sheet: scene
presence at claims/numbers, caption-mode correctness, brand/end-card presence.
They are listed on every scorecard as explicitly unscored so their absence is
visible rather than silently omitted.

Usage:
  python3 score_component.py <component> <artifact.mp4> [--json out.json]
  python3 score_component.py --list
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lumen_video_dimensions import (  # noqa: E402
    canvas, audio_master, hard_cuts, motion_rhythm, palette,
    MOTION_DENSITY_TARGET_EVPS, STILL_GAP_CEILING_S,
    AUDIO_MEAN_FLOOR_DB, AUDIO_MEAN_CEIL_DB, AUDIO_PEAK_CEIL_DB,
)

# Reference values, measured — the bar every component is scored against.
REFS = {
    "ref1": {"w": 1080, "h": 608, "fps": 30.0, "audio_mean": -15.8,
             "evps": 3.54, "still_gap": 1.75, "u_spread": 10.84, "v_spread": 7.62},
    "ref2": {"w": 720, "h": 1280, "fps": 30.0, "audio_mean": -15.7,
             "evps": 3.51, "still_gap": 3.25, "u_spread": 5.26, "v_spread": 4.34},
}

APPLIES = {
    "insert_scenes":    {"canvas", "motion", "palette"},
    "music_bed":        {"audio"},
    "text_behind":      {"canvas", "palette"},
    "keyword_captions": {"canvas", "motion"},
    "end_cards":        {"canvas", "palette"},
    "name_plate":       {"canvas", "palette"},
    "landscape_canvas": {"canvas"},
    "full_edit":        {"canvas", "motion", "palette", "audio"},
}

TASTE_UNCALIBRATED = [
    "scene presence at claims/numbers",
    "caption-mode correctness (keyword emphasis, number glorification)",
    "brand / end-card presence",
]


def score(component, path):
    if component not in APPLIES:
        raise SystemExit(f"unknown component '{component}'. Known: {', '.join(sorted(APPLIES))}")
    ap = APPLIES[component]
    out = {"component": component, "artifact": os.path.basename(path),
           "applies": sorted(ap), "dimensions": {}, "na": [], "checks": []}

    c = canvas(path)
    out["canvas"] = c
    if "canvas" in ap:
        # Format must MATCH one of the references, not merely be valid.
        match = None
        for k, r in REFS.items():
            if c["w"] == r["w"] and c["h"] == r["h"]:
                match = k
        out["dimensions"]["canvas"] = {"w": c["w"], "h": c["h"], "fps": c["fps"], "matches_ref": match}
        out["checks"].append((f"canvas matches a reference format ({match or 'NONE'})", match is not None))
        out["checks"].append(("fps == 30", abs((c["fps"] or 0) - 30.0) < 0.5))
    else:
        out["na"].append("canvas")

    if "audio" in ap:
        a = audio_master(path)
        out["dimensions"]["audio"] = a
        m = a.get("mean_db")
        out["checks"].append(("audio present (not silent)", m is not None and m >= AUDIO_MEAN_FLOOR_DB))
        out["checks"].append(("audio not hot", m is not None and m <= AUDIO_MEAN_CEIL_DB))
        out["checks"].append(("no clipping", (a.get("peak_db") or 0) <= AUDIO_PEAK_CEIL_DB))
    else:
        out["na"].append("audio")

    if "motion" in ap:
        r = motion_rhythm(path)
        h = hard_cuts(path)
        out["dimensions"]["motion"] = {**r, "n_cuts": h["n_cuts"]}
        gap = r.get("max_still_gap_s")
        out["checks"].append((f"stillness <= {STILL_GAP_CEILING_S}s (CEILING)",
                              gap is not None and gap <= STILL_GAP_CEILING_S))
        # density is a TARGET, not a ceiling — scored as a band around the refs
        ev = r.get("events_per_s") or 0
        out["checks"].append((f"motion density >= 0.6x reference ({MOTION_DENSITY_TARGET_EVPS}/s)",
                              ev >= 0.6 * MOTION_DENSITY_TARGET_EVPS))
    else:
        out["na"].append("motion")

    if "palette" in ap:
        p = palette(path)
        out["dimensions"]["palette"] = p
        # Consistency only. Bar = no worse than the LOOSER reference (ref1).
        us, vs = p.get("u_spread"), p.get("v_spread")
        out["checks"].append(("palette consistency within reference spread",
                              us is not None and us <= REFS["ref1"]["u_spread"] * 1.25
                              and vs <= REFS["ref1"]["v_spread"] * 1.25))
    else:
        out["na"].append("palette")
    return out


def report(o):
    print(f"\n=== COMPONENT SCORECARD — {o['component']} · {o['artifact']} ===")
    print(f"  applies: {', '.join(o['applies'])}")
    if o["na"]:
        print(f"  N/A (not scored, NOT a pass): {', '.join(o['na'])}")
    for k, v in o["dimensions"].items():
        print(f"  [{k}] {json.dumps(v, default=str)[:150]}")
    print()
    failed = 0
    for name, ok in o["checks"]:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
        if not ok:
            failed += 1
    print(f"\n  {len(o['checks']) - failed}/{len(o['checks'])} applicable checks passed")
    print("  [UNCALIBRATED — pending the owner's blind sheet, NOT scored here]:")
    for t in TASTE_UNCALIBRATED:
        print(f"    · {t}")
    return failed


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] == "--list":
        print("components:", ", ".join(sorted(APPLIES)))
        print("\nreference bars:", json.dumps(REFS, indent=1))
        sys.exit(0)
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    o = score(sys.argv[1], sys.argv[2])
    f = report(o)
    if "--json" in sys.argv:
        dest = sys.argv[sys.argv.index("--json") + 1]
        with open(dest, "w") as fh:
            json.dump(o, fh, indent=1, default=str)
        print(f"\nwrote {dest}")
    sys.exit(1 if f else 0)
