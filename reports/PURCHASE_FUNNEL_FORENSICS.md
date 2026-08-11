# PURCHASE-FUNNEL FORENSICS — where the 291 starts die

**Lane 1 / JUDGE, 2026-08-11. Sources: all 568 purchase events (291 started / 271 failed / 6 completed), `profiles` RC truth, `video_jobs`, both analytics identities. Read-only. `[MEASURED]` throughout unless tagged.**

## VERDICT: the leak is not technical. It is the offer.
Per-user funnel (196 users with a `user_id` who tapped buy):

| outcome | users | share |
|---|---|---|
| **PAID** (RC truth in profiles) | 6 | 3.1% |
| **APPLE SHEET ABANDONED** (`billing_error:"user_cancelled"`) | **186** | **94.9%** |
| real billing error (RC #2/#20) | 1 | 0.5% |
| silent (started, no fail/complete, never paid) | 3 | 1.5% |

- **No /sync failure. No webhook gap.** Every profile-payer is RC-consistent; all 6 event-era payers fired `purchase_completed` (the "6 all-time" that looked broken is exactly the number of event-era payers — the event works). The 8 additional payers with no purchase events pre-date commerce instrumentation (2026-07-17) `[INFERRED from event birth + profile ages]`.
- **The Apple sheet is where 95% die, by their own tap.** `purchase_failed` carries the reason: 263/271 = `user_cancelled`; only 8 real billing errors all-time (5× RC#20, 3× RC#2).

## Cuts
**By plan:** started — yearly 184 (63%) / weekly 91 / monthly 16. But **every non-trial purchase ever is WEEKLY (7/7)**; yearly + monthly converted only to trials, and **all 7 trials lapsed to free (0 trial→paid conversion)**. Users reject the yearly commit at the sheet, and trials never stick; weekly converts directly and 3/7 weekly payers are currently active. **The sheet-level evidence says: the SKU users will actually pay for is weekly; yearly is what they're being pushed toward and where they bail.** `[MEASURED]`

**By date:** starts spike with paywall pressure, not with any pricing change — 08-04 (18 starts / 1,456 wall-views / 588 free-limit-hits) and 08-07→08-08 (73+58 starts / ~1,400 wall-views / ~650 limit-hits each) track the volume spikes; the wall-view→start rate holds ~1.3–5%. `[MEASURED]` No evidence of a paywall config change on 08-07 — it was traffic. `[INFERRED]`

**What abandoners do next** (n=40, both identities + DB truth): **75% remain active** in the app after dismissing the sheet, **but only 15% create another job and 1/40 ever re-attempts purchase.** They don't rage-quit; they hit the free limit, decline the price, and go passive. `[MEASURED]`
*Instrumentation defect found doing this:* post-cancel events log under `anon_user_id` with `user_id` NULL — a naive user_id-only cut reads "100% churned." Frontend should carry the user_id through post-paywall sessions. `[MEASURED]`

## THE PAYER PROFILE (all 14 ever-payers, from our own data)
- **They buy on day zero.** Median days from first upload → purchase-start = **0.0** — every measurable weekly payer bought the same day they arrived. Nobody "grew into" paying. The purchase decision is made before or at first contact with the product's value.
- **They are standard-editorial (talking-head) creators:** 44/53 of their completed jobs (83%) ran the full editorial route; near-zero moodreel/lean.
- **They write specific, commercial briefs, not preset taps:** "edit it like influencers for YouTube skincare", "elite business video editor" prompt-briefs, "dynamic Instagram Reel between 25 and 30 seconds", "Make a UGC ad", corporate promos. Payers are business/creator-economy users with revenue intent.
- **Speed did not gate payment:** median first-render e2e among payers was 213s, one paid after a 904s first render (the callback-wall artifact). They paid anyway — intent tolerance is high at purchase time. `[MEASURED]`
- **Power users cluster:** the two heaviest (31 jobs/10 exports; 11 jobs/10 exports) account for 20/25 payer exports.
- **A churn wound:** one weekly payer ran **17 jobs, 0 completed** — paid, failed 17/17, now lapsed. A paying user with a 100% failure rate is the single worst retention event in this data. Worth a name-level look by the reliability lane (id `c86582f1…`).

## What would move the number (ranked by this data)
1. **The offer at the sheet** — 186 users/3 weeks decline at the price sheet while yearly-first is pitched; weekly is the only SKU that has ever converted normal. Test weekly-first presentation.
2. **Trial design** — 7/7 trials lapsed; the trial cohort's product experience (5 of 7 have ≤5 jobs) never reached habitual use.
3. **Post-decline re-engagement** — 75% stay in-app but only 15% render again: the free-limit wall ends usage without converting it. The re-offer moment (next limit-hit) is currently identical to the first.
4. Fix the post-paywall identity split so this funnel stays measurable.

---
## Rider 1 — H0 MG re-extraction: NULL CONFIRMED, the 62% ships
Both keys checked across ALL recipe eras: `emphasis_moments[].motion_graphic` = **0** occurrences in the oldest 60 full recipes AND 0 in late-July (38) AND 0 in recent (18); top-level `motion_graphics` is the only persisted key in every era (42/60 oldest populated). The MG evidence extraction was correct; **motion_graphics 62% silent-drop stands** (unlike zoom, whose key really was elsewhere — that fix is already in judge v2). `[MEASURED]`

## Rider 2 — segment slice results (recap)
2,492 jobs judged, $8.57 (≈ the ~$8 approval, +7%). Cumulative judge spend $17.48. Complete back-catalog, zero gap: **4,099 jobs / 8,780 asks — honor 49.7%, dropped-silently 36.6% (custom 38.1%)**. Outage days annotated (08-08 partial → ongoing; fulfillment cost of the outage ≈ 18 points of honor rate).
