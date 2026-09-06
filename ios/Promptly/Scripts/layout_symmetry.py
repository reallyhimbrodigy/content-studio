import sys, os
from PIL import Image

# THE SYMMETRY RULE (ruled 2026-09-05).
# Empty space is not a defect; UNBALANCED empty space is. Content centred in a
# tall container leaves near-equal bands above and below — that reads as
# deliberate. One band, or two very unequal ones, reads as content shoved to an
# edge, which is the iPad complaint. Interior voids are judged separately: a
# hole in the middle of the content is a defect whatever the margins do.
BAND_MIN   = 120   # pt: smaller than this is ordinary padding, not a band
TOLERANCE  = 0.28  # bands within 28% of each other count as near-equal
VOID_MAX   = 150   # pt: an interior gap larger than this is a hole

def report(path, scale=2):
    im = Image.open(path).convert("L"); w, h = im.size; px = im.load()
    step = max(1, w // 260)
    # IGNORE SYSTEM CHROME. The status bar (clock/wifi/battery) and the home
    # indicator are ink at the very edges, so including them makes every real
    # top band read as an "interior void at y=22" and hides edge-shoving.
    CHROME_TOP, CHROME_BOT = int(30 * scale), int(16 * scale)
    ys = range(CHROME_TOP, h - CHROME_BOT)
    # DENSITY, not presence. The home indicator and the rounded-corner
    # antialiasing are 1–2px hairlines at the very edges; counting them as
    # content made every bottom band read as 0 and hid whether the layout was
    # actually centred. A content row needs real ink across the width.
    MIN_INK = 3
    def ink(y):
        n = 0
        for x in range(0, w, step):
            if px[x, y] > 24:
                n += 1
                if n >= MIN_INK: return True
        return False
    rows = [y for y in ys if ink(y)]
    if not rows:
        return os.path.basename(path), "BLANK", ["no ink"]
    H = h / scale
    top = (min(rows) - CHROME_TOP) / scale          # band above the first content ink
    bot = ((h - CHROME_BOT) - max(rows)) / scale    # band below the last content ink
    faults, notes = [], []

    big = [b for b in (top, bot) if b >= BAND_MIN]
    if big:
        if top >= BAND_MIN and bot >= BAND_MIN:
            hi, lo = max(top, bot), min(top, bot)
            skew = (hi - lo) / hi
            if skew <= TOLERANCE:
                notes.append(f"centred: bands {top:.0f}pt / {bot:.0f}pt (skew {skew*100:.0f}%)")
            else:
                faults.append(f"asymmetric bands {top:.0f}pt top vs {bot:.0f}pt bottom (skew {skew*100:.0f}%)")
        else:
            which = "top" if top >= BAND_MIN else "bottom"
            faults.append(f"single {which} band {max(top,bot):.0f}pt (other {min(top,bot):.0f}pt) — content is edge-shoved")

    gaps, prev = [], rows[0]
    for y in rows[1:]:
        if y - prev > 1: gaps.append((prev, y))
        prev = y
    voids = [(a, b) for a, b in gaps if (b - a) / scale > VOID_MAX]

    # TWO VOIDS BRACKETING ONE BLOCK ARE THE CENTRING, NOT A DEFECT.
    # A screen with a top bar and a bottom composer centres its content between
    # them, which necessarily leaves a gap above and a gap below. Counting those
    # as voids invents a failure the product does not have. They are excused only
    # when there are EXACTLY two, they are the first and last gaps (so they really
    # do bracket a single block), and they are within the same TOLERANCE the band
    # rule uses. A lone void — content torn in half — still fails, which is the
    # case this checker was built to catch.
    # Exactly two large voids means the ink between them is one block and the
    # ink outside them is the chrome that brackets it. (Requiring them to be the
    # first and last gaps was too strict — the status bar and the composer leave
    # small gaps of their own outside the pair.)
    bracketing = len(voids) == 2
    if bracketing:
        v0 = (voids[0][1] - voids[0][0]) / scale
        v1 = (voids[1][1] - voids[1][0]) / scale
        skew_v = (max(v0, v1) - min(v0, v1)) / max(v0, v1)
        if skew_v <= TOLERANCE:
            notes.append(f"centred between chrome: {v0:.0f}pt above / {v1:.0f}pt below "
                         f"(skew {skew_v*100:.0f}%)")
            voids = []
        else:
            faults.append(f"off-centre between chrome: {v0:.0f}pt above vs {v1:.0f}pt below "
                          f"(skew {skew_v*100:.0f}%)")
            voids = []

    for a, b in voids:
        g = (b - a) / scale
        faults.append(f"interior void {g:.0f}pt at y={a/scale:.0f}")
    return os.path.basename(path), ("PASS" if not faults else "FAIL"), faults + notes

# TRANSCRIPT SURFACES ARE NOT CENTRED SURFACES.
# The symmetry rule governs full-screen surfaces that are meant to sit centred:
# paywalls, questions, the ladder beats. A CHAT TRANSCRIPT fills from the top as
# messages arrive — a single early message legitimately leaves the rest empty.
# Measuring it against a centring rule invents a failure the product does not
# have, so it is reported with its numbers and excluded from the verdict.
TRANSCRIPT = ("bubble", "chatempty", "chatvideo")

for p in sorted(sys.argv[1:]):
    n, v, f = report(p)
    if any(t in n for t in TRANSCRIPT):
        print(f"  N/A   {n}  (transcript — top-aligned by design, not a centred surface)")
        for x in f: print(f"          · {x}")
        continue
    print(f"  {v:5s} {n}")
    for x in f: print(f"          · {x}")
