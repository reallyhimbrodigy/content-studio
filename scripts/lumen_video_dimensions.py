#!/usr/bin/env python3
"""LUMEN VIDEO DIMENSION BATTERY — measured on the RENDERED FILE `[§7.1, §3.1]`.

WHY THIS EXISTS, beside rhythm_dimension.py rather than replacing it:
`rhythm_dimension.py` scores a PLAN. The two references are VIDEOS with no
plan, so the binding canon rule — *run both references through every dimension
before it judges anything* — is literally unsatisfiable for a plan-only
dimension. This battery closes that: every dimension here runs identically on
a reference mp4 and on a Lumen output mp4, so "does our output stand beside the
bar" becomes one comparable table instead of two incomparable ones.

Plan-side and video-side are complements, not rivals: the plan gate catches a
bad edit BEFORE spend; this catches what actually reached the user.

DIMENSIONS — objectivity stated per dimension, because a proxy that calls
itself taste is how a taxonomy starts lying:

  canvas          [OBJECTIVE]  w x h, fps, duration
  audio_master    [OBJECTIVE]  mean/peak dBFS (ffmpeg volumedetect)
  hard_cuts       [OBJECTIVE]  scene-change count + median shot + longest gap
  motion_rhythm   [PROXY]      frame-to-frame visual change sampled at 4Hz.
                               Captures caption/kinetic/scene motion that scene
                               detection MISSES — the exact thing the reference
                               calibration proved matters. It cannot name WHICH
                               motion kind fired; the plan-side dimension can.
  palette         [PROXY]      per-shot dominant-hue stability across the edit.
                               Consistency is measurable; whether the palette is
                               GOOD is taste and is not scored here.

NOT SCORED (needs the owner's blind sheet, marked [UNCALIBRATED] on the board):
  scene presence at claims/numbers, caption-mode correctness, brand/end-card
  presence. These need semantic ground truth this battery cannot see from
  pixels. Reporting them as numbers now would be inventing taste.

Usage:
    python3 lumen_video_dimensions.py <video.mp4> [more.mp4 ...]
    python3 lumen_video_dimensions.py --references     # calibration run
"""
import json
import os
import re
import subprocess
import sys

FFMPEG = os.environ.get("FFMPEG_PATH", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE_PATH", "ffprobe")

# Bars are set BY the references (see --references). A bar no reference meets is
# a broken bar; these are recorded after the calibration run, never before.
# RECALIBRATED BY THE REFERENCES 2026-08-14 [MEASURED]. §1.G asserts "stillness
# never exceeds ~2s". Measured on all visible motion at maximum sensitivity,
# REF-1 max still gap is 1.75s (passes) but REF-2 is 3.00s (fails) — and REF-2
# fails at EVERY threshold tested (0.002-0.020). Per the binding canon rule, a
# dimension both references cannot satisfy is a broken dimension: the ~2s figure
# is a vibe the bar itself does not meet. 3.5s admits both references with
# margin. REF-2's long-take + caption-rhythm style is the reason, and §1.G names
# it explicitly, so this is the spec's own case — not a concession.
STILL_GAP_BAR_S = 3.5
AUDIO_MEAN_FLOOR_DB = -20.0  # both refs sit near -15.8; a silent bed must fail
AUDIO_MEAN_CEIL_DB = -10.0   # BOTH directions bounded: nothing passes by absence
AUDIO_PEAK_CEIL_DB = 0.5     # clipping guard


def _run(cmd, timeout=900):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return (p.stdout or "") + (p.stderr or "")


def canvas(path):
    out = _run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                "stream=width,height,r_frame_rate,duration,codec_name",
                "-of", "json", path])
    st = (json.loads(out).get("streams") or [{}])[0]
    num, _, den = (st.get("r_frame_rate") or "0/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 0.0
    dur = float(st.get("duration") or 0.0)
    if not dur:
        o2 = _run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                   "-of", "default=nw=1:nk=1", path])
        try:
            dur = float(o2.strip().splitlines()[0])
        except Exception:
            dur = 0.0
    return {"w": st.get("width"), "h": st.get("height"), "fps": round(fps, 2),
            "duration_s": round(dur, 2), "codec": st.get("codec_name"),
            "orientation": "vertical" if (st.get("height") or 0) > (st.get("width") or 0) else "landscape"}


def audio_master(path):
    out = _run([FFMPEG, "-hide_banner", "-i", path, "-af", "volumedetect",
                "-f", "null", "-"])
    mean = re.search(r"mean_volume:\s*(-?[\d.]+) dB", out)
    peak = re.search(r"max_volume:\s*(-?[\d.]+) dB", out)
    return {"mean_db": float(mean.group(1)) if mean else None,
            "peak_db": float(peak.group(1)) if peak else None}


def hard_cuts(path, threshold=0.3):
    out = _run([FFMPEG, "-hide_banner", "-i", path, "-vf",
                f"select='gt(scene,{threshold})',metadata=print:file=-",
                "-an", "-f", "null", "-"])
    ts = [float(m) for m in re.findall(r"pts_time:([\d.]+)", out)]
    ts.sort()
    gaps = [round(b - a, 2) for a, b in zip(ts, ts[1:])]
    med = None
    if gaps:
        s = sorted(gaps)
        med = round(s[len(s) // 2], 2)
    return {"n_cuts": len(ts), "median_shot_s": med,
            "longest_cut_gap_s": max(gaps) if gaps else None, "cut_times": ts}


def motion_rhythm(path, hz=4.0, still_thresh=0.004):
    """[PROXY] Sample frame-difference energy at `hz` and call a sample 'moving'
    when normalized change exceeds `still_thresh`. The longest run of still
    samples is the stillness gap the §1.G law is actually about — and unlike
    scene detection it SEES caption pops, kinetic type and scene inserts.

    THRESHOLD IS CALIBRATED, NOT GUESSED [MEASURED 2026-08-14]. My first default
    (0.008) reported REF-1 at a 3.25s gap; a sensitivity sweep showed that was MY
    instrument being under-sensitive — at 0.004 REF-1 measures 1.75s and passes.
    Sweep (ref1/ref2 max gap): .002→1.75/3.00 · .004→1.75/3.25 · .008→3.25/3.50
    · .020→3.75/3.75. 0.004 keeps a hair of noise immunity while reproducing the
    references' real cadence. Re-run the sweep before changing it."""
    out = _run([FFMPEG, "-hide_banner", "-i", path, "-vf",
                f"fps={hz},scale=160:-2,tblend=all_mode=difference,"
                f"signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
                "-an", "-f", "null", "-"])
    vals = [float(m) for m in re.findall(r"lavfi\.signalstats\.YAVG=([\d.]+)", out)]
    if not vals:
        return {"error": "no frames sampled"}
    norm = [v / 255.0 for v in vals]
    moving = [v > still_thresh for v in norm]
    longest, cur = 0, 0
    for m in moving:
        cur = 0 if m else cur + 1
        longest = max(longest, cur)
    return {"samples": len(norm), "hz": hz,
            "events_per_s": round(sum(moving) / (len(norm) / hz), 2),
            "max_still_gap_s": round(longest / hz, 2),
            "mean_change": round(sum(norm) / len(norm), 4)}


def palette(path, n=24):
    """[PROXY] Dominant-hue stability. Samples n frames, takes mean hue/sat per
    frame, reports spread. Measures CONSISTENCY only — never whether the palette
    is good, which is taste."""
    dur = canvas(path)["duration_s"] or 1
    hues, sats = [], []
    for i in range(n):
        t = max(0.0, dur * (i + 0.5) / n)
        out = _run([FFMPEG, "-hide_banner", "-ss", f"{t:.2f}", "-i", path,
                    "-frames:v", "1", "-vf",
                    "scale=64:-2,format=yuv444p,signalstats,metadata=print:file=-",
                    "-an", "-f", "null", "-"], timeout=120)
        u = re.search(r"lavfi\.signalstats\.UAVG=([\d.]+)", out)
        v = re.search(r"lavfi\.signalstats\.VAVG=([\d.]+)", out)
        if u and v:
            hues.append(float(u.group(1)))
            sats.append(float(v.group(1)))
    if not hues:
        return {"error": "no frames sampled"}
    def spread(xs):
        m = sum(xs) / len(xs)
        return round((sum((x - m) ** 2 for x in xs) / len(xs)) ** 0.5, 2)
    return {"frames": len(hues), "u_mean": round(sum(hues) / len(hues), 1),
            "v_mean": round(sum(sats) / len(sats), 1),
            "u_spread": spread(hues), "v_spread": spread(sats)}


def measure(path):
    return {"file": os.path.basename(path), "canvas": canvas(path),
            "audio_master": audio_master(path), "hard_cuts": hard_cuts(path),
            "motion_rhythm": motion_rhythm(path), "palette": palette(path)}


def report(m):
    c, a, h, r, p = m["canvas"], m["audio_master"], m["hard_cuts"], m["motion_rhythm"], m["palette"]
    print(f"\n=== {m['file']} ===")
    print(f"  canvas     [OBJ] {c['w']}x{c['h']} {c['orientation']} {c['fps']}fps {c['duration_s']}s ({c['codec']})")
    print(f"  audio      [OBJ] mean {a['mean_db']} dB · peak {a['peak_db']} dB")
    print(f"  hard cuts  [OBJ] n={h['n_cuts']} median shot {h['median_shot_s']}s · longest gap {h['longest_cut_gap_s']}s")
    print(f"  rhythm     [PRX] {r.get('events_per_s')} moving/s · MAX STILL GAP {r.get('max_still_gap_s')}s "
          f"({r.get('samples')} samples @ {r.get('hz')}Hz)")
    print(f"  palette    [PRX] U {p.get('u_mean')}±{p.get('u_spread')} · V {p.get('v_mean')}±{p.get('v_spread')}")
    # both-direction bar checks
    checks = []
    if a["mean_db"] is not None:
        checks.append(("audio_not_silent", a["mean_db"] >= AUDIO_MEAN_FLOOR_DB))
        checks.append(("audio_not_hot", a["mean_db"] <= AUDIO_MEAN_CEIL_DB))
        checks.append(("audio_no_clip", (a["peak_db"] or 0) <= AUDIO_PEAK_CEIL_DB))
    if r.get("max_still_gap_s") is not None:
        # CUTS ALONE ARE NOT THE LAW — both references run 6.1s/9.5s between
        # hard cuts and would fail a cut-based bar. Reported for context only;
        # the LAW is measured on all visible motion.
        print(f"     (context) longest cut-to-cut gap {h['longest_cut_gap_s']}s — NOT a bar; refs run 6.1s/9.5s")
        checks.append((f"motion_stillness<={STILL_GAP_BAR_S}s", r["max_still_gap_s"] <= STILL_GAP_BAR_S))
    for name, ok in checks:
        print(f"     {'PASS' if ok else 'FAIL'}  {name}")
    return checks


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)
    if args[0] == "--references":
        base = "/Users/zaclibman/promptly-gpu-worker/promptly-gpu-worker/golden/lumen-refs"
        args = [f"{base}/ref1-legalsoft-corporate-landscape.mp4",
                f"{base}/ref2-viral-creator-doc-vertical.mp4"]
        print("CALIBRATION RUN — the references define the bar. A dimension they")
        print("fail is a BROKEN DIMENSION, not a broken reference.")
    out = []
    for p in args:
        m = measure(p)
        m["_checks"] = report(m)
        out.append(m)
    with open(os.path.join(os.path.dirname(__file__), "..", "out", "lumen_dimensions.json"), "w") as f:
        json.dump(out, f, indent=1, default=str)
    print("\nwrote out/lumen_dimensions.json")
