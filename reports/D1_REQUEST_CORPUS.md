# D1 — the request corpus, 30 days

**3,840 jobs · 2,547 users · `vibe_input` on 100% · 2,341 distinct requests ·
window to 2026-09-18. Supabase read-only. $2.76 of Haiku.**

## The number this lane exists to produce

> **1,057 jobs — 27.5% of ALL jobs — asked for something the pipeline cannot do
> and returned `status = completed`.** An edit was delivered and the ask was
> ignored. That is **86.1%** of every out-of-scope request in the window.

For scale: the last measurement on this product (old Gemini pipeline, Aug 11)
was honor 49.7% / dropped-silently 36.6%. This is the same disease, measured on
the same traffic a month later, and the agentic lane's own number is still
uncomputed because **it has never run on a real request** — verified, not
assumed: `agentic_plan` is NULL on all 12,457 jobs ever, `pipeline` is only ever
"handler", and all 25 non-null `harness` values are our own arms.

## The negotiation backlog, ranked, with the precedence rule applied

A **negated** ask is a CONSTRAINT, never out of scope. Adjudicated PER TAG, not
per brief — the brief that prompted the rule NEGATES colour grading while
genuinely REQUESTING music and b-roll, so a brief-level flag would have thrown
away two real asks.

| tag | before | **after** | moved | completed | now a constraint |
|---|---|---|---|---|---|
| generative_vfx | 483 | **427** | −56 | 379 | 56 |
| music | 400 | **378** | −22 | 315 | 20 |
| aspect_ratio | 293 | **272** | −21 | 245 | 3 |
| stock_broll | 267 | **224** | −43 | 199 | 40 |
| upscale_quality | 185 | **180** | −5 | 150 | 3 |
| color_grade_lut | 203 | **164** | −39 | 144 | 39 |
| voiceover_tts | 146 | **97** | −49 | 83 | 35 |
| translation_dub | 41 | **27** | −14 | 15 | 13 |
| ai_avatar | 16 | **12** | −4 | 12 | 2 |
| other_oos | 5 | **5** | 0 | 4 | 0 |

Jobs with ≥1 out-of-scope ask: 1,277 (33.3%) → **1,227 (32.0%)**.
**141 tag-instances moved to CONSTRAINT, 27 to DESCRIBED, 681 stayed real asks.**
Both sources are stored (`oos_model`, `oos_scan`, `oos_roles` with the deciding
quote), so the disagreement stays countable.

## Request shape

| class | jobs | share |
|---|---|---|
| PRESET | 1,385 | 36.1% |
| STRUCTURED_BRIEF | 803 | 20.9% |
| PRESET_PLUS_MODIFIER | 752 | 19.6% |
| OUT_OF_SCOPE | 381 | 9.9% |
| NOT_A_REQUEST | 182 | 4.7% |
| SURGICAL_REEDIT | 153 | 4.0% |
| UNCLEAR | 122 | 3.2% |
| UNSAFE | 61 | 1.6% |

**641 jobs (16.7%) carry a NEGATIVE or a hard limit** — the second most common
thing in the corpus after a preset, and a violated constraint is a failure
however good the edit is. 297 (7.7%) ask a language change. 107 (2.8%) refer to
multiple clips.

**15.2% are not typed in English**: pt 106, hi-Latn 95, ar 55, hi 52, mixed 51,
id 39, es 33, ru 30, fr 21, ja 20, fa 17, de 14, pl 6.

Length: ≤30 chars 41.4% · 31–120 28.0% · 121–500 12.4% · >500 18.2%. 27.2% of
jobs are one of 6 preset strings.

## Calibration — six rounds, and the first scored 70%

The number is worth what the calibration is, so the failures are on the record:

1. **70%.** Nine misses, systematic not random: UNCLEAR over-applied to anything
   vague, NOT_A_REQUEST applied to briefs containing an imperative, negatives
   missed entirely, and a SURGICAL ask ("remove the name on the red clothes")
   not flagged as the object-removal it is.
2. Tightening the prose **fixed seven and introduced six** — including dropping
   "Just remove there clothes" from UNSAFE to merely out-of-scope, which would
   route a refusal into a negotiation. Still 70%.
3. **Forced booleans with explicit precedence** → 86.7%. Prose rules compete;
   a schema field does not.
4. Pinning two rules → **90.0%**, the gate.

Twice I nearly scored a CORRECTION as a regression. Reading the brief text
showed "Mute music" was a removal and another brief had no upscale token at all
— the model was right both times. **`\d{1,2}:\d{1,2}` matched TIMESTAMPS**, so
aspect_ratio counted "0:00", "2:00 min" and a Psalms quote at "52:2" — 13 false
positives in 290 before it was pinned to ratios that exist.

## The design the calibration forced

The model loses out-of-scope tags inside long briefs — it dropped a literal
"Add very subtle background music" from 3,735 chars. A regex cannot tell a
description from a request — "my vertical video" vs "make it vertical",
"Tamil-English mixed voiceover" (the user's own audio) vs "make him say hello".

**So the scan proposes and the model disposes.** Recall from the mechanical
pass, judgement from the model, both stored.

**A prediction I got wrong, recorded next to the result:** I expected the
adjudicated count to come in BELOW the scan. It came in ABOVE — generative_vfx
427 against the scan's 144 — because the model reads asks that carry no
distinctive token at all.

## Two failures in the measurement machinery, fixed

- **12 rows silently unjudged.** One contiguous batch of long briefs whose reply
  exceeded `max_tokens`; the retry re-sent the same oversized chunk and hit the
  same ceiling. A retry that repeats the failing shape is not a retry. Now:
  retry SMALLER, raise the ceiling, and throw loudly on any row still unjudged.
- **A run killed by `ECONNRESET`.** The retry covered HTTP 429/5xx but not
  transport-level throws, and the shell reported exit 0 because the output went
  through a pipe. Both fixed; final run 413/413, zero missing.
