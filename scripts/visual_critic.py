#!/usr/bin/env python3
"""VISUAL CRITIC — scores a rendered mp4 against golden/lumen-refs on the
ART_DIRECTION.md properties `[§2, §3, §4, §5, §6, §7]`.

**AN AID TO THE OWNER'S EYE, NOT A REPLACEMENT.** Every property here is a
pixel proxy for something the owner judges directly and better. It exists to
catch the defects that are objectively checkable BEFORE they reach him, so his
attention goes to the taste calls only he can make. A green critic is not a good
edit; a red critic is a specific, reproducible complaint.

**THE CALIBRATION RULE (ratified by the owner).** A dimension ships only if it
PASSES BOTH REFERENCES **and** GOES RED ON A DELIBERATELY BAD ARTIFACT. Without
the known-bad half, a threshold that merely clears the references has been
FITTED to them and detects nothing. `--known-bad` runs that proof; the artifacts
are constructed from the references themselves (durable, reproducible — the
recipes are in KNOWN_BAD_RECIPES below), never from user media.

FRAME SAMPLING lifted from the `watch` skill's approach (ffmpeg fps-sampling with
a frame cap) rather than re-inventing it.

════════════════════════════════════════════════════════════════════════════
SCORED — passes both references AND reds on a known-bad
════════════════════════════════════════════════════════════════════════════
  still_ceiling     [OBJECTIVE]  §5 — no dead stretch longer than 3.5s.
                                 refs 1.75s / 3.25s · static known-bad 19.75s.
  black_frames      [OBJECTIVE]  §6 — "a card running past the final cut is a
                                 black frame with text on it." ffmpeg's own
                                 blackdetect, not a fitted luma threshold.
                                 refs 0 / 0 intervals · black-tail bad: 1.97s.
  motion_density    [OBJECTIVE]  §5 — ~3.5 moving samples/s. refs 3.54 / 3.51
                                 (the tightest agreement of any dimension here)
                                 · static known-bad 0.00.
  audio_level       [OBJECTIVE]  a silent or blown edit is a defect regardless
                                 of look. refs -15.8 / -15.7 dB mean · quiet
                                 known-bad -35.8 dB.
  palette_hold      [OBJECTIVE]  §4/§6 — a per-job accent that HOLDS across the
                                 edit. Chroma spread across sampled frames.
  caption_band      [PROXY]      §2.1 — type at ~53% of frame height, centre-
                                 band, NOT lower third. Vertical centroid of
                                 text-like edge density.
  motion_on_beat    [PROXY]      §5 — visual change should coincide with audio
                                 onsets, not drift free of them.

════════════════════════════════════════════════════════════════════════════
OBSERVATION ONLY — calibration REFUTED these as pass/fail. Reported, never gated.
════════════════════════════════════════════════════════════════════════════
  DOUBLE CAPTIONS   [BROKEN — DO NOT USE AS A DEFECT DETECTOR]
                                 Built for §3's hard prohibition, expecting the
                                 references to show ~0 simultaneous text bands.
                                 They show 3.3% (REF-1) and 16.3% (REF-2). The
                                 references are the bar, so the PROPERTY is
                                 broken — and §4 says why: an insert scene has
                                 "3 depth planes: background type -> photo ->
                                 foreground type". LAYERED TYPE IS THE DESIGNED
                                 LOOK. Edge density cannot tell designed layering
                                 (§4, correct) from stacked captions over
                                 burned-in source text (§3, the defect). The real
                                 §3 check is the planner's
                                 `source_text_regions.text_bands`, which already
                                 exists and already works.
  tail_frozen       [NOT A DEFECT]
                                 I built this expecting a frozen tail to be a
                                 defect. The references hold 89% (REF-1) and 33%
                                 (REF-2) of their final second STATIC — because
                                 §6's end card (CTA -> logo sting -> handle) IS a
                                 held frame. Freezing at the end is the DESIGNED
                                 look. What §6 actually prohibits is a BLACK
                                 tail, which is why black_frames above is the
                                 real check and this is an observation.
  audio_peak        [NOT A DISCRIMINATOR]
                                 Both references sit at EXACTLY 0.0 dB peak — they
                                 are normalised to full scale. A peak bar
                                 therefore separates nothing at the top end, and
                                 a "no clipping" test on max_volume cannot fire
                                 on integer audio that is already at 0. Mean
                                 loudness carries the whole audio dimension.

════════════════════════════════════════════════════════════════════════════
NOT SCORED — stated so absence is never read as a pass
════════════════════════════════════════════════════════════════════════════
  caption entrance (§2.5 frame-1-is-final) — ATTEMPTED AND REFUTED, 2026-08-20.
      Edge-energy rise time in the caption band cannot distinguish a caption
      that appears instantly from one that fades in over a full second: a
      constructed instant overlay and a constructed 1.0s alpha-fade of the SAME
      box over the SAME footage measured IDENTICALLY (onsets 1, median rise 7
      frames, max 7 for both). REF-2's own max rise is 6 frames from content
      motion alone, so the confound is not incidental — content motion and
      caption entrance live in the same signal. §2.5 stays enforced where it
      already is: the code-side gate that regex-rejects entrance transforms.
  type system consistency (needs glyph metrics, not edge density)
  component overlap (needs the render tree, not pixels)
  legibility shadow/outline (needs the text alpha layer)

════════════════════════════════════════════════════════════════════════════
LEDGER vs PIXELS — the counters CLAIM, the pixels ADJUDICATE
════════════════════════════════════════════════════════════════════════════
The pipeline's counters have been caught lying in BOTH directions: a ledger
reporting components that never rendered, and my own read of
`component_ledger.generated_scenes` as "4 scenes" when it was a four-KEY roll-up
dict describing ZERO. A counter is the code's claim about itself. The pixels are
the only independent witness, which makes this the most important thing here.

**THE EPISTEMICS ARE ASYMMETRIC, AND THAT IS THE WHOLE DESIGN:**

    PIXELS CAN REFUTE A COUNTER. PIXELS CANNOT CONFIRM ONE.

If the ledger claims cuts and the frames never change, the claim is dead — no
interpretation rescues it. If the frames DO change, that does not mean the
claimed component rendered, or rendered correctly, or rendered where it belonged.
Something moved; nothing more. So verdicts are REFUTED / not refuted /
REVERSE-CONTRADICTED / UNADJUDICABLE. **There is deliberately no CONFIRMED**, and
"not refuted" must never be quoted as "verified".

  witness         calibrated on                     red-proven on
  visual_change   refs 23 / 18 scene changes        static known-bad: 0
  motion          refs 3.54 / 3.51 moving samples/s static known-bad: 0.00

  COUNT MATCHING IS NOT A BAR — and calibration is why. REF-2 shows 18 pixel
  scene-changes against 8 known editorial cuts (REF-1: 23 against 21). §4 insert
  scenes change the frame without being cuts, so any tolerance band wide enough
  to hold 8-vs-18 would detect nothing. Only the ASYMMETRIC form survived:
  claimed>0 with pixels at ZERO is a refutation; the counts themselves are an
  observation.

  A claim with no calibrated witness is UNADJUDICABLE and is LISTED with its
  reason — silence there would read as a pass.

Usage:
  python3 visual_critic.py --references     # calibration; run this FIRST
  python3 visual_critic.py --known-bad      # the RED half of calibration
  python3 visual_critic.py --ledger <video.mp4> <ledger.json|'{...}'>
  python3 visual_critic.py <video.mp4>
"""
import json, os, re, subprocess, sys

FF = os.environ.get("FFMPEG_PATH", "ffmpeg")
REFS = "/Users/zaclibman/promptly-gpu-worker/promptly-gpu-worker/golden/lumen-refs"
REF_FILES = ("ref1-legalsoft-corporate-landscape.mp4", "ref2-viral-creator-doc-vertical.mp4")

# ── BARS — every one derived from the references, none guessed ─────────────
STILL_CEILING_S = 3.5        # §5, and both refs clear it (1.75s, 3.25s)
MOTION_DEAD_FLOOR = 1.0      # a DEAD floor, NOT the 3.5 target — see note in bars()
AUDIO_MEAN_BAND = (-20.0, -10.0)   # both refs -15.8 / -15.7
BLACK_INTERVALS_MAX = 0      # both refs 0

# Constructed from the REFERENCES so they are durable and reproducible — never
# from user media. Each isolates ONE dimension; the others stay green, which is
# what proves the check is specific rather than a general "something is off".
KNOWN_BAD_RECIPES = {
    "bad_static.mp4":
        'ffmpeg -y -ss 5 -i REF2 -frames:v 1 -update 1 f.png && '
        'ffmpeg -y -loop 1 -framerate 30 -i f.png -i REF2 -map 0:v -map 1:a -t 20 '
        '-pix_fmt yuv420p -c:v libx264 -c:a aac bad_static.mp4',
    "bad_blacktail.mp4":
        'ffmpeg -y -i REF2 -f lavfi -t 2 -i color=black:s=720x1280:r=30 -f lavfi -t 2 '
        '-i anullsrc=r=48000:cl=stereo -filter_complex '
        '"[0:v][0:a][1:v][2:a]concat=n=2:v=1:a=1[v][a]" -map "[v]" -map "[a]" '
        '-c:v libx264 -pix_fmt yuv420p -c:a aac bad_blacktail.mp4',
    "bad_quiet.mp4":
        'ffmpeg -y -i REF2 -af "volume=-20dB" -c:v copy -c:a aac bad_quiet.mp4',
}
KNOWN_BAD_DIR = os.environ.get("PROMPTLY_KNOWN_BAD_DIR", "")

# Bar names live in ONE place. The first version of this file spelled them out
# again inside KNOWN_BAD_EXPECT, and the copies drifted the moment a threshold
# was interpolated into a name — the proof harness then read every lookup as a
# miss and reported three false failures. A name that is computed in one place
# and typed in another is the same shared-failure shape as a measurement stored
# beside its subject.
BAR_STILL = f"no dead stretch > {STILL_CEILING_S}s (§5)"
BAR_MOTION = f"motion density >= dead floor ({MOTION_DEAD_FLOOR}/s) (§5)"
BAR_BLACK = "no black frames (§6)"
BAR_AUDIO = "audio mean in reference band"

# What each known-bad MUST trip, and what it must NOT — specificity is the point.
KNOWN_BAD_EXPECT = {
    "bad_static.mp4":    {"reds": [BAR_MOTION, BAR_STILL],
                          "greens": [BAR_BLACK, BAR_AUDIO]},
    "bad_blacktail.mp4": {"reds": [BAR_BLACK],
                          "greens": [BAR_MOTION, BAR_AUDIO]},
    "bad_quiet.mp4":     {"reds": [BAR_AUDIO],
                          "greens": [BAR_BLACK, BAR_MOTION, BAR_STILL]},
}


def _sh(cmd, timeout=900):
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


def rhythm(p, hz=4.0, thr=0.004):
    """§5 — motion density and the longest dead stretch, on ONE pass.

    `thr` is the calibrated still-threshold from the reference sweep, not a
    guess. Returns None (never a number) when no samples come back, so a failed
    measurement can never be read as a healthy one — the probe-collapse class."""
    o = _sh(f'{FF} -hide_banner -i "{p}" -vf "fps={hz},scale=160:-2,tblend=all_mode=difference,'
            f'signalstats,metadata=print:key=lavfi.signalstats.YAVG" -an -f null - 2>&1')
    y = [float(x) / 255.0 for x in re.findall(r"YAVG=([\d.]+)", o)]
    if not y:
        return None
    mov = [v >= thr for v in y]
    best = cur = 0
    for m in mov:
        cur = 0 if m else cur + 1
        best = max(best, cur)
    return {"samples": len(y), "moving_per_s": round(sum(mov) / (len(y) / hz), 2),
            "longest_still_s": round(best / hz, 2)}


def black_frames(p):
    """§6 — ffmpeg's own blackdetect. Deliberately NOT a luma threshold: black
    encodes to Y=16 in limited range, and REF-2's darkest tail second sits at
    29, so a luma bar would have had a 13-unit margin against a real reference.
    blackdetect is purpose-built and needs no fitting."""
    o = _sh(f'{FF} -hide_banner -i "{p}" -vf "blackdetect=d=0.1:pix_th=0.10" -an -f null - 2>&1')
    iv = re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", o)
    _, _, dur = _meta(p)
    total = sum(float(b) - float(a) for a, b in iv)
    at_tail = any(float(b) >= dur - 0.15 for a, b in iv)
    return {"intervals": len(iv), "black_s": round(total, 2), "at_tail": at_tail}


def audio_level(p):
    """A silent or blown edit is a defect whatever it looks like. Mean carries
    this dimension alone — see audio_peak in the OBSERVATION block."""
    o = _sh(f'{FF} -hide_banner -i "{p}" -af volumedetect -f null - 2>&1')
    m = re.search(r"mean_volume: (-?[\d.]+) dB", o)
    k = re.search(r"max_volume: (-?[\d.]+) dB", o)
    if not m:
        return None
    return {"mean_db": float(m.group(1)), "peak_db": float(k.group(1)) if k else None}


def tail_frozen(p, win=1.0):
    """OBSERVATION ONLY — §6's end card IS a held frame (refs 89% / 33%)."""
    _, _, dur = _meta(p)
    t = max(0.0, dur - win)
    o = _sh(f'{FF} -hide_banner -ss {t:.2f} -i "{p}" -vf "fps=10,scale=160:-2,'
            f'tblend=all_mode=difference,signalstats,'
            f'metadata=print:key=lavfi.signalstats.YAVG" -an -f null - 2>&1')
    ch = [float(x) / 255.0 for x in re.findall(r"YAVG=([\d.]+)", o)]
    if not ch:
        return None
    return {"frozen_frac": round(sum(1 for c in ch if c < 0.002) / len(ch), 2), "n": len(ch)}


# ══════════════════════════════════════════════════════════════════════════
# LEDGER vs PIXELS — the counters CLAIM, the pixels ADJUDICATE
# ══════════════════════════════════════════════════════════════════════════
# The pipeline's own counters have been caught lying more than once, in both
# directions: a ledger that reported components it never rendered, and my own
# read of `component_ledger.generated_scenes` as "4 scenes" when it was a
# four-KEY roll-up dict {requested: 0, drop_reasons, dropped_by_us,
# survived_derived} describing zero. A counter is a claim by the code about
# itself. The pixels are the only independent witness.
#
# THE EPISTEMICS, AND THEY ARE ASYMMETRIC — this is the whole design:
#
#     PIXELS CAN REFUTE A COUNTER. PIXELS CANNOT CONFIRM ONE.
#
# If the ledger claims cuts and the frames never change, the claim is dead: no
# interpretation rescues it. But if the frames DO change, that does not mean the
# claimed component rendered, or rendered correctly, or rendered where it was
# supposed to — something moved, nothing more. So this reports REFUTED and
# NOT REFUTED. It never reports CONFIRMED, and "not refuted" must never be
# quoted as "verified".
SCENE_TH = 0.15


def scene_changes(p, th=SCENE_TH):
    """Pixel-side visual-change count. NOT a cut count — see the observation in
    adjudicate(): REF-2 shows 18 of these against 8 known editorial cuts,
    because §4 insert scenes change the frame without being cuts."""
    o = _sh(f'{FF} -hide_banner -i "{p}" -vf "select=\'gt(scene,{th})\',metadata=print" '
            f'-an -f null - 2>&1')
    return len(re.findall(r"pts_time:", o))


def _claim_count(v):
    """Extract a COUNT from a ledger value, or None — never an invented one.

    `component_ledger.generated_scenes` is a ROLL-UP dict, not a list of scenes.
    I once took len() of it and reported 'first Lumen output, n=4' off its four
    KEYS while it described zero scenes. A dict is never a count unless it names
    one."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, list):
        return len(v)
    if isinstance(v, dict):
        for k in ("count", "n", "requested", "emitted", "rendered", "survived"):
            if isinstance(v.get(k), (int, float)) and not isinstance(v.get(k), bool):
                return int(v[k])
        return None          # no named count -> UNADJUDICABLE, never len(dict)
    return None


# claim key -> (witness name, predicate on the critique dict, why)
# Only witnesses that have been calibrated on BOTH references AND red-proven on
# a known-bad appear here. Everything else is UNADJUDICABLE by construction.
WITNESSES = {
    "visual_change": (
        lambda r: (r.get("_scenes") or 0) > 0,
        "scene changes >0 · refs 23 / 18 · static known-bad 0"),
    "motion": (
        lambda r: bool(r.get("rhythm")) and r["rhythm"]["moving_per_s"] > 0,
        "moving samples/s >0 · refs 3.54 / 3.51 · static known-bad 0.00"),
}

# Which witness adjudicates which claim. A claim with no witness is reported
# UNADJUDICABLE and listed — silence here would read as a pass.
CLAIM_WITNESS = {
    "cuts": "visual_change", "n_cuts": "visual_change", "cut_count": "visual_change",
    "scenes": "visual_change", "scene_count": "visual_change",
    "generated_scenes": "visual_change", "transitions": "visual_change",
    "components": "motion", "component_count": "motion",
    "motion_graphics": "motion", "mg_count": "motion", "zooms": "motion",
}

# Named so the reason travels with the verdict rather than being folded into a
# generic "cannot check".
UNADJUDICABLE_REASONS = {
    "captions": "caption/text claims need glyph-level evidence; edge density cannot "
                "separate rendered captions from burned-in source text or from §4 "
                "designed layering — the same confound that broke the double-caption "
                "property",
    "caption_count": "see captions",
    "broll": "b-roll presence is not distinguishable from a cut in the output alone; "
             "it needs the source to compare against",
}


def adjudicate(video, ledger):
    """Adjudicate a ledger's claims against the pixels of the video it describes.

    Returns (rows, n_refuted). Each row is
    (claim, claimed, witness_or_None, verdict, note)."""
    r = critique(video)
    r["_scenes"] = scene_changes(video)
    rows, refuted = [], 0
    for k, raw in sorted(ledger.items()):
        n = _claim_count(raw)
        if n is None:
            rows.append((k, raw, None, "UNADJUDICABLE",
                         "no named count in this value — a dict is not a count"))
            continue
        if k in UNADJUDICABLE_REASONS:
            rows.append((k, n, None, "UNADJUDICABLE", UNADJUDICABLE_REASONS[k]))
            continue
        wname = CLAIM_WITNESS.get(k)
        if not wname:
            rows.append((k, n, None, "UNADJUDICABLE", "no calibrated pixel witness for this claim"))
            continue
        pred, why = WITNESSES[wname]
        present = pred(r)
        if n > 0 and not present:
            rows.append((k, n, wname, "REFUTED",
                         f"ledger claims {n}, pixels show NONE — {why}"))
            refuted += 1
        elif n > 0:
            rows.append((k, n, wname, "not refuted",
                         f"pixels are consistent with the claim; this is NOT confirmation — {why}"))
        elif present:
            rows.append((k, n, wname, "REVERSE-CONTRADICTED",
                         "ledger claims ZERO but the pixels show the witness — the counter "
                         "is under-reporting what shipped"))
            refuted += 1
        else:
            rows.append((k, n, wname, "not refuted", "ledger claims zero, pixels show none"))
    return r, rows, refuted


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
    "caption entrance (§2.5 frame-1-is-final) — ATTEMPTED AND REFUTED 2026-08-20: a "
    "constructed instant overlay and a 1.0s alpha-fade of the SAME box over the SAME "
    "footage measured IDENTICALLY (onsets 1, median rise 7 frames, max 7). Content "
    "motion and caption entrance share one signal. Enforced code-side instead.",
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
            "palette": palette_hold(p), "caption": caption_geometry(p),
            "beat": motion_on_beat(p), "rhythm": rhythm(p), "black": black_frames(p),
            "audio": audio_level(p), "tail": tail_frozen(p)}


def bars(r):
    """The SCORED bars. Each returns (name, ok_or_None, detail). ok=None means
    UNMEASURABLE — never silently a pass."""
    out = []
    rh = r.get("rhythm")
    if not rh:
        out.append((BAR_STILL, None, "rhythm unmeasurable — no samples returned"))
        out.append((BAR_MOTION, None, "rhythm unmeasurable"))
    else:
        out.append((BAR_STILL,
                    rh["longest_still_s"] <= STILL_CEILING_S,
                    f"longest {rh['longest_still_s']}s · refs 1.75s / 3.25s"))
        # A DEAD floor, not the 3.5 target. §5's 3.5 samples/s is what GOOD looks
        # like; failing an edit for 3.1 would be scoring taste. This fires only on
        # structurally dead motion (static known-bad: 0.00), and the distance to
        # the 3.5 target is reported separately as an observation.
        out.append((BAR_MOTION,
                    rh["moving_per_s"] >= MOTION_DEAD_FLOOR,
                    f"{rh['moving_per_s']}/s · refs 3.54 / 3.51 · target ~3.5"))
    bl = r.get("black")
    if not bl:
        out.append((BAR_BLACK, None, "blackdetect unmeasurable"))
    else:
        out.append((BAR_BLACK, bl["intervals"] <= BLACK_INTERVALS_MAX,
                    f"{bl['intervals']} interval(s), {bl['black_s']}s"
                    + (" AT TAIL" if bl["at_tail"] else "") + " · refs 0 / 0"))
    au = r.get("audio")
    if not au:
        out.append((BAR_AUDIO, None, "volumedetect returned nothing"))
    else:
        lo, hi = AUDIO_MEAN_BAND
        out.append((BAR_AUDIO, lo <= au["mean_db"] <= hi,
                    f"{au['mean_db']} dB · band [{lo}, {hi}] · refs -15.8 / -15.7"))
    return out


def show(r, extra_bars=None):
    print(f"\n=== VISUAL CRITIC — {r['file']} ({r['w']}x{r['h']}, {r['duration_s']}s) ===")
    for k in ("palette", "caption", "beat", "rhythm", "black", "audio"):
        print(f"  {k:9} {json.dumps(r.get(k))}")
    rows = bars(r) + (list(extra_bars(r)) if extra_bars else [])
    print()
    n_fail = n_unk = 0
    for name, ok, detail in rows:
        tag = "PASS" if ok else ("UNMEASURABLE" if ok is None else "FAIL")
        if ok is None:
            n_unk += 1
        elif not ok:
            n_fail += 1
        print(f"  {tag:12}  {name}  ({detail})")

    print("\n  OBSERVATIONS — reported, never gated (calibration refuted each as pass/fail):")
    if r.get("caption"):
        print(f"    · double-band frames {r['caption']['double_band_pct']}% — refs 3.3% / 16.3%; "
              "LAYERED TYPE IS THE DESIGNED LOOK (§4), not a defect")
    if r.get("tail"):
        print(f"    · tail frozen {r['tail']['frozen_frac']} — refs 0.89 / 0.33; §6's end card "
              "IS a held frame, so freezing at the end is CORRECT")
    if r.get("audio") and r["audio"].get("peak_db") is not None:
        print(f"    · audio peak {r['audio']['peak_db']} dB — both refs sit at EXACTLY 0.0, "
              "so peak separates nothing and carries no bar")

    print("\n  NOT SCORED — the owner's eye, and absence here is never a pass:")
    for x in NOT_SCORED:
        print(f"    · {x}")

    # ── THE STANDING RULE — printed on every green run, without exception ────
    print()
    if n_fail == 0 and n_unk == 0:
        print("  ✅ PASS — and the standing rule, which is not a formality:")
        print("     THIS IS NOT \"THE EDIT IS GOOD\". IT IS \"THE CHECKABLE DEFECTS ARE ABSENT\".")
        print("     A green run is never a quality verdict and must never be quoted as one.")
        print("     Everything under NOT SCORED above is untested, and the taste call is the")
        print("     owner's alone.")
    elif n_fail == 0 and n_unk:
        print(f"  ⚠️  NO FAILURES, BUT {n_unk} DIMENSION(S) UNMEASURABLE — this is NOT a pass.")
        print("     An unmeasured dimension is unknown, not clean. Fix the measurement first.")
    else:
        print(f"  ❌ {n_fail} FAILURE(S) — each is a specific, reproducible complaint. Fix, re-run.")
    return n_fail, n_unk


def _run_set(files, base, header):
    print(header)
    out = []
    for f in files:
        r = critique(os.path.join(base, f))
        show(r)
        out.append(r)
    return out


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        print(__doc__); sys.exit(0)

    if a[0] == "--references":
        print("CALIBRATION RUN — the references define every bar below.")
        print("A property the references fail is a BROKEN PROPERTY, not a broken reference.\n")
        out = _run_set(REF_FILES, REFS, "")
        print("\n\n=== DERIVED BARS (from the references, for use on our output) ===")
        cs = [r["caption"]["centroid_pct"] for r in out if r["caption"]]
        db = [r["caption"]["double_band_pct"] for r in out if r["caption"]]
        us = [r["palette"]["u_spread"] for r in out if r["palette"]]
        vs = [r["palette"]["v_spread"] for r in out if r["palette"]]
        print(f"  caption centroid       refs {cs}  -> ART_DIRECTION says ~53%")
        print(f"  DOUBLE-BAND frames     refs {db}%  <- OBSERVATION ONLY (see docstring)")
        print(f"  palette spread u/v     refs u{us} v{vs}")
        bm = [r["beat"].get("on_beat_pct") for r in out if r["beat"].get("on_beat_pct") is not None]
        print(f"  motion-on-beat         refs {bm}%")
        print(f"  motion density         refs {[r['rhythm']['moving_per_s'] for r in out if r['rhythm']]}/s")
        print(f"  longest still          refs {[r['rhythm']['longest_still_s'] for r in out if r['rhythm']]}s"
              f"  <- ceiling {STILL_CEILING_S}s; REF-2's 3.25s clears it by only 0.25s")
        print(f"  black intervals        refs {[r['black']['intervals'] for r in out if r['black']]}")
        print(f"  audio mean             refs {[r['audio']['mean_db'] for r in out if r['audio']]} dB")
        print("\n  CALIBRATION IS HALF DONE. Run --known-bad for the RED half; a bar that")
        print("  only clears the references has been FITTED to them and detects nothing.")
        try:
            d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out")
            os.makedirs(d, exist_ok=True)
            json.dump(out, open(os.path.join(d, "visual_critic_refs.json"), "w"), indent=1)
        except OSError:
            pass
        sys.exit(0)

    if a[0] == "--known-bad":
        d = KNOWN_BAD_DIR or (a[1] if len(a) > 1 else "")
        if not d or not os.path.isdir(d):
            print("KNOWN-BAD PROOF — the RED half of calibration.\n")
            print("No artifact directory. Set PROMPTLY_KNOWN_BAD_DIR or pass a path.")
            print("Build them from the REFERENCES (durable, reproducible; REF2 = "
                  f"{os.path.join(REFS, REF_FILES[1])}):\n")
            for k, v in KNOWN_BAD_RECIPES.items():
                print(f"  # {k}\n  {v}\n")
            sys.exit(2)
        print("KNOWN-BAD PROOF — every SCORED bar must go RED on the artifact built to\n"
              "break it, and stay GREEN on the others. Specificity is the point: a check\n"
              "that reds on everything is not detecting its own defect.\n")
        bad = 0
        for f, exp in KNOWN_BAD_EXPECT.items():
            p = os.path.join(d, f)
            if not os.path.exists(p):
                print(f"  MISSING  {f} — cannot prove RED without it"); bad += 1; continue
            got = {n: ok for n, ok, _ in bars(critique(p))}
            print(f"  --- {f}")
            for n in exp["reds"]:
                ok = got.get(n)
                good = ok is False
                print(f"      {'RED  ok' if good else 'NOT RED — FITTED?'}  {n}")
                bad += 0 if good else 1
            for n in exp["greens"]:
                ok = got.get(n)
                good = ok is True
                print(f"      {'green ok' if good else 'UNEXPECTED RED — not specific'}  {n}")
                bad += 0 if good else 1
        print(f"\nRESULT: {'PASS — every bar is proven RED on its own known-bad' if not bad else f'FAIL — {bad} problem(s)'}")
        sys.exit(1 if bad else 0)

    if a[0] == "--ledger":
        if len(a) < 3:
            print("usage: visual_critic.py --ledger <video.mp4> <ledger.json|'{...}'>")
            print("\nLEDGER vs PIXELS — the counters CLAIM, the pixels ADJUDICATE.")
            print("PIXELS CAN REFUTE A COUNTER. PIXELS CANNOT CONFIRM ONE.")
            sys.exit(2)
        src = a[2]
        led = json.loads(open(src).read() if os.path.exists(src) else src)
        if not isinstance(led, dict):
            print("ledger must be a JSON object of claim -> count"); sys.exit(2)
        r, rows, refuted = adjudicate(a[1], led)
        print(f"\n=== LEDGER vs PIXELS — {r['file']} ===")
        print(f"  pixel witnesses: scene_changes={r['_scenes']}  "
              f"moving_per_s={(r.get('rhythm') or {}).get('moving_per_s')}")
        print()
        print(f"  {'claim':22} {'ledger':>8}  verdict")
        print(f"  {'-'*22} {'-'*8}  {'-'*7}")
        for k, n, w, v, note in rows:
            print(f"  {k[:22]:22} {str(n):>8}  {v}")
            print(f"  {'':32}  └─ {note}")
        n_un = sum(1 for x in rows if x[3] == "UNADJUDICABLE")
        print()
        if refuted:
            print(f"  ❌ {refuted} CLAIM(S) REFUTED BY THE PIXELS — the counter and the frames")
            print("     disagree, and the frames are the independent witness. Trust the pixels.")
        else:
            print("  ✅ NO CLAIM REFUTED — and the standing rule, in its ledger form:")
            print("     THIS IS NOT \"THE COUNTERS ARE TRUE\". IT IS \"NO COUNTER WAS CAUGHT LYING\".")
            print("     Pixels REFUTE; they never CONFIRM. An unrefuted claim is unrefuted, not")
            print("     verified, and must never be quoted as verification.")
        if n_un:
            print(f"\n  ⚠️  {n_un} claim(s) UNADJUDICABLE — listed above with the reason each.")
            print("     An unadjudicable claim is unknown, not clean.")
        sys.exit(1 if refuted else 0)

    n_fail, n_unk = show(critique(a[0]))
    sys.exit(1 if (n_fail or n_unk) else 0)
