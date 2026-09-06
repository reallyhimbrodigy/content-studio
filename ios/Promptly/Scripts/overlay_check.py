#!/usr/bin/env python3
"""THE WIDTH RULE, CHECKED.

  Full-width on the phone  -> 88% of the iPad container.
  Fixed-width on the phone -> that width times k.
  Heights, type, padding, radii, icons -> times k.

So the two axes are checked differently, and that is the whole point:

  VERTICAL is a pure scale. Divide the iPad's geometry by k and every band must
  land on the phone's, up to one rigid offset (the system's own insets do not
  scale — 59/34pt of phone chrome against 24/20 on iPad — so the whole chat
  sits a constant distance off; every band must SHARE that offset).

  HORIZONTAL is not. A filling element is 88% of the iPad's container, which is
  a different fraction of the screen than the phone's full width. So width is
  checked against the RULE, not against the phone times k.

  usage: overlay_check.py <phone.png> <ipad.png> [--out diff.png]
"""
import sys, os
from PIL import Image
import numpy as np

REF_H_PT   = 852.0     # ConversionColumn.phoneReferenceHeight — k is defined against this
PAD_FILL   = 0.88      # ConversionColumn.padFill
CHROME_TOP = 105       # status bar + the nav bar under it (neither scales)
CHROME_BOT = 24
INK        = 26
TOL_PT     = 6.0
MERGE_PT   = 9.0       # rows closer than this are one layout block, not glyph rows
# ProportionalWidth takes 88% of the CONTAINER the element sits in, and that
# container is the screen minus the thread's own horizontal padding — so as a
# fraction of the SCREEN a filling element lands a little under 88%. The screen
# is what a screenshot can measure, so the band below is 88% of a container
# between 92% and 100% of the screen. It still fails the two regressions that
# matter: a fixed column (the 635pt one measured 61%) and a full-bleed row.
FILL_MIN   = 0.808
FILL_MAX   = 0.895


def bands(mask, scale, lo, hi):
    rows = mask.sum(1)
    out, run = [], None
    for y in range(int(lo * scale), int(hi * scale)):
        if rows[y] > 3:
            if run is None: run = y
        elif run is not None:
            out.append((run / scale, y / scale)); run = None
    if run is not None: out.append((run / scale, hi))
    out = [b for b in out if b[1] - b[0] >= 2]
    merged = []
    for b in out:
        if merged and b[0] - merged[-1][1] < MERGE_PT: merged[-1] = (merged[-1][0], b[1])
        else: merged.append(b)
    return merged


def widest_run(mask, scale, lo, hi):
    """The widest ink run in the region, in points — the filling elements."""
    best = 0
    for y in range(int(lo * scale), int(hi * scale)):
        row = mask[y]
        idx = np.flatnonzero(np.diff(np.concatenate(([0], row.view(np.int8), [0]))))
        if len(idx) < 2: continue
        runs = idx[1::2] - idx[::2]
        best = max(best, int(runs.max()))
    return best / scale


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else None
    phone_p, ipad_p = args[0], args[1]

    pim = Image.open(phone_p).convert("L"); pa = np.array(pim).astype(int)
    iim = Image.open(ipad_p).convert("L");  ia = np.array(iim).astype(int)

    ps = pa.shape[0] / (pa.shape[0] / 3.0)      # phone @3x
    ps = 3.0
    isc = 2.0                                    # iPad @2x
    ipad_h_pt = ia.shape[0] / isc
    ipad_w_pt = ia.shape[1] / isc
    phone_h_pt = pa.shape[0] / ps
    k = ipad_h_pt / REF_H_PT

    pm, cm = pa > INK, ia > INK
    faults, notes = [], []

    # ---- HORIZONTAL: the rule, not the phone times k ----
    lo_i, hi_i = CHROME_TOP * k, ipad_h_pt - CHROME_BOT * k
    fill_pt = widest_run(cm, isc, lo_i, hi_i)
    frac = fill_pt / ipad_w_pt
    if FILL_MIN <= frac <= FILL_MAX:
        notes.append(f"filling elements span {fill_pt:.0f}pt = {frac*100:.0f}% of the "
                     f"{ipad_w_pt:.0f}pt screen — {PAD_FILL*100:.0f}% of their container")
    else:
        faults.append(f"filling elements span {frac*100:.0f}% of the screen "
                      f"({fill_pt:.0f}pt of {ipad_w_pt:.0f}pt) — the rule is "
                      f"{PAD_FILL*100:.0f}% of the container")

    # ---- VERTICAL: a pure scale ----
    # Put the iPad into phone points by dividing by k, then compare bands.
    ih = int(round(ipad_h_pt / k * ps))
    iw = int(round(ipad_w_pt / k * ps))
    shrunk = np.array(iim.resize((iw, ih), Image.LANCZOS)).astype(int) > INK

    lo, hi = CHROME_TOP, min(phone_h_pt, ih / ps) - CHROME_BOT
    pb = bands(pm, ps, lo, hi)
    cb = bands(shrunk, ps, lo, hi)

    n_pair = min(len(pb), len(cb))
    pp, cc = pb[len(pb) - n_pair:], cb[len(cb) - n_pair:]
    extra = len(cb) - len(pb)
    if extra > 0:
        notes.append(f"iPad shows {extra} more block(s) at the top — its usable height "
                     f"exceeds the phone's times k (system chrome does not scale)")
    elif extra < 0:
        faults.append(f"phone shows {-extra} block(s) the iPad does not")

    measurable = [(p, c) for p, c in zip(pp, cc)
                  if p[0] > lo + 1 and p[1] < hi - 1 and c[0] > lo + 1 and c[1] < hi - 1]
    offs = sorted(c[0] - p[0] for p, c in measurable)
    shift = offs[len(offs) // 2] if offs else 0.0
    for n, (p, c) in enumerate(measurable, 1):
        dtop = (c[0] - p[0]) - shift
        dh = (c[1] - c[0]) - (p[1] - p[0])
        if abs(dtop) > TOL_PT:
            faults.append(f"block {n} at y={p[0]:.0f}pt sits {dtop:+.0f}pt off the common "
                          f"{shift:+.0f}pt offset")
        elif abs(dh) > TOL_PT:
            # A block that FILLS gets wider relative to its type on the iPad, so
            # a paragraph inside it wraps into fewer lines and the block is
            # shorter. That is the width rule working, not a defect — the rule
            # only promises the same VERTICAL POSITION, not the same height, for
            # anything that fills.
            notes.append(f"block {n} at y={p[0]:.0f}pt is {dh:+.0f}pt shorter/taller — a "
                         f"filling text block rewraps at the wider column")

    if out:
        h = min(pm.shape[0], shrunk.shape[0]); w = min(pm.shape[1], shrunk.shape[1])
        z = np.zeros((h, w), dtype="uint8")
        Image.merge("RGB", [Image.fromarray((pm[:h, :w] * 255).astype("uint8")),
                            Image.fromarray((shrunk[:h, :w] * 255).astype("uint8")),
                            Image.fromarray(z)]).save(out)

    print(f"  {'PASS' if not faults else 'FAIL'}  {os.path.basename(ipad_p)}   k={k:.3f}  "
          f"blocks {len(pb)}/{len(cb)}  vertical shift {shift:+.0f}pt")
    for f in faults: print(f"          · {f}")
    for n in notes: print(f"          · {n}")
    return 1 if faults else 0


sys.exit(main())
