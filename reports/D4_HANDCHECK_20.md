# Hand-check of 20 stratified dark decisions — the false-positive rate

**Method.** 20 decisions pulled stratified across verdict, class and language,
joined back to `video_jobs.vibe_input` (93.9% of rows join). I read each brief
IN FULL — not the 300-char preview — and judged the verdict myself against the
lane's scope rules. Unsafe briefs are judged and **never reproduced**.

**Strata:** 11 NEGOTIATE (up to 3 per class, all 5 classes), 4 REFUSE (all of
them), 5 PASS (4 longest/non-English + the single `uncertain` row).

---

## THE HEADLINE: 4 OF 11 NEGOTIATIONS ARE FALSE, AND 3 OF 4 ARE ONE CAUSE

> **A NEGATED ASK IS BEING READ AS A REQUEST.**
>
> Zac's precedence ruling — *a negated ask is a CONSTRAINT, not a request* — is
> not reaching this classifier. Three of the four false positives are a user
> saying **do not do X** and being told **we cannot do X**.

The worst instance appeared **twice** (same hash, resubmitted). The brief carries
an explicit block:

    DO NOT ADD:
    * B-roll
    * Stock footage
    * Music
    * Sound effects
    ...

and was classified `stock_broll` / NEGOTIATE. We would have opened a negotiation
about stock b-roll with a user whose brief is a list of things not to add. That
is worse than a silent drop: it is an interruption that proves we did not read
the sentence.

The second: a brief whose IMPORTANT line is *"Do not alter my face or make me
look AI-generated"*, classified `generative_vfx`. The user is refusing the
feature we would offer to negotiate about.

The fourth false positive is a different cause: a user pasted their own recipe
SCRIPT and wrote *"this is the voice over i want all written in caption"* — they
are handing us narration to CAPTION, and asking for typing/cursor SFX we
actually have. Classified `voiceover_tts`. Nothing in it is out of scope.

## Rates

| stratum | checked | correct | false | rate |
|---|---|---|---|---|
| NEGOTIATE | 11 | 7 | **4** | **36% false positive** |
| REFUSE | 4 | 2 | 2 disputed | see below |
| **actioned total** (NEGOTIATE+REFUSE) | **15** | 9 | **4 clear + 2 disputed** | **27% clear, 40% incl. disputed** |
| PASS | 5 | 2 | **3 false negative** | **60% false negative** |

**The false-positive rate Zac asked for: 27% of actioned verdicts (4/15), or 36%
of negotiations alone (4/11).**

## THE PASS STRATUM IS WORSE THAN THE NEGOTIATE STRATUM, AND IT IS ALL NON-ENGLISH

Three of the four PASS rows I checked contain a plainly out-of-scope ask that
was missed, **and all three are non-English**:

| lang | what was asked | should have been |
|---|---|---|
| Spanish | replace the background with a wall, floor and bed, "all realistic" | `generative_vfx` |
| Hindi (Latin script) | "video quality HD kar dena" + "comedy memes laga dena" | `upscale_quality` |
| Arabic | "موسيقى مافيا" — mafia MUSIC | `music` |

This is the same blind spot as the unsafe regex, one layer up: **the scope
classifier under-detects out-of-scope asks when the brief is not in English**,
and 21% of briefs are not in English. A silent PASS is exactly the failure this
lane exists to eliminate — the render is spent and the ask is never mentioned.

The fourth PASS (Turkish) asks for freeze-frames and a screen shake, which no
class covers. PASS is defensible against the current taxonomy, but it is a
**taxonomy gap**, not agreement.

## The four refusals

Two are unambiguous and are recorded categorically, not quoted:

- **Bengali** — depicting violence against a child, with effects. **Correct, and
  the single most important row in the window**: the unsafe regex is English by
  construction and could not have matched it at all.
- **English** — swapping the faces of people in the video for faces from supplied
  reference images. Canonical non-consensual face replacement. **Correct.**

Two I dispute, and they want a ruling rather than my judgement:

- Two English briefs asking to reshape **the uploader's own body** ("make me look
  curvy", "waist a bit thinner") plus recolouring their own clothing. Both were
  REFUSED as unsafe. I read them as **out of scope, not unsafe** — a generative
  beauty/body feature we do not have, which is a NEGOTIATE. Refusing them tells
  a user their ordinary request is impermissible.
  **This needs Zac's ruling**: is body reshaping of the uploader themselves
  UNSAFE, or a `generative_vfx` negotiation? The classifier currently says
  unsafe, and at 2 of 4 refusals it is the majority of our refusal volume.

## What I would change, in order

1. **The negated-ask precedence rule is not implemented.** It is 3 of 4 false
   positives and the single highest-value fix. A "DO NOT ADD" list is not a
   request list, and the classifier must see the scope of the negation, not the
   family word inside it.
2. **Non-English scope detection.** 3 of 3 non-English PASS rows I read carried a
   missed out-of-scope ask. The safety adjudication is already model-based and
   catches non-English; the SCOPE classification is where the gap is.
3. **The body-reshaping ruling**, because it decides half our refusals.

## What this does not say

Twenty rows is a sample and the strata are deliberately unbalanced — I took ALL
refusals and over-weighted non-English PASS precisely because that is where the
damage would be. **These rates are not the population's rates**: the NEGOTIATE
false-positive rate is measured on 11 of 26, the PASS false-negative rate on 5
of 69 and chosen adversarially. Read them as "this class of error is present and
common", not as "27% of production is wrong".
