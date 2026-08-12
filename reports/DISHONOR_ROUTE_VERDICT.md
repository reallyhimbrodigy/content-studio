# DISHONOR BY ROUTE — the verdict that aims the flip

**JUDGE, 2026-08-11. The decisive question: does the dishonor cluster
(transitions, text_overlay, broll, motion_graphics) live on the LEAN side or
the PREMIUM side? The answer decides whether launch commits to the unified-core
flip or to a generalized component-ask override.**

## VERDICT: LEAN dominates. Aim the GENERALIZED COMPONENT-ASK OVERRIDE, not the unified-core flip.

Clean cohort — **pre-outage only** (06-25 → 08-08T11:00Z), because premium
routes died at 08-08T11:16Z and any window past that compares premium against
an empty denominator.

| class | lean | premium | standard |
|---|---|---|---|
| transitions | **86%** silent (n=22) | 45% (n=20) | 77% (n=79) |
| text_overlay | **93%** (n=43) | 97% (n=67) | 48% (n=126) |
| broll | **94%** (n=16) | 83% (n=12) | 54% (n=107) |
| motion_graphics | **96%** (n=134) | **37%** (n=79) | 52% (n=437) |
| **CLUSTER TOTAL** | **94.0% (n=215)** | **63.5% (n=178)** | **54.5% (n=749)** |

`lean` = minimal + minimal_speech_uncut · `premium` = moodreel + hype ·
`standard` = standard_editorial. Full-window numbers move <2 points on lean and
standard and are identical on premium (it has no post-outage rows), so the
finding is not a window artifact.

**The single most decisive cell: motion_graphics is 96% silent on lean and 37%
on premium.** Premium is the *best*-performing route on the very capability
that is the product's #1 named ask. **The unified-core flip aims at the side
that is already the least broken.** By absolute loss the ordering is the same
story: standard ≈408 silent drops, lean ≈202, premium ≈113 — the override
serves the two biggest pools; unified core serves the smallest.

## The alternative explanation, tested and REJECTED

Lean routes are *designed* to strip components, so "of course they drop
component asks" is a legitimate defence. It fails on two measurements:

1. **Lean is not a rare destination for these asks.** 159 of 790 pre-outage
   lean jobs (**20.1%**) carry a cluster ask. One in five lean jobs has a user
   asking for something the route will refuse.
2. **The user is never told.** Cluster verdict mix on lean: **94%
   DROPPED_SILENTLY, 4% DROPPED_WITH_NOTE, 1% HONORED.** Premium tells or
   honors 32% of the time; standard 46%.

A route that structurally cannot honour an ask is defensible. A route that
silently discards one in five users' explicit requests is not — it is the
"fail loudly to us, never to the user" law broken 94 times out of 100, and the
same defect class as patchy captions. **Whatever the fix, the floor is that
lean stops dropping in silence.**

## What this means for launch

- **`PROMPTLY_UNIFIED_CORE` is not the honor-rate lever.** Flip it on its own
  merits (premium composition identity), with my fulfillment gate as usual —
  but do not expect the honor rate to move, and do not spend the launch window
  on it believing it will.
- **The generalized component-ask override is the lever**, and it must apply on
  lean routes to matter. My acceptance bar: cluster silent-rate on lean
  94% → <20%, measured on ≥150 post-flip cluster asks, with a matching honest-
  note rate rise if any asks remain structurally unhonourable.

---

# Splitting `other` — 502 asks, 86.1% silent, and it is mostly ONE thing

| sub-class | n | share | silent | noted | unsupported | honored |
|---|---:|---:|---:|---:|---:|---:|
| **upscale_quality** | **233** | **46%** | **96%** | 0 | 5 | 5 |
| still_unclassified | 212 | 42% | 83% | 2 | 2 | 33 |
| appearance_retouch | 22 | 4% | 59% | 0 | 1 | 8 |
| fidelity_preserve | 18 | 4% | 50% | 0 | 0 | 9 |
| generative_content | 9 | 2% | 78% | 0 | 0 | 2 |
| strategy_meta | 4 | 1% | 75% | 0 | 0 | 1 |
| translate_lang | 3 | 1% | 67% | 0 | 0 | 1 |

**Nearly half of `other` is one coherent product gap: users asking for
resolution/quality they cannot get.** "make it 4k", "8k quality", "make the
video hd", "sharpening", "apply ai-powered sharpening, noise reduction,
texture enhancement", "add better quality". Of 233 such asks, **5 were honored,
5 were marked unsupported, and 223 vanished without a word.**

**The fix already exists and is dark: SEAM's `PROMPTLY_UPSCALE_NEGOTIATE`**
(the honest upscale-negotiation path). This is its evidence base — it is not a
speculative seam, it addresses 46% of the largest unlabelled dishonor bucket
and 233 real user asks. It should be treated as an honesty fix (say what we
can and cannot do), not a capability bet.

`still_unclassified` at 212 is my classifier's honest residue, not a finding —
it is a genuine long tail (lighting, quote-writing, beat-sync, "avoid
over-editing"). Its 33 honored asks show it is mixed, not uniformly broken. I
am not proposing sub-classes for it until the taxonomy owner (the judge prompt)
gets a pass; naming classes from a keyword regex I wrote is how a taxonomy
starts lying.

## Method

`fulfillment_scores` (4,115 judged jobs, 8,818 asks), paginated. Route groups
as defined above; ask classes as the judge assigned them. Sub-classes assigned
by disclosed keyword regex — **stated as a classifier, not as ground truth**;
the 42% residue is reported rather than force-fit. $0, no LLM, no Modal.
