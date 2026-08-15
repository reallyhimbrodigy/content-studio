# WHERE THE PRODUCT BLEEDS — ranked by USER

**JUDGE, generated 2026-08-15T02:37:42.222Z by `scripts/bleeds.js`.** Job window 24h; funnel + fulfillment windows stated per section. Every line [MEASURED].

## 1. Failures — 26 users / 37 jobs (24h)

| class | users | jobs | share of failing users |
|---|---:|---:|---:|
| UPLOAD_NEVER_STARTED | 22 | 32 | 84.6% |
| DISPATCH_UNREACHABLE | 2 | 3 | 7.7% |
| TIER_CONCURRENCY | 1 | 1 | 3.8% |
| PLATFORM_TIMEOUT | 1 | 1 | 3.8% |

## 2. Latency — n=143 completed (24h)

p50 **105s** (law 90) · p90 678s · p99 **1172s** (law 180) · max 1205s

| envelope class | n | users | p50 | p90 | max |
|---|---:|---:|---:|---:|---:|
| `C envelope LOST + repair` | 6 | 5 | **904s** | 1172s | 1172s |
| `B envelope LOST` | 57 | 46 | **308s** | 829s | 1205s |
| `A envelope FULL` | 80 | 80 | **60s** | 116s | 541s |

Worst/best class p50 spread: **15.1x** — the pooled number above hides it.

**ENVELOPE LOSS: 44.1% of completions (63/143), 51 users.** Regression BORN 2026-08-11T23Z after 8 clean days at 0.0% (08-04..08-11). The pooled p50 above sits between classes and describes NO actual user.
_Mechanism SETTLED 2026-08-15: a LOST UPDATE on `result` jsonb (written, then clobbered by a later read-modify-write). Fix = CAS on `updated_at`. The worker-hang framing is retired._

| term | p50 | p90 | p99 | max |
|---|---:|---:|---:|---:|
| **QUEUE** (create→worker pickup) | 18.4s | 347.7s | 757.4s | 824.3s |
| **WORK** (pickup→complete) *envelope-FULL only* | 42.2s | 88.6s | 184.4s | 184.4s |

Queue is **17%** of e2e at p50; **47.6%** of jobs wait >30s before any work begins.

**Queue and envelope loss are NEAR-THRESHOLD, not merely correlated.** Of jobs queuing <30s, **100.0%** kept their envelope (0 of 75 lost it); of jobs queuing ≥30s, **92.6%** lost it. **93.8%** of envelope-FULL jobs queued under 30s. The relation is a step at ~15–30s, so "correlates with" understates it — below the knee loss is near-absent, above it near-certain.
_Direction is still open: queueing may cause the loss, or one upstream condition may cause both. The STEP SHAPE constrains any mechanism to something that switches at ~15–30s of queue._
_WORK is shown for envelope-FULL rows ONLY. Cross-class WORK is WITHDRAWN: for lost-envelope rows `completed_at` marks DISCOVERY, not work (repair Q+W pins to a ~constant while W ranges 278–846s; reconciler W has a 0.22s minimum). **QUEUE is the only valid cross-class term.**_
_Workload and client are RULED OUT as the split: source duration differs 1.24x by class (median 10.7s FULL vs 13.3s LOST) while queue differs 15.0x, and client version is identical (96% on 1.3.6(224) in BOTH classes). Do not re-litigate workload._
_Queue history begins 2026-08-11T19:50Z (the `worker_started_at` migration). There is NO pre-Aug-11 queue data, so "queue delay is new/worse" is [UNFALSIFIABLE] with current data._
On the 900s wall [870,920] — count: **5** of 143

## 3. Route mix (24h)

`none` 63 · `minimal` 48 · `minimal_speech_uncut` 30 · `moodreel` 2

Premium share: **1.4%** (2/143).

## 4. Delivery layer — since the column landed 2026-08-11T19:50:15Z (n=180 terminal)

`reconciler` 133 · `repair` 6 · `NULL` 35 · `callback` 5 · `durable_poll` 1

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

wall_viewed **1535** → started **124** (8.1%) → paid **2** (1.6% of starters)
purchase_failed n=255, self-cancelled at the sheet **251** (98.4%) — the leak is the OFFER, not the funnel.

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

### Break-even — FIXED and MARGINAL, on the Aug-3 decomposition

> **ANCHOR CORRECTED 2026-08-15.** My previous board used **$87/day fixed** and **$0.481/render marginal**. Both are superseded by the bottom-up decomposition in `MODAL_FIXED_VS_MARGINAL.md`, which sums every warm surface at its *measured* up-fraction: **fixed $5.74/day (15x overstated)** and **marginal $0.0222/render (22x overstated)**. The $87/day figure **cannot be reproduced** — every warm surface at its 24/7 ceiling is only $8.28/day — and per its own source it "must not be used to justify a cut."

⚠️ **CONFIG-CHANGE CAVEAT — this anchor is valid only for TODAY's configuration.** It is measured at cpu=16 / 12GiB with `min_containers=1` removed and the scaledown windows as they now stand. **Any change to cpu, memory, scaledown_window or warm-surface count invalidates both terms and they must be re-derived** — that is precisely how the $87/day figure went stale (it predates the cpu 64→16 cut, the memory cuts and the min_containers removal). An anchor without its configuration is not a number.

#### FIXED — covered by subscriber COUNT

**$5.74/day (~$172/mo)** today, against a hard 24/7 ceiling of **$8.28/day (~$248/mo)** — a warm surface cannot cost more than being up continuously, so the ceiling is structural, not an estimate.

> **SUBSCRIBERS NEEDED TO COVER FIXED: ~6** ($172 ÷ $31.50), or **~8** at the ceiling.
> _My previous board said 83. That was the unreproducible $87 figure, off by 15x._

#### MARGINAL — renders/month one subscriber's margin buys

| scenes | scene $ | + compute $0.0222 | $/render | renders/mo | **scene share of cost** |
|---:|---:|---:|---:|---:|---:|
| 0 | $0.000 | $0.0222 | $0.0222 | **1419** | 0% |
| 1 | $0.140 | $0.0222 | $0.1622 | **194** | 86% |
| 2 | $0.280 | $0.0222 | $0.3022 | **104** | 93% |
| 4 (ceiling) | $0.560 | $0.0222 | $0.5822 | **54** | 96% |

**THE RANKING REVERSES — I had it backwards.** I previously wrote that the Modal figure "moves the answer ~2x more than scene count does." That was built on the inflated $0.481 and is **wrong**. At the corrected anchor the scene bill is **6x** render compute at 1 scene and **25x** at 4; across the plausible compute range a 4-scene edit moves only 54→52 renders/mo, while across the scene range it moves 1,419→54. **Scene count is the cost decision; compute is a rounding error beside it.**

| scenes | $/edit | vs $0.10 law | scene secs | vs 120s law |
|---:|---:|---:|---:|---:|
| 1 | $0.14 | 1.4x | 19s | 0.2x |
| 3 | $0.42 | 4.2x | 56s | 0.5x |
| 4 **(ceiling)** | $0.56 | 5.6x | 75s | 0.6x |
| 6 | $0.84 | 8.4x | 112s | 0.9x |

**Filed against §2.1's ≤$1/render PREMIUM budget** — NOT the $0.10 standard-tier law, which does not govern Lumen. Scene spend stays inside the premium budget through **7 scenes** ($0.98); at the registered 4-scene quota ceiling it is **$0.56 = 56% of budget — comfortably inside**. My earlier "$0.10 law breaks at one scene" headline was MISFILED against the wrong tier and is withdrawn.

**BREAK-EVEN RENDER QUOTA — the number the pricing ruling now needs.** At $45/mo net of Apple's 30% = **$31.50**, against premium Modal cost $0.481/render [RECON C-9]:

| scenes/render | $/render | renders/mo at break-even |
|---:|---:|---:|
| 0 | $0.48 | **65** |
| 1 | $0.62 | **51** |
| 2 | $0.76 | **41** |
| 4 | $1.04 | **30** |

A $45 subscriber breaks even at **~65 renders/month with no generative scenes**, falling to **~30/month at the 4-scene ceiling**. Sensitivity: on the $0.257 blended-with-burst Modal figure instead, those become ~123 and ~39. _The quota ruling should be made against this curve, not against a single average._
_NO LIVE DATA: there are still ZERO Lumen renders in `video_jobs`. These are harness in-run figures, not production measurement, and were measured in-run precisely because envelope loss corrupts `result` on ~39% of completions._

_Denominator guard — completed renders/day: n=2 — too short to test homogeneity_

### Agent / harness spend — counted like user jobs [Rule 6]

| run | $ | note |
|---|---:|---|
| First Light (10 scenes + 2 hero attempts) | **$1.96** | of a $2.00 ceiling; 14 billed image calls |
| worker deploy image rebuild (08-03) | ~$0.10 | build compute, logged not assumed free |
| JUDGE lane, all sessions to date | **$0.00** | every measurement DB-read or local ffmpeg |
| **campaign total to date** | **~$2.06** | |

_Rule 6: harnesses count exactly like user jobs and land in the same ledger. At ~$2.06 the campaign's agent spend is ~0.4 subscriber-months — immaterial against fixed ($172/mo), and stated so it stays that way. Source: `MODAL_SPEND_LEDGER.md` + the First Light ledger._

