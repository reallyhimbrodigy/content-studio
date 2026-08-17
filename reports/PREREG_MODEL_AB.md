# PRE-REGISTRATION — current editorial model vs Gemini 3.7 Flash on the frozen goldens

**JUDGE, 2026-08-16. WRITTEN BEFORE ANY RESULT EXISTS.** Every threshold below is
fixed now. Nothing here may be revised after seeing a number.

## THE HEADLINE FINDING OF THIS PRE-REGISTRATION — the corpus is underpowered for the honor-rate question

25 sources × 2.14 asks/job (campaign mean) ≈ **54 asks**. At a 49.6% baseline:

| design | detectable difference |
|---|---|
| **unpaired** | SE 9.7pp → **needs ~19pp** to clear noise |
| **paired (McNemar), 20% discordant** | ~11 discordant pairs → **MDE ~12pp** |
| paired, 30% discordant | ~16 pairs → MDE ~15pp |

**An unpaired honor-rate delta below ~19pp is indistinguishable from corpus
noise, and 19pp is larger than any plausible model difference.** So:

> **BINDING: the honor-rate comparison must be PAIRED — same sources, same asks,
> per-ask verdicts compared within source.** An unpaired A/B on this corpus
> cannot answer the question it is being run to answer, and reporting one would
> be a number with no power dressed as a result.

Even paired, **a delta under 12pp is NOT a result.** Registered bands:

| honor-rate delta (paired) | reading |
|---|---|
| **≥ +12pp** | real improvement |
| −12pp … +12pp | **INDISTINGUISHABLE — report as "no detectable difference", never as "no difference"** |
| **≤ −12pp** | real regression |

## PER-COMPONENT DECLINE — a DIFFERENT KIND OF QUESTION, and the more valuable one

Scenes 0/779, brand copy 0/2, payoff 0/253 are not rates to compare. They are
**zeros**, and at 25 sources:

> **0 of 25 has a 95% CI upper bound of 11.3%.** The corpus cannot distinguish
> "never" from "up to ~11% of the time".

**Therefore the per-component test is an EXISTENCE test, not a rate test:**

- **ANY non-zero emission of scenes, brand copy or payoff = the largest quality
  result of this campaign.** It is an existence proof that the capability is
  reachable by a model, which converts "the planner declines what it's offered"
  from a property of the system into a property of *one model*. One emission is
  enough. The RATE is not estimable at n=25 and must not be quoted.
- **All four remaining at zero = the thesis survives a real test**, and is
  equally valuable: it means the decline is not model-specific, and the next
  question is the prompt/schema rather than the model.

**MG is the exception and must be read differently** — it has a measurable
baseline (62% dropped), so it *is* a rate comparison, and it inherits the same
power problem: **~18pp unpaired, ~12pp paired**. An MG improvement below that is
not a result.

## THE MIXED RESULT — pre-named, because it is the likeliest and the most abusable

The likeliest outcome is: honor rate moves a few points (inside the band), one or
two components move off zero, others do not. **Registered reading, fixed now:**

1. **Component existence dominates.** If any of scenes/brand-copy/payoff emits at
   all, that is the finding, and it stands **regardless of what honor rate did**.
   Existence at n=25 is strong; a sub-12pp rate delta at n=25 is nothing.
2. **A sub-12pp honor gain may NOT be used to support the model change**, even
   alongside a component win. They are separate claims on separate evidence, and
   bundling a powered result with an unpowered one to make the unpowered one look
   supported is the specific motivated reading this section exists to block.
3. **If components stay at zero and honor moves <12pp: the A/B is NULL.** Not
   "slightly better". Null.
4. Any component moving off zero **must be verified against the strip gates** —
   the same walk the build-lane runs did (`[two-pass] Dropping generated_scene:`
   absent). An emission that was stripped is not an emission.

## THE CONFOUND — what this design can and cannot support

**Two models, ONE corpus, 25 sources.** That supports:

- ✅ a **paired within-corpus** comparison on these 25 sources
- ✅ an **existence** claim (this model emitted a scene; that one did not)

It does **not** support:

- ❌ a population claim about live traffic — the goldens were *selected*, and 25
  is not a sample of the 4,115-job distribution
- ❌ a rate estimate for any near-zero component
- ❌ "Flash is better" as a general statement. The honest ceiling is **"on these
  25 sources, paired, Flash did X"**
- ❌ any cost or latency conclusion — different models, different token
  economics, and neither is measured here

**Corpus-specific risk:** the goldens are frozen and were chosen partly for
Hindi/multilingual coverage (6 hin, 3 eng, 1 spa, 1 ben, 14 unlabelled). A model
difference that is really a *language* difference would present as a quality
difference. **Registered control: report the paired delta split by `lang` before
reporting the pooled figure.** If the effect lives in one language stratum, say
so — that is a different finding with a different fix.

## THE WEEK'S LAW, APPLIED HERE

**A hypothesis that explains every observation is a reason to test cheaply, never
a reason to believe.** "The planner declines what it's offered" currently
explains scenes, brand copy, MG and payoff — all four. That is exactly the shape
that cost real time three times this week (shared quota, alias rotation, the zoom
`float()`), each fitting perfectly and each wrong. **This A/B is the cheap test.
Its power to refute is the point**, and a null result is a genuine outcome I am
registering as valuable in advance, not a disappointment to be explained away.

## SPEND

Judge runs over $3 priced first. This adjudication is DB reads + the existing
fulfillment judge over ≤25 sources — well under, and reported as an actual.
