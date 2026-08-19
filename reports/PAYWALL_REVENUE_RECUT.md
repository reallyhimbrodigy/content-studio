# PAYWALL RE-CUT — on revenue and LTV, not conversion count

**JUDGE, 2026-08-18. The count-based ruling is withdrawn. It pointed the wrong
way, and this shows by how much.**

## Gross by SKU (lifetime, all-time)

| SKU | price | paid | renewals | **gross** | $/wall-view |
|---|---:|---:|---:|---:|---:|
| weekly | $12.99 | 10 | 2 | **$155.88** | $0.0118 |
| **yearly** | **$399.99** | **1** | 0 | **$399.99** | **$0.0302** |
| monthly | $19.99 | 0 | 0 | $0.00 | $0.0000 |

Wall views (all SKUs shown on every wall): **13,241**.

## The three metrics disagree, and only one of them is revenue

| metric | weekly | yearly | winner |
|---|---:|---:|---|
| **conversion count** | 10 | 1 | weekly **10:1** |
| **gross** | $155.88 | $399.99 | yearly **2.6:1** |
| **revenue per wall-view** | $0.0118 | $0.0302 | yearly **2.6x** |
| **realised LTV per converting user** | **$15.59** | **$399.99** | yearly **25.7x** |

**One annual conversion out-grosses the entire weekly SKU's history — 2.6x — on
1/10th the conversions.** The count metric ranked weekly first by 10:1 and was
inverted on every revenue measure. Conversion-rate-per-wall-view is the number
that produced the wrong ruling; **revenue-per-wall-view is the one that should
drive plan ordering**, and LTV is what makes the gap enormous rather than merely
present.

## Retention — the asymmetry the count metric structurally cannot see

- **weekly: 5 expirations against 10 purchases**, and **2 renewals across 10
  subscriptions (20%)**. Realised LTV **$15.59** — barely above one period, which
  is what "churns inside week one" looks like in money.
- **yearly cannot churn for 12 months by construction.** Its $399.99 is banked
  revenue, not a projection.

A count-based comparison treats these as equivalent events. They are not: one is
a $12.99 payment with a ~50% chance of never recurring, the other is $399.99
that cannot lapse until 2027.

## THE CAVEAT THAT MUST RIDE WITH THIS — n = 1

**The entire yearly case rests on a single conversion.** No confidence interval
on n=1 is worth printing. What this analysis legitimately supports:

- ✅ the count-based ranking was **wrong in direction**, which does not depend on
  n — $399.99 > $155.88 is arithmetic
- ✅ revenue-per-wall-view and LTV are the correct metrics regardless of outcome
- ❌ it does **not** establish a yearly conversion *rate*, or that the next
  annual is likely
- ❌ it does **not** support "yearly converts better" — yearly converts **worse**
  (1 of 514 starts vs 10 of 224). It converts **rarer and larger**, and larger
  wins on this arithmetic.

**Price uncertainty, flagged:** the repo carries **both** `$399.99/yr` (8
mentions) and `$199.99/yr` (16 mentions). I have used $399.99 per the reported
conversion. **If that sale was at $199.99, yearly gross halves to $199.99 and the
advantage falls from 2.6x to 1.3x** — still the right direction, materially
smaller. The price should be confirmed from the RevenueCat record before this
figure is quoted externally.

## Method note

Counts come from `analytics_events` with **explicit per-event filters**. An
earlier unfiltered pass over the full table returned different totals (9 paid,
0 renewals) because it truncated; the filtered queries return 11 paid, 2
renewals. Prices are repo constants, not DB values — **no price or revenue field
exists on any purchase event**, which is itself the gap that made a count-based
ruling the path of least resistance.

**Standing request:** put the paid amount on `purchase_result`. Every revenue
figure in this report is repo-price × event-count; one field would make it a
measurement.
