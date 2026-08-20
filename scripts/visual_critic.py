#!/usr/bin/env python3
"""VISUAL CRITIC — scores a rendered mp4 against golden/lumen-refs on the
ART_DIRECTION.md properties `[§2, §3, §4, §7]`.

**AN AID TO THE OWNER'S EYE, NOT A REPLACEMENT.** Every property here is a
pixel proxy for something the owner judges directly and better. It exists to
catch the defects that are objectively checkable BEFORE they reach him, so his
attention goes to the taste calls only he can make. A green critic is not a good
edit; a red critic is a specific, reproducible complaint.

FRAME SAMPLING lifted from the `watch` skill's approach (ffmpeg fps-sampling with
a frame cap) rather than re-inventing it.

WHAT IT SCORES, and the honesty of each:

  palette_hold      [OBJECTIVE]  §4 wants flat near-white #FEFCFD on scene cards
                                 and a per-job accent that HOLDS across the edit.
                                 Measured as chroma spread across sampled frames.
  caption_band      [PROXY]      §2.1 puts type at ~53% of frame height, centre-
                                 band, NOT lower third. Measured as the vertical
                                 centroid of text-like edge density.
  DOUBLE CAPTIONS   [BROKEN — DO NOT USE AS A DEFECT DETECTOR]
                                 Calibration REFUTED this property as I designed
                                 it. I built it for §3's hard prohibition ("never
                                 double the captions"), expecting the references
                                 to show ~0 simultaneous text bands. They show
                                 3.3% (REF-1) and 16.3% (REF-2). The references
                                 are the bar, so the PROPERTY is broken, not them
                                 — and §4 says why: an insert scene has "3 depth
                                 planes: background type -> photo -> foreground
                                 type". LAYERED TYPE IS THE DESIGNED LOOK. Edge
                                 density cannot tell designed layering (§4,
                                 correct) from stacked captions over burned-in
                                 source text (§3, the defect). Reported as an
                                 observation against the reference range, never
                                 as a pass/fail. The real §3 check is the
                                 planner's `source_text_regions.text_bands`
                                 field, which already exists and already works.
  motion_on_beat    [PROXY]      §5 rhythm — visual change should coincide with
                                 audio onsets, not drift free of them.

WHAT IT CANNOT SCORE, stated so absence is never read as a pass:
  type system consistency (needs glyph metrics, not edges) · component overlap
  (needs the render tree) · caption-vs-subject placement (needs the subject mask,
  component C, unmerged) · legibility shadow/outline (needs the text alpha).
  These stay the owner's eye and are printed as NOT SCORED on every run.

Usage:
  python3 visual_critic.py --references          # calibration; run this FIRST
  python3 visual_critic.py <video.mp4>
"""
import json, os, re, subprocess, sys

FF = os.environ.get("FFMPEG_PATH", "ffmpeg")
REFS = "/Users/zaclibman/promptly-gpu-worker/promptly-gpu-worker/golden/lumen-refs"


def _sh(cmd, timeout=600):
    return subprocess.run(["sh", "-c", cmd], capture_output=True, text=True, timeout=timeout).stdout


def _meta(p):
    o = _sh(f'ffprobe -v error -select_streams v:0 -show_entries stream=width,height '
            f'-show_entries format=duration -of json "{p}" 2>&1')
    j = json.loads(o)
    st = (j.get("streams") or [{}])[0]
    return int(st.get("width") or 0), int(st.get("height") or 0), float((j.get("format") or {}).get("duration") or 0)


def band_edges(p, y0, y1, hz=2, cap=90):
    """Edge density in a horizontal band — text is high-frequency, so this tracks
    where type lives. Same method the caption-placement dimension was calibrated
    with, and it carries the same limit: it sees ALL edges, not only glyphs."""
    o = _sh(f'{FF} -hide_banner -i "{p}" -vf '
            f'"crop=iw:ih*{y1-y0}:0:ih*{y0},fps={hz},scale=320:-2,'
            f'edgedetect=low=0.25:high=0.4,signalstats,'
            f'metadata=print:key=lavfi.signalstats.YAVG" -frames:v {cap} -an -f null - 2>&1')
    return [float(x) for x in re.findall(r"YAVG=([\d.]+)", o)]


def palette_hold(p, n=24):
    w, h, dur = _meta(p)
    us, vs = [], []
    for i in range(n):
        t = max(0.0, dur * (i + 0.5) / n)
        o = _sh(f'{FF} -hide_banner -ss {t:.2f} -i "{p}" -frames:v 1 '
                f'-vf "scale=64:-2,format=yuv444p,signalstats,metadata=print" -an -f null - 2>&1')
        u = re.search(r"UAVG=([\d.]+)", o)
        v = re.search(r"VAVG=([\d.]+)", o)
        if u and v:
            us.append(float(u.group(1))); vs.append(float(v.group(1)))
    if not us:
        return None
    sd = lambda xs: (sum((x - sum(xs)/len(xs))**2 for x in xs)/len(xs)) ** 0.5
    return {"u_mean": round(sum(us)/len(us), 1), "v_mean": round(sum(vs)/len(vs), 1),
            "u_spread": round(sd(us), 2), "v_spread": round(sd(vs), 2), "n": len(us)}


def caption_geometry(p):
    """Vertical centroid of text-like energy + simultaneous-band detection."""
    bands = [(i/10, (i+1)/10) for i in range(10)]
    series = [band_edges(p, a, b) for a, b in bands]
    n = min((len(s) for s in series if s), default=0)
    if not n:
        return None
    centroids, doubles = [], 0
    for f in range(n):
        col = [series[b][f] if f < len(series[b]) else 0.0 for b in range(10)]
        tot = sum(col) or 1.0
        centroids.append(sum((b + 0.5) / 10 * col[b] for b in range(10)) / tot)
        # DOUBLE-BAND: two separated bands each carrying >18% of the frame's edge
        # energy, with a quiet band between them — the §3 stacked-caption shape.
        hot = [b for b in range(10) if col[b] / tot > 0.18]
        if len(hot) >= 2 and (max(hot) - min(hot)) >= 3:
            doubles += 1
    return {"frames": n, "centroid_pct": round(100 * sum(centroids)/len(centroids), 1),
            "double_band_frames": doubles, "double_band_pct": round(100*doubles/n, 1)}


def motion_on_beat(p):
    """Fraction of audio onsets with visual change nearby. PROXY: correlation,
    not causation, and silent or music-free audio makes it meaningless."""
    o = _sh(f'{FF} -hide_banner -i "{p}" -af "silencedetect=noise=-30dB:d=0.15" -f null - 2>&1')
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", o)]
    if len(ends) < 4:
        return {"onsets": len(ends), "note": "too few audio onsets to judge"}
    v = _sh(f'{FF} -hide_banner -i "{p}" -vf "fps=8,scale=160:-2,tblend=all_mode=difference,'
            f'signalstats,metadata=print:key=lavfi.signalstats.YAVG" -frames:v 400 -an -f null - 2>&1')
    ch = [float(x) for x in re.findall(r"YAVG=([\d.]+)", v)]
    if not ch:
        return {"onsets": len(ends), "note": "no video samples"}
    thr = sorted(ch)[int(0.75 * len(ch))]
    moves = {round(i / 8, 1) for i, c in enumerate(ch) if c >= thr}
    hit = sum(1 for e in ends if any(abs(e - m) <= 0.35 for m in moves))
    return {"onsets": len(ends), "on_beat": hit, "on_beat_pct": round(100 * hit / len(ends), 1)}


# ── CAPTION-VS-SUBJECT: SELF-ACTIVATING ON COMPONENT C ──────────────────────
# §2.2's real rule is RELATIONAL — "captions are placed in negative space,
# OPPOSITE the subject", not at a fixed anchor. It is the property that would
# have caught REF-1's actual rule before I got it wrong: I measured for a
# lower-third and found none, concluded the reference had no signature, and had
# to withdraw the whole framing. A positional test could never have found a
# relational rule.
#
# It needs a subject mask. Component C (behind-layer-phase1, matting/matting_app)
# is built and unmerged. Rather than wait to be told, this checks for the mask on
# every run and moves the property from NOT-SCORED to SCORED the moment it lands.
MATTING_PATHS = [
    "/Users/zaclibman/promptly-gpu-worker/promptly-gpu-worker/matting/matting_app.py",
    "/Users/zaclibman/promptly-gpu-worker/promptly-gpu-worker/src/remotion/src/BehindSpecimen.tsx",
]


def subject_mask_available():
    return [p for p in MATTING_PATHS if os.path.exists(p)]


_BASE_NOT_SCORED = [
    "type system consistency (needs glyph metrics, not edge density)",
    "component overlap (needs the render tree, not pixels)",
    "legibility shadow/outline (needs the text alpha layer)",
]

_MASK = subject_mask_available()
NOT_SCORED = _BASE_NOT_SCORED + ([] if _MASK else [
    "caption-vs-subject placement (§2.2, the RELATIONAL rule) — BLOCKED on the "
    "subject mask from component C (behind-layer-phase1, unmerged). This is the "
    "property that would have caught REF-1's real rule before I got it wrong."])


def critique(p):
    w, h, dur = _meta(p)
    return {"file": os.path.basename(p), "w": w, "h": h, "duration_s": round(dur, 1),
            "palette": palette_hold(p), "caption": caption_geometry(p), "beat": motion_on_beat(p)}


def show(r, bars=None):
    print(f"\n=== VISUAL CRITIC — {r['file']} ({r['w']}x{r['h']}, {r['duration_s']}s) ===")
    print(f"  palette   {json.dumps(r['palette'])}")
    print(f"  caption   {json.dumps(r['caption'])}")
    print(f"  beat      {json.dumps(r['beat'])}")
    if bars:
        print()
        for name, ok, detail in bars(r):
            print(f"  {'PASS' if ok else 'FAIL'}  {name}  ({detail})")
    print("\n  NOT SCORED — the owner's eye, and absence here is never a pass:")
    for x in NOT_SCORED:
        print(f"    · {x}")
    if _MASK:
        print("\n  ✅ SUBJECT MASK DETECTED (component C merged) — caption-vs-subject placement")
        print(f"     is now UNBLOCKED. Calibrate it on BOTH references before it judges anything:")
        print(f"     mask source: {_MASK[0]}")
        print("     bar: caption-bbox vs subject-mask IoU == 0 on >=95% of caption frames,")
        print("     derived from the references FIRST, per the canon rule.")


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        print(__doc__); sys.exit(0)
    if a[0] == "--references":
        print("CALIBRATION RUN — the references define every bar below.")
        print("A property the references fail is a BROKEN PROPERTY, not a broken reference.\n")
        out = []
        for f in ("ref1-legalsoft-corporate-landscape.mp4", "ref2-viral-creator-doc-vertical.mp4"):
            r = critique(os.path.join(REFS, f))
            show(r); out.append(r)
        print("\n\n=== DERIVED BARS (from the references, for use on our output) ===")
        cs = [r["caption"]["centroid_pct"] for r in out if r["caption"]]
        db = [r["caption"]["double_band_pct"] for r in out if r["caption"]]
        us = [r["palette"]["u_spread"] for r in out if r["palette"]]
        vs = [r["palette"]["v_spread"] for r in out if r["palette"]]
        print(f"  caption centroid       refs {cs}  -> ART_DIRECTION says ~53%")
        print(f"  DOUBLE-BAND frames     refs {db}%  <- the §3 bar: our output must not exceed the refs")
        print(f"  palette spread u/v     refs u{us} v{vs}")
        bm = [r["beat"].get("on_beat_pct") for r in out if r["beat"].get("on_beat_pct") is not None]
        print(f"  motion-on-beat         refs {bm}%")
        json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out",
                                         "visual_critic_refs.json"), "w"), indent=1)
        sys.exit(0)
    show(critique(a[0]))
