# The reference placement atlas

**For Builder 1's platter. Measured facts, not prose — per family: when it
lands, how big, where, how long, and on which beat. Read-only, no spend.**

Full per-family tables with anchor frames: `REFERENCE_PLACEMENT_ATLAS.txt`.

## The finding that should shape the platter

> **Reference placements land ON shot changes.**
>
> | family | within 0.25s of a shot change | median distance |
> |---|---|---|
> | cut | **86%** (70/81) | 0.00s |
> | cutaway | **83%** (60/72) | 0.00s |
> | text | **74%** (92/124) | 0.00s |
> | card | **72%** (29/40) | 0.00s |
> | sfx | 57% (8/14) | 0.00s |
> | zoom | 50% (3/6) | 2.10s |

Four of six families put the median placement **exactly on a cut**. The platter
currently says *when* to reach for a component by occasion ("WHEN A NUMBER
LANDS"); it says nothing about *where in time* it goes. This is the missing half
and it is mechanical: the boundary is already in the timeline.

## Who is on screen decides the family

| family | speaker on screen | subject occlusion |
|---|---|---|
| sfx | 78% | — |
| cut | 69% | — |
| **text** | **67%** | over_body 37% · **over_face 11%** · clear 26% · none 26% |
| cutaway | 29% | **no_subject_visible 85%** |
| **card** | **20%** | **no_subject_visible 49%** · over_body 23% · clear 20% |

**Text sits WITH the speaker; card and cutaway REPLACE them.** That is a
different decision from "which component", and the platter does not express it.
Note text goes over the face 11% of the time in the references — the practice is
not "never over the face", it is "rarely, and deliberately".

## Size and duration, per family

| family | size | beat span (median) | p90 | hold_s (top) |
|---|---|---|---|---|
| text | medium 45% · large 21% · dominant 19% · small 14% | 2.17s | 5.57s | 0.6 / 0.4 / 1.0 |
| card | medium 37% · dominant 25% · large 23% · small 14% | 2.98s | 6.10s | 1.6 / 4.0 / 1.0 |
| cutaway | **dominant 55%** · large 28% · small 12% · medium 5% | 2.00s | 5.03s | 1.6 / 1.5 / 1.3 |
| cut | — *unmeasured* | 2.17s | 5.17s | — |
| sfx | — *unmeasured* | 4.00s | 5.05s | — |
| zoom | — *unmeasured* | 3.35s | 9.63s | — |

**There is no single "reference size".** Text spans small→dominant with medium
the mode at 45%; cutaway is dominant more than half the time. A platter that
labels a component MEDIUM or LARGE is asserting one point from a distribution.

## Where, per family

| family | middle | lower third | upper third | full frame |
|---|---|---|---|---|
| text | **61%** | 19% | 10% | 8% |
| card | 47% | 13% | 20% | 20% |
| cutaway | 45% | 8% | 2% | **45%** |

## When each family belongs — by beat purpose

| family | dominant purposes |
|---|---|
| cutaway | **evidence 61%** · turn 11% · claim 9% |
| card | evidence 45% · close 27% · turn 10% |
| text | evidence 33% · claim 24% · turn 12% · close 11% · hook 10% |
| cut | evidence 27% · claim 20% · close 19% |
| **sfx** | **hook 35% · close 28%** — the bookends, not the middle |
| zoom | hook 50% · evidence 50% |

sfx is the sharpest: it is a **hook-and-close** device in the references, and
the platter offers it with no such steer.

## What this atlas CANNOT say

- **TIMING RELATIVE TO WORD ONSET IS NOT AVAILABLE.** Zac asked for it and the
  corpus records carry no word-level transcript — only beat spans and
  `card_text`. Every timing figure here is relative to a **shot change**
  (`provenance.mechanical_cuts`), which is a cut in the FINISHED edit. Getting
  the word-onset figure needs a per-reference transcript that is not on disk.
- **The text shape split (plain / card / strip / lower-third) is only partly
  answerable.** `text` vs `card` is a real family split in the annotation, and
  `where` gives lower_third at 19% of text — but "strip" is not a recorded
  value, so a three-way shape split would be invented.
- **cut, sfx and zoom have no control re-read**: their where/size/hold_s are
  unmeasured, not zero.
- **THE PER-FAMILY PLACEMENT COUNTS IN THIS FILE ARE SUPERSEDED** by
  `measured/REFERENCE_RATES.json` in the worker repo, which is the one table.
  They are left in place because the per-family SHAPE readings here (where,
  size, hold_s, over_subject) are the atlas's own contribution and still stand —
  but any RATE taken from these counts is superseded, and the reason is bigger
  than the denominator that was being argued about: the 294 beats are TWO
  ANNOTATORS with ZERO shared vocabulary, not two readings, so the totals here
  never could reconcile and averaging them produced rates for families one
  annotator had no word for.
- **Provenance caveat, on the record:** the shipped 153-beat index cannot have
  come from the shipped annotator, so its own origin is not fully established.
  The mechanical_cuts are detector output and are solid; the beat purposes and
  treatments are a model's readings.
