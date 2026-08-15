# WHERE THE PRODUCT BLEEDS — ranked by USER

**JUDGE, generated 2026-08-15T01:20:12.053Z by `scripts/bleeds.js`.** Job window 24h; funnel + fulfillment windows stated per section. Every line [MEASURED].

## 1. Failures — 26 users / 37 jobs (24h)

| class | users | jobs | share of failing users |
|---|---:|---:|---:|
| UPLOAD_NEVER_STARTED | 22 | 32 | 84.6% |
| DISPATCH_UNREACHABLE | 2 | 3 | 7.7% |
| TIER_CONCURRENCY | 1 | 1 | 3.8% |
| PLATFORM_TIMEOUT | 1 | 1 | 3.8% |

## 2. Latency — n=148 completed (24h)

p50 **155s** (law 90) · p90 679s · p99 **1172s** (law 180) · max 1205s

| envelope class | n | users | p50 | p90 | max |
|---|---:|---:|---:|---:|---:|
| `C envelope LOST + repair` | 6 | 5 | **904s** | 1172s | 1172s |
| `B envelope LOST` | 63 | 52 | **308s** | 760s | 1205s |
| `A envelope FULL` | 79 | 79 | **58s** | 158s | 541s |

Worst/best class p50 spread: **15.5x** — the pooled number above hides it.

**ENVELOPE LOSS: 46.6% of completions (69/148), 57 users.** Regression BORN 2026-08-11T23Z after 8 clean days at 0.0% (08-04..08-11). The pooled p50 above sits between classes and describes NO actual user.
_Mechanism SETTLED 2026-08-15: a LOST UPDATE on `result` jsonb (written, then clobbered by a later read-modify-write). Fix = CAS on `updated_at`. The worker-hang framing is retired._

| term | p50 | p90 | p99 | max |
|---|---:|---:|---:|---:|
| **QUEUE** (create→worker pickup) | 51.0s | 349.6s | 757.4s | 824.3s |
| **WORK** (pickup→complete) | 84.0s | 305.7s | 697.9s | 801.7s |

Queue is **33%** of e2e at p50; **50.7%** of jobs wait >30s before any work begins.

**Queue and envelope loss are NEAR-THRESHOLD, not merely correlated.** Of jobs queuing <30s, **100.0%** kept their envelope (0 of 73 lost it); of jobs queuing ≥30s, **92.0%** lost it. **92.4%** of envelope-FULL jobs queued under 30s. The relation is a step at ~15–30s, so "correlates with" understates it — below the knee loss is near-absent, above it near-certain.
_Direction is still open: queueing may cause the loss, or one upstream condition may cause both. The STEP SHAPE constrains any mechanism to something that switches at ~15–30s of queue._
_Workload and client are RULED OUT as the split: source duration differs 1.24x by class (median 10.7s FULL vs 13.3s LOST) while queue differs 15.0x, and client version is identical (96% on 1.3.6(224) in BOTH classes). Do not re-litigate workload._
_Queue history begins 2026-08-11T19:50Z (the `worker_started_at` migration). There is NO pre-Aug-11 queue data, so "queue delay is new/worse" is [UNFALSIFIABLE] with current data._
On the 900s wall [870,920]: **5** of 148

## 3. Route mix (24h)

`none` 69 · `minimal` 48 · `minimal_speech_uncut` 30 · `moodreel` 1

Premium share: **0.7%** (1/148).

## 4. Delivery layer — since the column landed 2026-08-11T19:50:15Z (n=185 terminal)

`reconciler` 140 · `repair` 6 · `NULL` 35 · `callback` 3 · `durable_poll` 1

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

wall_viewed **1555** → started **124** (8.0%) → paid **2** (1.6% of starters)
purchase_failed n=258, self-cancelled at the sheet **254** (98.4%) — the leak is the OFFER, not the funnel.

