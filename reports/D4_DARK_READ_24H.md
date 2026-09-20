# The 24-hour dark read — 99 decisions on live traffic

**Window** first row 2026-09-19 17:26:29Z (11 minutes after a122697 deployed) to
2026-09-20 20:13:05Z — **~27 hours**. 99 decisions, 94 distinct jobs, 84 distinct
request hashes. `flag_state = DARK` on every row: nothing downstream reads the
verdict, no user saw a negotiation, no render was withheld.

## The headline

> **THE REGEX REFUSED NOTHING. THE MODEL REFUSED FOUR — AND ONE OF THEM WAS IN
> BENGALI.**
>
> `decider = 'model'` on all 99 rows. A regex refusal returns early and records
> `decider = 'regex'`; that never happened. Every one of the four unsafe briefs
> in this window was caught by the model and would have passed the scan.

This is Zac's "unsafe is never regex-only" ruling with a production denominator
under it. It was ruled on an argument; it is now measured. The Bengali refusal is
the sharpest case — the unsafe regex is English by construction, so that brief
was not marginally missed, it was **unmatchable**.

## Verdicts

| verdict | n | share |
|---|---|---|
| PASS | 69 | 70% |
| NEGOTIATE | 26 | 26% |
| REFUSE | 4 | 4% |

## What people actually asked for that we cannot do

All 26 negotiations, by class:

| class | n | share of negotiations |
|---|---|---|
| **stock_broll** | **17** | **65%** |
| generative_vfx | 3 | 12% |
| upscale_quality | 2 | 8% |
| music | 2 | 8% |
| voiceover_tts | 2 | 8% |

**Two thirds of everything worth negotiating is one class.** If only one
negotiation sentence is ever written, it is the stock-b-roll one.

## The instrument's own health

| | |
|---|---|
| `safety_state = MEASURED` | **99 / 99** |
| `degraded = true` | **0** |
| REVIEW_UNAVAILABLE fired | **never** |
| `uncertain = true` | 1 (Urdu, PASS) |

The model was reachable on every single call. The fail-closed path and the
owner alert are therefore **UNEXERCISED IN PRODUCTION** — they are proven by
their red proofs and by nothing else. That is a gap, not a pass: a path that has
never run is not a path that works.

## Language — 21% is not English

English 78 · Spanish 5 · Hindi 4 (incl. 2 Latin-script) · Arabic 2 · Persian 2 ·
Bengali 1 · Hebrew 1 · Polish 1 · Russian 1 · Urdu 1 — **13 languages, 21%
non-English**, and one of the four refusals is in a non-Latin script.

## Privacy, verified rather than asserted

`sentence` holds **26 non-empty values but only 5 DISTINCT** across 94 distinct
jobs, 126–194 chars, all templated. If it carried user brief text the distinct
count would track the row count. It is model output from a small fixed set.
Brief text is never stored; `request_hash` is a sha256. Checked independently by
FRONTEND and by me.

## What it costs, since it runs per job while dark

One Haiku 4.5 call per brief. No prompt caching, so the fixed block is re-sent
every call:

| | tokens | |
|---|---|---|
| system (UNSAFE_SYSTEM) | ~338 | re-sent every call |
| tool schema (UNSAFE_TOOL) | ~121 | re-sent every call |
| brief (avg 462 chars, p50 97) | ~122 | capped at 4,000 chars |
| output (tool_use verdict) | ~60 | max_tokens 300, never approached |

At $1/M in and $5/M out: **~$0.00088 per job** → **~$0.087 for the whole
27-hour window**, **~$0.08/day** at the current ~90 briefs/day, ~$2.40/month.

Prompt caching would make the 459-token fixed block a cache read at $0.10/M and
cut it roughly in half. **Not worth doing at this volume** — the saving is four
cents a month — but it is the lever if this ever runs on 10x traffic.

## What I got wrong, on the record

I told FRONTEND this was "a file and not yet a table … waits on Zac's go." It is
a table, it has been writing for 27 hours, and they checked and corrected me.

The error was not the fact, it was the INFERENCE: I reasoned from *I have not
applied it* to *it has not been applied*. That is an absence-of-action inference
— the same shape as reading an empty result as a clean one — and it is wrong
exactly when someone else acts, which is the normal case in a multi-lane repo.
Nothing in my code creates the table and no deploy step runs migrations, so it
was applied deliberately by someone else, as the plan said it would be.

**The check was one query.** `to_regclass('public.negotiation_decisions')` costs
nothing and I asserted instead.
