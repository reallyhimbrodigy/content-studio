# WHERE THE PRODUCT BLEEDS — ranked by USER

**JUDGE, generated 2026-08-15T00:05:00.411Z by `scripts/bleeds.js`.** Job window 24h; funnel + fulfillment windows stated per section. Every line [MEASURED].

## 1. Failures — 28 users / 39 jobs (24h)

| class | users | jobs | share of failing users |
|---|---:|---:|---:|
| UPLOAD_NEVER_STARTED | 23 | 33 | 82.1% |
| DISPATCH_UNREACHABLE | 3 | 4 | 10.7% |
| TIER_CONCURRENCY | 1 | 1 | 3.6% |
| PLATFORM_TIMEOUT | 1 | 1 | 3.6% |

## 2. Latency — n=146 completed (24h)

p50 **154s** (law 90) · p90 678s · p99 **1172s** (law 180) · max 1205s

| envelope class | n | users | p50 | p90 | max |
|---|---:|---:|---:|---:|---:|
| `repair` | 5 | 5 | **904s** | 1172s | 1172s |
| `reconciler` | 141 | 130 | **116s** | 541s | 1205s |

Worst/best class p50 spread: **7.8x** — the pooled number above hides it.

_Caveat: while the `_delivered` predicate discards the `callback` stamp, `reconciler` is a MIXTURE (fast primary deliveries + slow recoveries share the label), so these are not yet the true envelope classes._
On the 900s wall [870,920]: **4** of 146

## 3. Route mix (24h)

`none` 67 · `minimal` 50 · `minimal_speech_uncut` 29

**PREMIUM ROUTES EXTINCT — 0 of 146 completions.** Every quality number in this window is off the fallback path and must NOT be compared to pre-outage baselines.

## 4. Delivery layer — since the column landed 2026-08-11T19:50:15Z (n=185 terminal)

`reconciler` 143 · `NULL` 37 · `repair` 5

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

wall_viewed **1564** → started **125** (8.0%) → paid **2** (1.6% of starters)
purchase_failed n=264, self-cancelled at the sheet **260** (98.5%) — the leak is the OFFER, not the funnel.

