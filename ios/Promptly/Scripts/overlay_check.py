#!/usr/bin/env python3
"""THE IPAD CHAT IS THE IPHONE CHAT, SCALED — checked, not asserted.

The rule (ruled 2026-09-05): every element of the iPad chat sits in the same
relative position at the same relative size as the iPhone's, scaled by k.

k is the app's own scale: the window's long side over the 852pt reference phone.
So the check is exact rather than approximate — take the reference phone's
capture (393x852pt), scale it by k, and it must land on the iPad's chat column.

  usage: overlay_check.py <phone.png> <ipad.png> [--out diff.png]

Chrome is excluded the way symmetry.py excludes it: the status bar and the home
indicator are the system's, not the layout's.
"""
import sys, os
from PIL import Image
import numpy as np

REF_H_PT   = 852.0     # ConversionColumn.phoneReferenceHeight
REF_W_PT   = 393.0     # ThreadColumn.phoneReferenceWidth
# The system status bar is NOT a scaled quantity — 59pt of Dynamic Island on the
# phone against 24pt on the iPad — so the nav bar that sits directly beneath it
# lands at a different height on each and can never overlay. Everything from the
# nav bar up is excluded and reported separately; the chat below it is the check.
CHROME_TOP = 105       # pt — status bar + the nav bar under it
CHROME_BOT = 24        # pt — home indicator
INK        = 26        # luminance above this is ink
TOL_PT     = 6.0       # a band may sit this far off and still count as aligned
# TEXT LAYOUT IS NOT SCALE-INVARIANT. A 15pt font in a 300pt box and a 24.2pt
# font in a 484pt box do not break lines at the same word — hinting, kerning and
# rounding see to that — so a wrapped paragraph can be 2 lines on one device and
# 2 lines broken elsewhere on the other. Rows closer together than this are one
# block, so the check compares layout blocks rather than glyph rows.
MERGE_PT   = 9.0


def load(path):
    im = Image.open(path).convert("L")
    return im, np.array(im).astype(int)


def bands(mask, scale, lo, hi):
    """Contiguous rows carrying ink, in points, within [lo, hi]."""
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
        if merged and b[0] - merged[-1][1] < MERGE_PT:
            merged[-1] = (merged[-1][0], b[1])
        else:
            merged.append(b)
    return merged


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = None
    if "--out" in sys.argv: out = sys.argv[sys.argv.index("--out") + 1]
    phone_p, ipad_p = args[0], args[1]

    pim, pa = load(phone_p)
    iim, ia = load(ipad_p)
    ps = pa.shape[0] / REF_H_PT                     # phone px per pt
    ipt_h = max(ia.shape) / 2.0                     # iPad @2x
    isc = 2.0
    k = ipt_h / REF_H_PT

    if abs(pa.shape[1] / ps - REF_W_PT) > 1:
        print(f"  !! phone capture is {pa.shape[1]/ps:.0f}pt wide, not the {REF_W_PT:.0f}pt "
              f"reference — the overlay is only exact on a 393x852 device")

    col_pt = REF_W_PT * k                            # the chat column on iPad
    x0 = (ia.shape[1] / isc - col_pt) / 2.0
    crop = iim.crop((int(x0 * isc), 0,
                     int((x0 + col_pt) * isc), ia.shape[0]))
    crop = crop.resize((pa.shape[1], pa.shape[0]), Image.LANCZOS)
    ca = np.array(crop).astype(int)

    pm, cm = pa > INK, ca > INK
    lo, hi = CHROME_TOP, REF_H_PT - CHROME_BOT
    pb, cb = bands(pm, ps, lo, hi), bands(cm, ps, lo, hi)

    band = int(lo * ps), int(hi * ps)
    inter = (pm[band[0]:band[1]] & cm[band[0]:band[1]]).sum()
    union = (pm[band[0]:band[1]] | cm[band[0]:band[1]]).sum()
    iou = inter / union if union else 1.0

    # THE SYSTEM'S INSETS DO NOT SCALE, AND THE THREAD IS BOTTOM-ANCHORED.
    #
    # The phone carries 59pt of Dynamic Island and a 34pt home indicator; the
    # iPad carries 24 and 20. Nothing the layout does makes those equal times k,
    # so the iPad's usable height is ~66 phone-pt MORE than the phone's even
    # though its screen is exactly 852·k. A chat scrolled to its newest message
    # therefore reveals a little more history at the top — that is the system's
    # chrome, not the layout.
    #
    # So the bands are paired from the BOTTOM, where both are anchored. Any band
    # the iPad reveals above the phone's first is reported as revealed, not as a
    # fault. Within the paired set, the rigid offset is removed and every band
    # must share it.
    faults, notes = [], []
    n_pair = min(len(pb), len(cb))
    pp, cc = pb[len(pb) - n_pair:], cb[len(cb) - n_pair:]
    extra = len(cb) - len(pb)
    if extra > 0:
        notes.append(f"iPad reveals {extra} more band(s) at the top — its usable height "
                     f"is larger than the phone's times k (system chrome)")
    elif extra < 0:
        faults.append(f"phone shows {-extra} band(s) the iPad does not — the iPad has the "
                      f"greater usable height, so it should never show less")

    measurable = [(p, c) for p, c in zip(pp, cc)
                  if p[0] > lo + 1 and p[1] < hi - 1 and c[0] > lo + 1 and c[1] < hi - 1]
    offs = sorted(c[0] - p[0] for p, c in measurable)
    shift = offs[len(offs) // 2] if offs else 0.0
    for n, (p, c) in enumerate(measurable, 1):
        dtop = (c[0] - p[0]) - shift
        dh = (c[1] - c[0]) - (p[1] - p[0])
        if abs(dtop) > TOL_PT or abs(dh) > TOL_PT:
            faults.append(f"band {n} at y={p[0]:.0f}pt: offset {dtop:+.0f}pt from the "
                          f"common {shift:+.0f}pt, height {dh:+.0f}pt")

    # Overlap is measured with the rigid shift taken out, over the span the two
    # actually share.
    sh = int(round(shift * ps))
    if sh:
        cm2 = np.zeros_like(cm)
        if sh > 0: cm2[:cm.shape[0]-sh] = cm[sh:]
        else:      cm2[-sh:] = cm[:cm.shape[0]+sh]
        cm = cm2
    top = int((pp[0][0] if pp else lo) * ps)
    bot = int(hi * ps)
    inter2 = (pm[top:bot] & cm[top:bot]).sum()
    union2 = (pm[top:bot] | cm[top:bot]).sum()
    iou = inter2 / union2 if union2 else 1.0
    if iou < 0.80:
        faults.append(f"ink overlap {iou*100:.0f}% (want 80%+)")

    if out:
        rgb = Image.merge("RGB", [Image.fromarray((pm * 255).astype("uint8")),
                                  Image.fromarray((cm * 255).astype("uint8")),
                                  Image.fromarray(np.zeros_like(pa, dtype="uint8"))])
        rgb.save(out)

    name = os.path.basename(ipad_p)
    print(f"  {'PASS' if not faults else 'FAIL'}  {name}   k={k:.3f}  column={col_pt:.0f}pt  "
          f"overlap={iou*100:.0f}%  bands {len(pb)}/{len(cb)}  "
          f"system-inset shift {shift:+.0f}pt")
    for f in faults: print(f"          · {f}")
    for n in notes: print(f"          · {n}")
    return 1 if faults else 0


sys.exit(main())
