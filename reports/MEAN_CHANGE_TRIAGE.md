# mean_change on held-frame cutaways — BROKEN DIMENSION, not a broken artifact

**JUDGE, 2026-08-21. Triage rule applied: broken dimension or broken artifact,
and do not assume the artifact. The references decide.**

## Verdict

**BROKEN DIMENSION, scoped.** `mean_change` is valid at ARTIFACT scope — that is
how it was calibrated — and invalid applied to a **held-frame cutaway
component**. `motion` is removed from `insert_scenes` in the applicability map.

## The evidence: the references fail it on their own cards

`MEAN_CHANGE_FLOOR = 0.6 × 0.0596` is 0.6x the **lower reference's WHOLE-VIDEO
mean**. A whole-video mean averages moving footage together with held cards, so
applying it to a single held segment tests a **static-by-design** component
against a bar built mostly out of motion.

Sliding 1.5s windows — the scale of a cutaway — with the floor recomputed at the
**same sampling rate** as the measurement:

| reference | windows below floor | minimum window | how far under |
|---|---:|---:|---:|
| **REF-2** | **40 / 84 — 47.6%** | 0.0001 | **368x** |
| REF-1 | 15 / 102 — 14.7% | 0.0002 | **126x** |

**Nearly half of REF-2's own windows fail the check.** The references are the
bar; a property the references fail is a broken property. Same ruling as
double-captions (refs 3.3% / 16.3%) and tail-frozen (refs 89% / 33%).

## The decisive part: it cannot tell pass from fail

A **correct** §4 insert scene — tilted photo, three depth planes, a designed card
that HOLDS — measures ~0.0001. A **broken** blank cutaway that shipped nothing
also measures ~0.0001.

**The dimension returns the same answer for the correct artifact and the
defective one. A check that fires identically on pass and fail is not a
detector**, and its RED on a held cutaway carries no information about the
artifact at all.

## Nothing is lost by removing it

The real class — *a card held too long* — is caught at **artifact scope by the §5
stillness ceiling (3.5s)**, where a duration property belongs and where both
references clear it (1.75s, 3.25s). Removing a non-diagnostic component check
does not open a hole; it stops a guaranteed false RED on a whole component
family.

What SHOULD score a held cutaway is §4's structure — tilt 5-8°, overlap and
occlusion, three depth planes, flat near-white ground. Those are unbuilt, and
they stay listed as unscored rather than approximated by a motion proxy.

## A latent trap found on the way — `mean_change` is NOT scale-free

The same video and the same formula give different values at different sampling
rates:

| rate | REF-1 | REF-2 | derived floor |
|---|---:|---:|---:|
| **4 Hz** | **0.0864** | **0.0596** | 0.0358 |
| 10 Hz | 0.0483 | 0.0331 | 0.0199 |

**A consistent 1.8x.** The 4Hz row reproduces `score_component`'s recorded
values exactly, so the dimension samples at 4Hz and its own numbers are right —
but **the floor is only meaningful against a measurement taken at the same
rate.** I compared 10Hz windows to the 4Hz floor on my first pass and got 57.1%
for REF-2; the method-consistent figure is 47.6%. The verdict is unchanged, the
number was not, and I would have published the wrong one.

**Filed as a standing hazard:** any future recomputation of `mean_change` at a
different fps silently changes the verdict without changing the code. If it is
kept, the rate belongs in the constant's name.
