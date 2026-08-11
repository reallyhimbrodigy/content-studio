# WHERE THE PRODUCT BLEEDS — ranked by USER

**JUDGE, generated 2026-08-11T23:24:26.522Z by `scripts/bleeds.js`.** Job window 24h; funnel + fulfillment windows stated per section. Every line [MEASURED].

## 1. Failures — 39 users / 39 jobs (24h)

| class | users | jobs | share of failing users |
|---|---:|---:|---:|
| UPLOAD_NEVER_STARTED | 24 | 24 | 61.5% |
| DISPATCH_UNREACHABLE | 13 | 13 | 33.3% |
| JOB_STALLED | 1 | 1 | 2.6% |
| CLIP_TOO_SHORT | 1 | 1 | 2.6% |

## 2. Latency — n=156 completed (24h)

p50 **94s** (law 90) · p90 261s · p99 **719s** (law 180) · max 901s
On the 900s wall [870,920]: **1** of 156

## 3. Route mix (24h)

`minimal` 59 · `none` 56 · `minimal_speech_uncut` 41

**PREMIUM ROUTES EXTINCT — 0 of 156 completions.** Every quality number in this window is off the fallback path and must NOT be compared to pre-outage baselines.

## 4. Delivery layer — since the column landed 2026-08-11T19:50:15Z (n=15 terminal)

`NULL` 6 · `reconciler` 9

_180 terminal rows in the 24h window predate the column and are excluded — they cannot carry a value._

**NOT YET READABLE** — n=15 < 100. No verdict on a thin sample (48h verdict due 2026-08-13T19:50Z).

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

wall_viewed **1620** → started **164** (10.1%) → paid **3** (1.8% of starters)
purchase_failed n=357, self-cancelled at the sheet **350** (98.0%) — the leak is the OFFER, not the funnel.

