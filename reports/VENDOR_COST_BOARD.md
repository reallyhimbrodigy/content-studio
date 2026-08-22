# VENDOR COST BOARD — $/delivered video, all-in. Half the bill is in a vendor nobody has named.

**JUDGE, 2026-08-22. Denominator: 4,723 completions/month (155/day measured over
8 days). Every figure is per DELIVERED VIDEO, not per Modal job.**

## The board

| vendor | $/mo | **$/delivered video** | source |
|---|---:|---:|---|
| Modal | $1,050 | **$0.222** | `[OWNER]` — cross-checks my measured ~$0.21 all-in |
| **Gemini / Vertex** | **$1,000** | **$0.212** | `[OWNER]` |
| PostHog | $280 | $0.059 | `[MEASURED]` — 100% session replay |
| **subtotal, known** | **$2,330** | **$0.493** | |
| **owner-reported total** | **$5,000** | **$1.059** | `[OWNER]` |
| **UNACCOUNTED** | **$2,670** | **$0.565** | **53% of the bill** |

**The all-in cost is ~$1.06 per delivered video against a $0.10 cost law — 10.6x
over.** Modal, the line the whole campaign has optimised, is **21% of it.**

## The headline: the named vendors cannot fill the gap

I was asked to measure S3/CloudFront first. **I did, and they are not where the
money is** — so the more useful finding is that measuring them precisely would
not have moved the board.

Egress scales with **views**, and views are measurable: **2.91 views per
delivered video**, 13,760/month. Sensitivity rather than a point estimate,
because video byte-size is not in the DB:

| assumed size/view | GB/mo | CloudFront @ $0.085/GB |
|---|---:|---:|
| 15 MB | 202 | **$17** |
| 50 MB | 672 | $57 |
| **150 MB** (10x my estimate) | 2,016 | **$171** |

| other named vendors | measured input | estimate |
|---|---|---:|
| S3 storage | 4,723 new videos/mo | ~$2/mo added, accruing |
| Deepgram | **2,359 audio min/mo** `[MEASURED]` | ~$10/mo |
| Supabase | Pro plan + usage | ~$25–100 |
| Render | one service | ~$25–85 |

**All five together, generously: ~$300–500/mo. The gap is $2,670.** Even at a
10x-inflated egress assumption the named vendors reach roughly a fifth of it.

**`[INFERRED, HIGH CONFIDENCE]` ~$2,200–2,400/month is being spent with a vendor
that has not been named in this task.** Candidates nobody has ruled out: App
Store / RevenueCat commission (15–30% of revenue, which is a real line on an
owner's total even though it is not infrastructure), a second AI vendor, or
Apple developer/infra costs. **This is the single highest-value question on the
cost board and I cannot answer it from here — it needs one look at the itemised
bill, exactly like the PostHog breakdown that turned $280 from a mystery into a
one-line fix.**

## Gemini — measured tokens do NOT reconcile with $1,000/mo, and that gap IS the lever

**Measured, n=69 jobs carrying `gemini_tokens`:**

| term | p50 | mean | max |
|---|---:|---:|---:|
| prompt | **92,555** | 112,613 | 279,033 |
| cached | 42,809 | 43,269 | 85,630 |
| **uncached_delta** | **49,740** | 69,345 | 236,606 |
| output | 1,790 | 1,765 | 4,067 |
| n_calls | 1 | 1 | 2 |

At **100% penetration** that is 437M input + 8.5M output tokens/month:

| tier | input | output | **total** |
|---|---:|---:|---:|
| Flash | $44 | $3 | **$47/mo** |
| **Pro** | $546 | $85 | **$631/mo** |

**Three facts that do not fit together, and the mismatch is the finding:**

1. **Only 69 of 1,243 completions (5.5%) carry a Gemini call at all.** At 5.5%
   penetration, $1,000/mo implies **$3.85 per editorial call** — roughly 6x what
   Pro-tier pricing produces even at *full* volume. Something is billing that
   `gemini_call` does not record.
2. **Pro-tier at full penetration lands at ~$631/mo — the right order for
   $1,000. Flash-tier lands at ~$47/mo, off by 21x.** So the bill is only
   consistent with **Pro-tier pricing at near-full penetration**, which means
   the Flash A/B is worth **~$580/mo (~$7,000/yr)** — larger than every Modal
   lever ranked to date, combined.
3. **Cache coverage is 46%** (42,809 of 92,555). **49,740 tokens are re-sent
   uncached on every call.** Raising coverage toward ~90% cuts input spend
   roughly in half independently of model tier.

## Ranked — and nothing else gets built until #1 is answered

| # | lever | est. annual | status |
|---|---|---:|---|
| **1** | **Name the unaccounted $2,670/mo** | **~$32,000** | one look at the itemised bill |
| **2** | Gemini Pro → Flash (the pending A/B) | **~$7,000** | measurement designed, unrun |
| **3** | Gemini prompt cache 46% → ~90% | **~$3,300** | unbuilt |
| 4 | PostHog replay sampling 10% | ~$3,024 | one config line |
| 5 | Modal dark seconds | *unmeasured* | see below |
| 6 | L1/L2 | $567–756 | designed |
| 7 | post-upload watchdog | ~$600 | **already built** |

**#2 and #3 are not additive** — both act on the same token spend; sequence and
re-measure. **#4 is independent of everything** (different vendor, different
mechanism).

**Modal dark seconds is UNRANKED because it is unmeasured**, and I will not rank
it on a guess. It needs non-job container seconds cut against job seconds — the
same `modal app history` + per-function split that produced the 72.3%
orchestration share, re-run on the current regime. **It is one measurement from a
decision, and that measurement is not yet done.**

## Two caveats that bound this whole board

- **Every $/video figure uses a suppressed-editorial denominator.** Editorial
  went live 08-21 at 11.8% penetration. **Gemini's $/video will RISE as
  penetration rises** — possibly to full Pro-tier rates on 100% of jobs, which
  would take Gemini from $0.212 to a materially higher line. This board re-fits
  at the same gate as the latency decomposition.
- **The fps result is still pending** and is not in these numbers.
