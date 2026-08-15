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
supposed to do. So each component has a declared applicability, and every other
dimension is reported N/A rather than scored. **An N/A is not a pass and must
never be counted as one.**

THE MAP IS JUDGE-OWNED (owner ruling 2026-08-15). A component supplies ONE fact
— WHICH component it is. It does NOT declare which dimensions apply to it: a
subject that writes its own exemptions can always exempt the dimension it fails,
and from outside, the exemption and the defect are indistinguishable. An
externally-supplied applicability set is REFUSED, not merged. The map below is
derived from the build sheet's descriptions, never from what a component turns
out to score well on:

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

# ── THE APPLICABILITY MAP IS JUDGE-OWNED. COMPONENTS DO NOT DECLARE THEIR OWN. ──
# (owner ruling 2026-08-15)
#
# A component that declares which dimensions apply to it can exempt itself from
# the dimension it fails, and it will always be able to justify doing so —
# "a name-plate isn't really about motion" is indistinguishable, from the
# outside, from "our name-plate fails the motion bar." The exemption and the
# defect look identical the moment the subject writes the rule.
#
# So: a component under test supplies ONE fact — WHICH component it is. This map
# supplies what that means. It lives in JUDGE's lane, changes only by JUDGE's
# measurement, and a scorecard run against an externally-supplied applicability
# set is REFUSED, not merged (see assert_judge_owned below).
#
# Each entry is justified from the build sheet's own description of the
# component, not from what the component turns out to score well on.
APPLIES = {
    "insert_scenes":    {"canvas", "motion", "palette"},
    "music_bed":        {"audio"},
    "text_behind":      {"canvas", "palette"},
    "keyword_captions": {"canvas", "motion", "caption_placement"},
    "end_cards":        {"canvas", "palette"},
    "name_plate":       {"canvas", "palette"},
    "landscape_canvas": {"canvas"},
    "full_edit":        {"canvas", "motion", "palette", "audio"},
}

# ── CAPTION PLACEMENT — PARTIALLY calibrated 2026-08-15 ──────────────────────
# The owner named two signatures: REF-1 lower-third keyword accents, REF-2
# centre-frame hero numbers. I measured both references by two independent
# methods before scoring anything.
#
#   method 1, band temporal-change energy (4Hz frame-difference per third):
#       REF-1  upper 29.8 / middle 34.8 / LOWER 35.4   -> lower by 0.6pt = a TIE
#       REF-2  upper 19.6 / MIDDLE 43.7 / lower 36.7   -> middle by 7.0pt
#   method 2, edge density (edgedetect per third — text-isolating):
#       REF-1  upper 28.7 / MIDDLE 38.0 / lower 33.4   -> MIDDLE by 4.6pt
#       REF-2  upper 12.1 / MIDDLE 65.5 / lower 22.4   -> middle by 43.1pt
#
# REF-2's centre-frame signature is CONFIRMED and strong (43.1pt separation,
# same direction under both methods). REF-1's lower-third signature is NOT: one
# method calls it a 0.6pt tie, the other puts the dominant band at MIDDLE. Two
# readings, neither supporting the claim.
#
# I cannot separate "REF-1 has no lower-third dominance" from "whole-frame band
# methods cannot isolate a lower-third caption from a landscape composition
# whose speaker and b-roll fill the middle." Both are live explanations, so the
# REF-1 bar is UNCONFIRMED and must not be scored. Scoring it would grade our
# captions against a bar I could not reproduce from the reference itself.
CAPTION_PLACEMENT = {
    "ref2_centre_frame_numbers": {"band": "middle", "confirmed": True,
                                  "separation_pt": 43.1, "methods_agreeing": 2},
    "ref1_lower_third_accents": {"band": "lower", "confirmed": False,
                                 "note": "2 methods, neither confirms; m1 tie 0.6pt, m2 says middle"},
}

TASTE_UNCALIBRATED = [
    "scene presence at claims/numbers",
    "caption-mode: KEYWORD CHOICE (which word is emphasised) — taste, needs the blind sheet",
    "brand / end-card presence",
]

# Measurable-but-unconfirmed, listed apart from taste so the two are never conflated:
PLACEMENT_UNCONFIRMED = [
    "REF-1 lower-third keyword accent placement — measurable in principle, "
    "NOT reproducible from the reference by either method tried; needs a text-mask "
    "(caption bounding boxes from our own recipe) before it can be a bar",
]


def assert_judge_owned(supplied=None):
    """Refuse any externally-supplied applicability. The subject of a measurement
    does not get to define the measurement. Callers pass a component NAME; if a
    caller tries to pass a dimension set, that is a scope negotiation and the run
    is refused rather than silently honoured."""
    if supplied is not None:
        raise SystemExit(
            "REFUSED: applicability was supplied by the caller. The map is JUDGE-owned "
            "(scripts/score_component.py). A component declares WHICH component it is; "
            "it does not declare which dimensions apply to it. If a dimension genuinely "
            "does not apply, that is a measured argument to bring to JUDGE, not a flag "
            "to pass at score time.")


def score(component, path, applies_override=None):
    assert_judge_owned(applies_override)
    if component not in APPLIES:
        raise SystemExit(f"unknown component '{component}'. Known: {', '.join(sorted(APPLIES))}")
    ap = APPLIES[component]
    # A declared N/A is checked against the ARTIFACT where the artifact can speak.
    # 'audio does not apply' is a claim the file can refute: if a component whose
    # map says no-audio ships WITH an audio stream, the map is stale or the
    # component changed shape, and either way the scorecard must say so.
    probe_a = audio_master(path)
    if "audio" not in ap and probe_a.get("mean_db") is not None and probe_a["mean_db"] > -60:
        print(f"  ⚠️  MAP-DRIFT: '{component}' is mapped audio-N/A but this artifact HAS audible audio "
              f"({probe_a['mean_db']}dB). The map may be stale — JUDGE re-derives it before this scores.")
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

    if "caption_placement" in ap:
        # ONLY the confirmed bar is scored: REF-2 centre-frame concentration.
        import subprocess as _sp, re as _re
        def _edge(y0, y1):
            cmd = (f'ffmpeg -hide_banner -i "{path}" -vf '
                   f'"crop=iw:ih*{y1 - y0}:0:ih*{y0},fps=2,scale=320:-2,'
                   f'edgedetect=low=0.25:high=0.4,signalstats,'
                   f'metadata=print:key=lavfi.signalstats.YAVG" -frames:v 120 -an -f null - 2>&1')
            o = _sp.run(["sh", "-c", cmd], capture_output=True, text=True).stdout
            v = [float(x) for x in _re.findall(r"YAVG=([\d.]+)", o)]
            return sum(v) / len(v) if v else 0.0
        u, m, l = _edge(0, .33), _edge(.33, .66), _edge(.66, 1.0)
        tot = (u + m + l) or 1
        out["dimensions"]["caption_placement"] = {
            "upper_pct": round(100 * u / tot, 1), "middle_pct": round(100 * m / tot, 1),
            "lower_pct": round(100 * l / tot, 1)}
        if c["h"] > c["w"]:   # vertical -> REF-2's confirmed centre-frame bar applies
            out["checks"].append(("hero numbers centre-frame (REF-2 confirmed bar: middle dominant)",
                                  m >= u and m >= l))
        else:
            out["na"].append("caption_placement (landscape: REF-1 bar UNCONFIRMED, not scored)")

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
    print("  [UNCALIBRATED — taste, pending the owner's blind sheet, NOT scored]:")
    for t in TASTE_UNCALIBRATED:
        print(f"    · {t}")
    print("  [MEASURABLE BUT UNCONFIRMED — not taste; the bar itself is unreproduced]:")
    for t in PLACEMENT_UNCONFIRMED:
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
