# WHERE THE PRODUCT BLEEDS — ranked, by USER, 2026-08-11

**JUDGE. Every line [MEASURED] with its window and denominator. Ranked by users
harmed, per Rule 7 — not by job count, which the retry multiplier inflates.**

## The board is durable as of today

- `fulfillment_scores`: **4,115 judgments loaded** (was JSONL-only). [MEASURED]
- `daily_scoreboard`: **7 rows, 08-04 → 08-10**, in the table. [MEASURED]
- The v2 columns (`sentinel`, `purchase_funnel`, `active_pro_subs`, `outage*`)
  are **still pending** `20260811_daily_scoreboard_v2.sql`. PostgREST bounces a
  whole row on one unknown column, which is why the board was empty while only
  5 columns were missing; `scoreboard.js` now **degrades to a v1 row and says
  so loudly** rather than writing nothing. Those four measures stay blind until
  the owner applies it — the last migration outstanding.

## Ranked bleeds

### 1. UPLOAD_NEVER_STARTED — 26 users / 27 jobs in 24h (67% of all failures)
[MEASURED 08-10T20:00Z→now; 39 failed jobs, 38 distinct users.] Nearly
one-user-one-job, so this is not retry inflation: **26 separate people whose
video never began.** Biggest single user-facing loss on the board, unchanged in
rank from the 257-user standing figure. Second: `DISPATCH_UNREACHABLE`, 8 jobs
/ 8 users.

### 2. The purchase sheet — 181 users start, 4 finish (7d)
[MEASURED 08-04→now, by USER.] wall_viewed **3,174 users** → purchase_started
**181** (5.7%) → purchase_completed **4** (2.2% of starters, 0.13% of wall).
Of 228 `purchase_failed` events, **223 (98%) are self-cancels** at the sheet —
tighter than my earlier 94.9% and the same verdict: **the leak is the offer,
not the funnel.** Every SKU string on `purchase_started` is null in props, so
the per-SKU cut still rides the client fix; the RC-truth level is what
`active_pro_subs` will carry once v2 lands.

### 3. Fulfillment — honor 49.6%, dropped-silently 36.7% (n=8,818 asks)
[MEASURED, all-time table.] Against targets ≥70% / <5%. Worst classes by
volume, honor% / silent%:

| ask class | n | honor | dropped silently |
|---|---:|---:|---:|
| motion_graphics | 745 | **33.7%** | **63.6%** |
| text_overlay | 311 | 21.2% | **75.9%** |
| other | 502 | 12.0% | **86.1%** |
| sound_effects | 696 | 54.7% | 41.7% |
| cut_content | 199 | 46.2% | 41.2% |
| style_preset | 3,182 | 71.8% | 28.0% |
| zoom | 662 | 73.1% | 26.7% |
| captions | 464 | 73.3% | 12.9% |

`motion_graphics` remains the #1 honor lever (largest silent-drop class with
real volume). `generative_ai` (2.4%), `color_grade` (1.4%) and `music` (0.5%)
honor near-zero but drop with a NOTE, not silently — those are capability
gaps, not dishonesty, and must not be counted against the silent-drop target.

### 4. Premium routes still extinct — 0 of 170 completions in 24h
[MEASURED.] Route mix: `minimal` 60, `minimal_speech_uncut` 48, `none` 62 —
**zero moodreel, zero hype**, vs 31.6% premium share pre-outage. Fourth
consecutive day. This is the Vertex dunning outage, owner-blocked; it also
means **every quality number in this window is off the fallback path** and
must not be compared to pre-08-08 baselines.

### 5. Latency — p50 **92s** (law 90s), p99 **719s** (law 180s)
[MEASURED 24h, n=170 completed.] p50 is effectively AT the law — but on the
degraded route mix above, so it is not yet a win to bank. The tail is the real
miss: p99 719s, max 901s — the 900s wall is still visible in this window.

## Delivery verdict — clock running, verdict NOT due

`completion_delivery` column landed **2026-08-11T19:50:15Z**; the 48h verdict
is due **2026-08-13T19:50Z**. At T+0 there are **2 terminal rows** (1
`reconciler`, 1 NULL-pre-land) — far too thin to read, and I will not call a
distribution on n=2. The pass bar I will hold it to: distribution dominated by
`callback`, `fallback_timer` ≈ 0, p99 off the 900s wall.
