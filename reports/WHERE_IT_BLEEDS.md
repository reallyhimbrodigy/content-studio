# WHERE THE PRODUCT BLEEDS — ranked by USER

**JUDGE, generated 2026-08-15T03:36:15.064Z by `scripts/bleeds.js`.** Job window 24h; funnel + fulfillment windows stated per section. Every line [MEASURED].

## 1. Failures — 24 users / 35 jobs (24h)

| class | users | jobs | share of failing users |
|---|---:|---:|---:|
| UPLOAD_NEVER_STARTED | 20 | 30 | 83.3% |
| DISPATCH_UNREACHABLE | 2 | 3 | 8.3% |
| TIER_CONCURRENCY | 1 | 1 | 4.2% |
| PLATFORM_TIMEOUT | 1 | 1 | 4.2% |

## 2. FAILED-JOB SECONDS — 41.7% of all job-lifetime seconds [7-DAY WINDOW]

**311 failed jobs / 275 users** over **7 days**, p50 lifetime **601s**, **44/day**. Total **182,174s** of user time spent on jobs that never delivered.

| quantity | jobs | seconds | share |
|---|---:|---:|---:|
| reached a worker (**Modal-billable**) | 22 | 18119 | 9.9% |
| never reached one (**$0 Modal, pure user wait**) | 289 | 164055 | 90.1% |

**USER-time and MODAL-time are different quantities and must not be blended.** A job with no `worker_started_at` and no `modal_call_id` never reached a container: it costs the user their whole wait and costs us **$0**. Here only **9.9%** of failed seconds were Modal-billable (~$0.49/day, **1.9%** of orchestration) — the rest is pure user loss at zero spend.

> **UNS does NOT move onto the cost board — the conditional FAILS.** [MEASURED] Of 263 `UPLOAD_NEVER_STARTED` jobs, **0 have `worker_started_at` and 0 have `modal_call_id`.** The ~601s wait is entirely client/server-side; nothing was ever dispatched. UNS is the **largest user-time loss on the board** (263 jobs × ~601s) at **zero Modal spend**, so it stays a **DELIVERY/product lever, not a cost lever.** Filing it beside orchestration would aim spend work at a class that spends nothing.

_The failure class that IS Modal-billable is `DISPATCH_UNREACHABLE` — 27 jobs, all with a call id, 19 reaching a worker, p50 904s — and it is 1.9% of orchestration, not a rival to it._

## 2b. Latency — n=141 completed (24h)

p50 **107s** (law 90) · p90 678s · p99 **1172s** (law 180) · max 1205s

| envelope class | n | users | p50 | p90 | max |
|---|---:|---:|---:|---:|---:|
| `C envelope LOST + repair` | 6 | 5 | **904s** | 1172s | 1172s |
| `B envelope LOST` | 56 | 45 | **321s** | 829s | 1205s |
| `A envelope FULL` | 79 | 79 | **60s** | 121s | 541s |

Worst/best class p50 spread: **15.1x** — the pooled number above hides it.

**ENVELOPE LOSS: 44.0% of completions (62/141), 50 users.** Regression BORN 2026-08-11T23Z after 8 clean days at 0.0% (08-04..08-11). The pooled p50 above sits between classes and describes NO actual user.

**STANDING DECOMPOSITION — this class is BIMODAL, not one mechanism.**

| cluster | n | share of affected | settlement path | queue p50 | envelope-absent |
|---|---:|---:|---|---:|---:|
| **180–240s** | 9 | 14.5% | `reconciler` 9/9 | 113s | 9/9 |
| **870–930s** | 5 | 8.1% | `repair` 5/5 | 470s | 5/5 |

Both clusters are ~100% envelope-absent, so **envelope loss is COMMON to both and is therefore NOT the discriminator** — they lose the envelope alike but settle by different paths at different times. The pre-registered hang test (`reports/HANG_TEST_RESULT.md`) REFUTED the single-mechanism reading: the ~900s band held only 13.7% of affected jobs while the largest mode sat at 180–240s. **Do not file one lever against this class until the two clusters are separated.**

> **QUALIFIER — binding wherever this class appears, in any report or board:** **users receive their video on BOTH paths.** `repair` reconstructs the completion from the S3 artifact; `reconciler` delivers at 180–240s. The damage is **cost, telemetry and tail latency — never lost deliveries.** Any framing implying users lose renders here overstates a class that is, from the user's seat, already mitigated.

_Mechanism SETTLED 2026-08-15: a LOST UPDATE on `result` jsonb (written, then clobbered by a later read-modify-write). Fix = CAS on `updated_at`. The worker-hang framing is retired._

| term | p50 | p90 | p99 | max |
|---|---:|---:|---:|---:|
| **QUEUE** (create→worker pickup) | 16.4s | 347.7s | 757.4s | 824.3s |
| **WORK** (pickup→complete) *envelope-FULL only* | 46.4s | 92.2s | 184.4s | 184.4s |

Queue is **15%** of e2e at p50; **46.8%** of jobs wait >30s before any work begins.

**Queue and envelope loss are NEAR-THRESHOLD, not merely correlated.** Of jobs queuing <30s, **100.0%** kept their envelope (0 of 75 lost it); of jobs queuing ≥30s, **93.9%** lost it. **94.9%** of envelope-FULL jobs queued under 30s. The relation is a step at ~15–30s, so "correlates with" understates it — below the knee loss is near-absent, above it near-certain.
_Direction is still open: queueing may cause the loss, or one upstream condition may cause both. The STEP SHAPE constrains any mechanism to something that switches at ~15–30s of queue._
_WORK is shown for envelope-FULL rows ONLY. Cross-class WORK is WITHDRAWN: for lost-envelope rows `completed_at` marks DISCOVERY, not work (repair Q+W pins to a ~constant while W ranges 278–846s; reconciler W has a 0.22s minimum). **QUEUE is the only valid cross-class term.**_
_Workload and client are RULED OUT as the split: source duration differs 1.24x by class (median 10.7s FULL vs 13.3s LOST) while queue differs 15.0x, and client version is identical (96% on 1.3.6(224) in BOTH classes). Do not re-litigate workload._
_Queue history begins 2026-08-11T19:50Z (the `worker_started_at` migration). There is NO pre-Aug-11 queue data, so "queue delay is new/worse" is [UNFALSIFIABLE] with current data._
On the 900s wall [870,920] — count: **5** of 141

## 3. Route mix (24h)

`none` 62 · `minimal` 46 · `minimal_speech_uncut` 29 · `moodreel` 4

Premium share: **2.8%** (4/141).

## 4. Delivery layer — since the column landed 2026-08-11T19:50:15Z (n=176 terminal)

`reconciler` 128 · `repair` 6 · `NULL` 33 · `callback` 7 · `durable_poll` 2

fallback_timer share **0.0%** — PASS bar met (~0).

## 5. Fulfillment — honor **49.6%** (target ≥70%) · dropped-silently **36.7%** (target <5%)

n=8818 asks over 4115 judged jobs (all-time table).

| ask class | n | honor | dropped silently |
|---|---:|---:|---:|
| style_preset | 3182 | 71.8% | **28.0%** |
| motion_graphics | 745 | 33.7% | **63.6%** |
| other | 502 | 12.0% | **86.1%** |
| sound_effects | 696 | 54.7% | **41.7%** |
| text_overlay | 311 | 21.2% | **75.9%** |
| zoom | 662 | 73.1% | **26.7%** |
| transitions | 158 | 21.5% | **75.9%** |
| broll | 178 | 20.8% | **65.2%** |
| pacing_speed | 293 | 60.4% | **38.6%** |
| specific_moment_edit | 173 | 30.6% | **64.7%** |

**Lever A — most aggregate honor to win (by volume): `style_preset`** — 891 silent drops of 3182 asks (28.0%). Fixing it moves the headline rate most.
**Lever B — most broken per ask (by rate, catch-alls excluded):** `transitions` 75.9% (n=158) · `text_overlay` 75.9% (n=311) · `broll` 65.2% (n=178). These are close — treat them as one cluster, not a ranked winner.
_Taxonomy note: `other` holds 502 asks at 86.1% silent — a bucket that large is itself a finding; it needs splitting before it can be targeted._

## 6. Purchase funnel — BY USER (7d)

wall_viewed **1499** → started **122** (8.1%) → paid **2** (1.6% of starters)
purchase_failed n=248, self-cancelled at the sheet **244** (98.4%) — the leak is the OFFER, not the funnel.

## 7. LUMEN campaign baseline — First Light [VERIFIED 2026-08-15]

| envelope | value | note |
|---|---|---|
| $/scene | **$0.14** | verified against raw call records |
| s/scene | **18.7s** (18.3s true median) | serial |
| scene failure rate | **0.0%** over 10 | credible: failure detector fired in-run (alpha 2/2 failed) |
| hero/alpha failure rate | **100%** (0 of 2) | **LAW 4 VIOLATION — BLOCKED from default path**; cost UNMEASURED |
| run total | $1.96 of a $2.00 ceiling | ceiling held |

**QUOTA CEILING — ~4 scenes.** Vertex image quota binds below **3.4 req/min**, serial. A 4-scene edit needs ~71s of quota time and ~75s wall in scene generation alone — **~60% of the 120s law**. It is a QUOTA ceiling, not a spend ceiling: the lever is a quota-increase approval, not a spend decision.
**Every Phase 2 number is quoted at n ≤ 4 scenes**; above that is [ABOVE-QUOTA-CEILING] and hypothetical until the approval lands.


### Acceptance rate (written / billed) — §3.2's dominant cost variable

| family | billed | delivered | acceptance | effective $/delivered |
|---|---:|---:|---:|---:|
| scene | 10 | 10 | **100.0%** | $0.14 (= sticker) |
| alpha *legs* (billed level) | 4 | 2 | 50.0% | $0.28 |
| alpha *attempts* (**delivered level**) | 2 | **0** | **0.0%** | **$0.56 spent, 0 delivered** |
| ALL | 14 | 10 | **71.4%** | **$0.196 = 1.40x sticker** |


**Per MODEL** — required alongside per-family once flash enters, because effective cost = sticker ÷ acceptance and the two models will not share an acceptance rate:

| model | billed | delivered | acceptance | sticker | **effective $/delivered** |
|---|---:|---:|---:|---:|---:|
| `gemini-3-pro-image` | 14 | 10 | 71.4% | $0.14 | **$0.196** |
| `flash` (not yet run) | — | — | [UNMEASURED] | — | [UNMEASURED] |

_Today per-model and per-family are the same cut: 14 of 14 First Light calls were `gemini-3-pro-image`. The dimension exists now so the flash comparison is never made on sticker price. **A cheaper sticker with worse acceptance can cost MORE per delivered artifact** — flash at $0.04 with 30% acceptance is $0.133 effective, barely under pro's $0.196; at 20% it is $0.20 and LOSES. The comparison is only valid acceptance-adjusted, and per family, since acceptance already differs 100% vs 0% ACROSS families on one model._

**The alpha family bills at LEG level but delivers at ATTEMPT level.** A 50% leg-acceptance reads harmless; the attempt-acceptance it produces is **0%**. Acceptance must always be measured at the level the USER receives, never the level we are billed — §2.1's gate is written against the *measured* rate, not the sticker rate.
_Effective cost = sticker ÷ acceptance. At 71.4% the run's true unit cost is 1.40x its sticker price._

### Break-even — on the measured ALL-IN cost  ✅ **hold RELEASED**

**Modal axis hold is LIFTED.** Invoice reconciliation landed: measured all-in **~$0.21/render**. That supersedes both of my earlier anchors — it is **9.5x the bottom-up job-compute term** ($0.0222, which never contained the non-job surface) and **2.3x BELOW** the $0.481 premium figure my first board used. The bottom-up model was wrong in both directions depending on which term you read; only the invoice settles it.

> **PROVENANCE [OWNER-SUPPLIED]:** the ~$0.21 all-in and the $0.37/day agent line come from the owner's invoice reconciliation. I could not locate the reconciliation document in either repo, so these are NOT [MEASURED-BY-ME] — the closest repo figure is RECON's bottom-up `$0.214 (orch-only)`, which is a model rather than an invoice and agrees only by coincidence of magnitude. **To upgrade to [MEASURED]: commit the invoice split (per-app, per-resource, with its cycle window) and I will re-derive both.**

#### THE ANCHOR — per-function split, **CYCLE-TO-DATE** (Aug 1–15, $597.99 / 14 days)

| function | share | $ cycle | $/day | $/render (cycle) |
|---|---:|---:|---:|---:|
| **orchestration** | **72.3%** | $432.35 | $30.88 | $0.1089 |
| rendering | **9.6%** | $57.41 | $4.10 | $0.0145 |
| validator | **9.1%** | $54.42 | $3.89 | $0.0137 |
| prewarm | **9.0%** | $53.82 | $3.84 | $0.0136 |
| TOTAL | 100.0% | $597.99 | $42.71 | $0.1507 |

**Orchestration is 72.3% — 7.5x the next largest slice.** This is the cost board's anchor: every cost claim files against a named function share, not a blended per-render figure.
_Shares and dollars above are **CYCLE-TO-DATE**, not a run rate. The cycle spans the volume regime change, so its $/day is a historical average; the current window runs lower (orchestration **$25.94/day** vs the cycle's $30.88/day, 84% of it — consistent with volume down ~47%)._

#### L1/L2 — the campaign's LARGEST CONFIRMED LEVER

L1 (cpu=4 while waiting) and L2 (no burst double-pay) act on **orchestration** — the 72.3% slice. Re-filed against the invoice rather than the marginal model:

| basis | orchestration $/day | prize $/day | prize per 14d | **prize $/year** |
|---|---:|---:|---:|---:|
| cycle-to-date (Aug 1–15) | $30.88 | $14.51–$18.22 | $203–$255 | $5,297–$6,650 |
| **CURRENT WINDOW** | **$25.94** | **$12.19–$15.30** | $171–$214 | **$4,450–$5,586** |

Both shown because they answer different questions: **the current window is the forecast** ($4,450–$5,586/yr is what the lever is worth going forward), **the cycle figure reconciles the invoice.** Same rule as $0.21 recent-slice vs $0.151 cycle-average — and the lever is the campaign's largest on either basis.

**My retired framing called L1/L2 "~4% of the bill."** Against the invoice it is **34–43%** — I was off by **8–11x**, and that error came from the unreproducible $87/day figure, exactly as its own source warned. Scale check: **eliminating any ONE other function entirely** — all of rendering, or all of validator, or all of prewarm — **saves only 26–28% of even the LOW L1/L2 estimate.** There is no second lever of comparable size on this board.

#### CYCLE-AVERAGE vs RECENT-SLICE — state which one, always

The billing cycle spans a **config change** (cpu 64→16, memory cuts, `min_containers` removal) AND a **volume regime change** (~250-460/day before ~08-11, ~150/day since). By the homogeneity rule above, a cycle-average over that window is not one population:

- **Cycle-average $/render** — what was actually billed across the whole cycle. Correct for *reconciling the invoice*, and the only figure that ties to a statement.
- **Recent-slice $/render** — the same measure over the current config and current volume. Correct for *forecasting and pricing*, because it is the only one that describes what the next render will cost.

**~$0.21 is used below as the recent-slice figure; the cycle average is $0.151** ($597.99 / 3,969 completed renders). The two differ by **1.39x**, and that gap is not an inconsistency — **it is the cycle/slice distinction, measured for the first time.** Cycle daily spend was $42.71/day at a mean 284 renders/day; recent volume is ~150/day at ~$31.50/day. **Spend fell 26% while volume fell 47%** — less than proportionally, which is precisely what a fixed component predicts. The two figures are consistent on different bases.
_A pricing ruling takes the recent slice; an invoice check takes the cycle average. Quoting one where the other belongs is the same error as averaging across the regime change in the first place._

#### Renders/month one subscriber's margin buys, at $31.50 net

| scenes | scene $ | + all-in $0.21 | $/render | **renders/mo** | scene share |
|---:|---:|---:|---:|---:|---:|
| 0 | $0.00 | $0.21 | $0.21 | **150** | 0% |
| 1 | $0.14 | $0.21 | $0.35 | **90** | 40% |
| 2 | $0.28 | $0.21 | $0.49 | **64** | 57% |
| 4 (ceiling) | $0.56 | $0.21 | $0.77 | **41** | 73% |

**Scene count still leads at n≥1 — but far less than my last board claimed.** At 1 scene the scene bill is **0.67x** the all-in render cost (not the 6x the bottom-up figure implied); at 4 scenes it is 73% of total. Both terms now matter, which is the honest shape: **compute is no longer a rounding error, and scenes are no longer the whole answer.**

#### FIXED — still covered by subscriber COUNT, not volume

$5.74/day today (~$172/mo), 24/7 ceiling $8.28/day (~$248/mo) → **~6 subscribers to cover fixed** (~8 at ceiling). Unchanged: fixed is a subscriber-count problem, never a per-render pricing problem.

| scenes | $/edit | vs $0.10 law | scene secs | vs 120s law |
|---:|---:|---:|---:|---:|
| 1 | $0.14 | 1.4x | 19s | 0.2x |
| 3 | $0.42 | 4.2x | 56s | 0.5x |
| 4 **(ceiling)** | $0.56 | 5.6x | 75s | 0.6x |
| 6 | $0.84 | 8.4x | 112s | 0.9x |

**Filed against §2.1's ≤$1/render PREMIUM budget** — NOT the $0.10 standard-tier law, which does not govern Lumen. Scene spend stays inside the premium budget through **7 scenes** ($0.98); at the registered 4-scene quota ceiling it is **$0.56 = 56% of budget — comfortably inside**. My earlier "$0.10 law breaks at one scene" headline was MISFILED against the wrong tier and is withdrawn.

_Break-even now lives in the ALL-IN section above ($0.21/render measured). The superseded table here — built on the retired $0.481 bottom-up premium figure — is REMOVED rather than left to contradict it: two break-even tables on one board is how a stale number gets quoted._

_NO LIVE DATA: there are still ZERO Lumen renders in `video_jobs`. These are harness in-run figures, not production measurement, and were measured in-run precisely because envelope loss corrupts `result` on ~39% of completions._

_Denominator guard — completed renders/day: n=2 — too short to test homogeneity_
_**Denominator basis:** the completion denominator behind cost-per-render figures is a **7-DAY MEAN** (~233/day over 08-08→08-15), **not the current regime** (~150/day since 08-11). Cost-per-render on the 7-day mean understates the current per-render figure by ~1.55x for exactly the reason the cycle-average understates the recent slice. State which basis any per-render number uses._

### Agent / harness spend — counted like user jobs [Rule 6]

| run | $ | note |
|---|---:|---|
| First Light (10 scenes + 2 hero attempts) | **$1.96** | of a $2.00 ceiling; 14 billed image calls |
| worker deploy image rebuild (08-03) | ~$0.10 | build compute, logged not assumed free |
| JUDGE lane, all sessions to date | **$0.00** | every measurement DB-read or local ffmpeg |
| **agent / ephemeral, ongoing** | **$0.37/day** ($11.10/mo) | **standing line** — 1.2% of a ~150-render day today |
| **campaign total to date** | **~$2.06** | |

_Rule 6: harnesses count exactly like user jobs and land in the same ledger._
_**Why the $0.37/day agent line stays on the board even at 1.2%:** it was **17% of the bill eleven days ago**. A line that was material once can be material again, and a figure only removed from the board when it looks small is a figure nobody is watching when it grows. Standing lines catch returns; ad-hoc checks do not. ($11.10/mo ≈ 0.35 subscriber-months.)_

