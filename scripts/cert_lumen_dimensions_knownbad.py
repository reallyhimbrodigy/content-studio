#!/usr/bin/env python3
"""KNOWN-BAD CERT for the Lumen video dimensions `[§7.1]`.

THE LAW (owner, 2026-08-14): a dimension must pass the references AND go RED on
a deliberately bad artifact. A threshold that only ever passes is a threshold
that was FITTED to the references — it proves nothing about anything else.

Both directions, per dimension, on artifacts generated here (no fixtures to rot):

  still_video      one frozen frame, 20s          -> motion_stillness must FAIL
  silent_audio     normal motion, silence         -> audio_not_silent must FAIL
  clipped_audio    normal motion, +12dB clipping  -> audio_no_clip must FAIL
  healthy_synth    motion every ~0.5s, -16dB bed  -> ALL must PASS

The healthy_synth arm is the control that stops this cert passing by being
uniformly harsh: if a synthetic-but-fine artifact fails, the bars are too tight
and the cert says so.

Run: python3 cert_lumen_dimensions_knownbad.py     (exit 1 on any violation)
"""
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lumen_video_dimensions import (  # noqa: E402
    motion_rhythm, audio_master, STILL_GAP_CEILING_S,
    AUDIO_MEAN_FLOOR_DB, AUDIO_MEAN_CEIL_DB, AUDIO_PEAK_CEIL_DB,
)

FFMPEG = os.environ.get("FFMPEG_PATH", "ffmpeg")


def gen(path, vf_src, af_src, dur=20):
    subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", vf_src, "-f", "lavfi", "-i", af_src,
                    "-t", str(dur), "-c:v", "libx264", "-preset", "ultrafast",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", path],
                   check=True, timeout=300)


def main():
    d = tempfile.mkdtemp(prefix="lumen-knownbad-")
    fails = []

    def check(name, cond, detail):
        print(f"  {'PASS' if cond else 'FAIL'}  {name}  ({detail})")
        if not cond:
            fails.append(name)

    # ── ARM 1: frozen frame -> stillness must trip ───────────────────────────
    p = os.path.join(d, "still.mp4")
    gen(p, "color=c=0x203040:s=320x568:r=30", "sine=frequency=300")
    r = motion_rhythm(p)
    print(f"\n[still_video] max_still_gap={r['max_still_gap_s']}s (bar {STILL_GAP_CEILING_S}s)")
    check("still_video trips stillness", r["max_still_gap_s"] > STILL_GAP_CEILING_S,
          f"{r['max_still_gap_s']}s > {STILL_GAP_CEILING_S}s")

    # ── ARM 2: silence -> the floor must trip (a silent bed once passed) ─────
    p = os.path.join(d, "silent.mp4")
    gen(p, "testsrc=s=320x568:r=30", "anullsrc=r=44100:cl=stereo")
    a = audio_master(p)
    print(f"\n[silent_audio] mean={a['mean_db']}dB (floor {AUDIO_MEAN_FLOOR_DB}dB)")
    check("silent_audio trips floor",
          a["mean_db"] is not None and a["mean_db"] < AUDIO_MEAN_FLOOR_DB,
          f"{a['mean_db']}dB < {AUDIO_MEAN_FLOOR_DB}dB")

    # ── ARM 3: clipping -> the ceiling must trip ─────────────────────────────
    p = os.path.join(d, "clipped.mp4")
    gen(p, "testsrc=s=320x568:r=30", "sine=frequency=440:sample_rate=44100,volume=12dB")
    a = audio_master(p)
    print(f"\n[clipped_audio] mean={a['mean_db']}dB peak={a['peak_db']}dB "
          f"(ceil {AUDIO_MEAN_CEIL_DB}dB / peak {AUDIO_PEAK_CEIL_DB}dB)")
    check("clipped_audio trips ceiling",
          (a["mean_db"] is not None and a["mean_db"] > AUDIO_MEAN_CEIL_DB)
          or (a["peak_db"] is not None and a["peak_db"] > AUDIO_PEAK_CEIL_DB),
          f"mean {a['mean_db']} / peak {a['peak_db']}")

    # ── ARM 4: CONTROL — synthetic but fine must pass every bar ──────────────
    p = os.path.join(d, "healthy.mp4")
    # a hard visual change ~2x/second + a normal-level bed
    gen(p, "testsrc=s=320x568:r=30,geq=lum='if(lt(mod(T*2,2),1),p(X,Y),255-p(X,Y))':cb='p(X,Y)':cr='p(X,Y)'",
        # LEVEL CALIBRATED, NOT GUESSED [MEASURED 2026-08-14]: ffmpeg's `sine`
        # sits at mean -21.1dB at default amplitude, so my first control used
        # volume=-16dB and produced a -37dB file — genuinely too quiet. The bar
        # correctly REJECTED it and this cert caught my own bad control. +6dB
        # lands at -15.1dB, inside the references' -15.7/-15.8dB band.
        # Sweep: +0dB->-21.1 · +6dB->-15.1 · +12dB->-9.1 · +18dB->-3.7.
        "sine=frequency=330,volume=6dB")
    r, a = motion_rhythm(p), audio_master(p)
    print(f"\n[healthy_synth] gap={r['max_still_gap_s']}s mean={a['mean_db']}dB peak={a['peak_db']}dB")
    check("healthy passes stillness", r["max_still_gap_s"] <= STILL_GAP_CEILING_S,
          f"{r['max_still_gap_s']}s <= {STILL_GAP_CEILING_S}s")
    check("healthy passes audio floor",
          a["mean_db"] is not None and a["mean_db"] >= AUDIO_MEAN_FLOOR_DB,
          f"{a['mean_db']}dB >= {AUDIO_MEAN_FLOOR_DB}dB")
    check("healthy passes clip guard",
          a["peak_db"] is not None and a["peak_db"] <= AUDIO_PEAK_CEIL_DB,
          f"peak {a['peak_db']}dB <= {AUDIO_PEAK_CEIL_DB}dB")

    print()
    if fails:
        print(f"CERT-LUMEN-KNOWNBAD **FAILED**: {len(fails)} violation(s): {fails}")
        print("A dimension that cannot go RED on a bad artifact was FITTED, not calibrated.")
        return 1
    print("CERT-LUMEN-KNOWNBAD PASS — every bar trips on its known-bad arm and "
          "the healthy control survives (bars are discriminating, not merely harsh).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
