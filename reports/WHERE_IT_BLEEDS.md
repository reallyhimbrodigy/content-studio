# WHERE THE PRODUCT BLEEDS — ranked by USER

**JUDGE, generated 2026-08-21T02:28:02.631Z by `scripts/bleeds.js`.** Job window 24h; funnel + fulfillment windows stated per section. Every line [MEASURED].

# 📉 DAILY ACTIVE VIDEO-MAKERS — **184/day**, **-43%** week-over-week

| last 7d | prior 7d | change | peak (2026-08-04) | last full day (2026-08-20) | peak → now |
|---:|---:|---:|---:|---:|---:|
| **184/day** | 325/day | **-43%** | 861 | **187** | **-78%** |

**This sits above the failure rate because a rate on a shrinking denominator flatters itself.** A 10% failure rate over 187 makers is a worse product than 10% over 861, and only this line can tell them apart. Today is excluded as a partial day.

---

# 🔴 FAILURE RATE — **15.0%** of jobs failed in the last 6h (3/20)

**This is pinned to the top of the board until it is under 10%.** Every other number below is computed over the jobs that survived this — honor, latency and coverage are all statements about the **85%** that did not fail, and none of them can be read as a statement about the product while this number stands.

| hour | jobs | failed | rate |
|---|---:|---:|---:|
| 2026-08-20T15Z | 11 | 0 | 0% |
| 2026-08-20T16Z | 14 | 1 | 7% |
| 2026-08-20T17Z | 7 | 2 | 29% |
| 2026-08-20T18Z | 13 | 2 | 15% |
| 2026-08-20T19Z | 12 | 0 | 0% |
| 2026-08-20T20Z | 11 | 0 | 0% |
| 2026-08-20T21Z | 3 | 0 | 0% |
| 2026-08-20T22Z | 3 | 0 | 0% |
| 2026-08-20T23Z | 2 | 1 | **50%** |
| 2026-08-21T00Z | 3 | 0 | 0% |
| 2026-08-21T01Z | 7 | 2 | 29% |
| 2026-08-21T02Z | 2 | 0 | 0% |

_12h total: 8/93 = 8.6%. Retires itself when the 6h rate goes under 10%._

---

# ⏱️ SPEED — target cohort (20–30s source) p50 **126s** vs the **60–90s** hard target — **MISS by 36s**

| cohort | n | e2e p50 | e2e p90 | vs 90s |
|---|---:|---:|---:|---|
| **20–30s source (the target)** | 115 | **126s** | 374s | +36s |

_9 sweep-stamped row(s) excluded from this band — delivered videos whose `completed_at` was written hours later by a reaper. Counted, not silently dropped._
| all sources (context only) | 1006 | 120s | 455s | +30s |

**The two levers — worker-wall decomposition:**

| stage | p50 | share of worker wall |
|---|---:|---:|
| `render` | 72.4s | 76.7% |
| `normalize_transcribe_upload` | 21.8s | 23.1% |
| `edit_plan` | 18.4s | 19.5% |
| `upload_export` | 5.0s | 5.3% |
| `hls` | 2.3s | 2.4% |
| **worker wall total** | **94s** | 100% |

**Render split — pre-registered read, locked at `30a1e62` BEFORE the data:**

`PENDING` — **31/31** render spans are ~100% unaccounted, so the sub-timers are NOT deployed. `lane/judge-timers@feb48f8` is filed with TRUTH (reassigned out of JUDGE's lane). **No render build is decided until this reads.**

_**e2e 126s − worker wall 94s = ~32s outside the worker** (queue + delivery). Even at zero queue the worker alone sits at the TOP of the 60–90s window, so the target cannot be met by trimming overhead — the worker wall itself has to come down._

_⚠️ **The "editorial call is 54% of wall" lever does NOT reproduce in this window, and the reason matters: `gemini_call` measures **0.0s** here, so the editorial path is SUPPRESSED and these are deterministic plans. `edit_plan` is ~20% and `render` ~75%. The 54% figure is from an editorial-LIVE regime. **Lever share is regime-dependent — state which regime any share is quoted from**, or the two numbers will keep disagreeing for a reason that is not a disagreement._

_Modal spend per render: the cost board carries the anchor (orchestration 72.3% of the invoice) and is the one place a $/render figure is quoted, with its cycle-vs-slice basis stated. Spend is not restated here to avoid two figures on two bases._

---

# 💬 CHAT EVENTS/DAY — **25** today, **4** of the last 11 days DARK (chat 0 with renders > 0)

| day | chat | render (control) | |
|---|---:|---:|---|
| 2026-08-11 | 2 | 147 |  |
| 2026-08-12 | **0** | 176 | **DARK** |
| 2026-08-13 | 1 | 131 |  |
| 2026-08-14 | **0** | 147 | **DARK** |
| 2026-08-15 | **0** | 88 | **DARK** |
| 2026-08-16 | **0** | 87 | **DARK** |
| 2026-08-17 | 195 | 71 |  |
| 2026-08-18 | 532 | 195 |  |
| 2026-08-19 | 395 | 196 |  |
| 2026-08-20 | 346 | 177 |  |
| 2026-08-21 | 25 | 12 |  |

**Chat can die without producing a single error.** `logUsageEvent(userId,'chat')` fires only on a SUCCESSFUL reply, so a broken chat emits no row, no error_code and no alert — it goes quiet, and quiet looks like a slow day. That is why this is a **permanent positive counter** on the board rather than an alarm that fires on absence: an alarm that depends on the broken thing to speak cannot fire.

_It died on **2026-08-08**: 1,173 events on 08-07, then **1**. It has not recovered in the nine days since. For scale, 08-07 carried those 1,173 chats against 555 job-creating users — chat was not a side feature on that day, and its absence has cost nine days of whatever it was contributing._

---

## 1. Failures — 20 users / 21 jobs (24h)

| class | users | jobs | share of failing users |
|---|---:|---:|---:|
| UPLOAD_NEVER_STARTED | 15 | 15 | 75.0% |
| INTEGRITY_TRIP | 3 | 4 | 15.0% |
| CLIP_TOO_SHORT | 1 | 1 | 5.0% |
| WORKER_DIED | 1 | 1 | 5.0% |

## 2. FAILED-JOB SECONDS — 2.3% of all job-lifetime seconds [7-DAY WINDOW]

**472 failed jobs / 255 users** over **7 days**, p50 lifetime **601s**, **67/day**. Total **217,700s** of user time spent on jobs that never delivered.

| quantity | jobs | seconds | share |
|---|---:|---:|---:|
| reached a worker (**Modal-billable**) | 278 | 101146 | 46.5% |
| never reached one (**$0 Modal, pure user wait**) | 194 | 116555 | 53.5% |

**USER-time and MODAL-time are different quantities and must not be blended.** A job with no `worker_started_at` and no `modal_call_id` never reached a container: it costs the user their whole wait and costs us **$0**. Here only **46.5%** of failed seconds were Modal-billable (~$0.49/day, **1.9%** of orchestration) — the rest is pure user loss at zero spend.

> **UNS does NOT move onto the cost board — the conditional FAILS.** [MEASURED] Of 263 `UPLOAD_NEVER_STARTED` jobs, **0 have `worker_started_at` and 0 have `modal_call_id`.** The ~601s wait is entirely client/server-side; nothing was ever dispatched. UNS is the **largest user-time loss on the board** (263 jobs × ~601s) at **zero Modal spend**, so it stays a **DELIVERY/product lever, not a cost lever.** Filing it beside orchestration would aim spend work at a class that spends nothing.

_The failure class that IS Modal-billable is `DISPATCH_UNREACHABLE` — 27 jobs, all with a call id, 19 reaching a worker, p50 904s — and it is 1.9% of orchestration, not a rival to it._

## 2b. Latency — n=172 completed (24h)

p50 **133s** (law 90) · p90 304s · p99 **756s** (law 180) · max 879s

| envelope class | n | users | p50 | p90 | max |
|---|---:|---:|---:|---:|---:|
| `A envelope FULL` | 172 | 164 | **133s** | 304s | 879s |

**ENVELOPE LOSS: 0.0% of completions (0/172), 0 users.** Regression BORN 2026-08-11T23Z after 8 clean days at 0.0% (08-04..08-11). The pooled p50 above sits between classes and describes NO actual user.
_Mechanism SETTLED 2026-08-15: a LOST UPDATE on `result` jsonb (written, then clobbered by a later read-modify-write). Fix = CAS on `updated_at`. The worker-hang framing is retired._

| term | p50 | p90 | p99 | max |
|---|---:|---:|---:|---:|
| **QUEUE** (create→worker pickup) | 11.0s | 15.1s | 260.9s | 276.4s |
| **WORK** (pickup→complete) *envelope-FULL only* | 119.6s | 281.5s | 690.3s | 754.8s |

Queue is **8%** of e2e at p50; **4.1%** of jobs wait >30s before any work begins.

**Queue and envelope loss are NEAR-THRESHOLD, not merely correlated.** Of jobs queuing <30s, **100.0%** kept their envelope (0 of 164 lost it); of jobs queuing ≥30s, **0.0%** lost it. **95.9%** of envelope-FULL jobs queued under 30s. The relation is a step at ~15–30s, so "correlates with" understates it — below the knee loss is near-absent, above it near-certain.
_Direction is still open: queueing may cause the loss, or one upstream condition may cause both. The STEP SHAPE constrains any mechanism to something that switches at ~15–30s of queue._
_WORK is shown for envelope-FULL rows ONLY. Cross-class WORK is WITHDRAWN: for lost-envelope rows `completed_at` marks DISCOVERY, not work (repair Q+W pins to a ~constant while W ranges 278–846s; reconciler W has a 0.22s minimum). **QUEUE is the only valid cross-class term.**_
_Workload and client are RULED OUT as the split: source duration differs 1.24x by class (median 10.7s FULL vs 13.3s LOST) while queue differs 15.0x, and client version is identical (96% on 1.3.6(224) in BOTH classes). Do not re-litigate workload._
_Queue history begins 2026-08-11T19:50Z (the `worker_started_at` migration). There is NO pre-Aug-11 queue data, so "queue delay is new/worse" is [UNFALSIFIABLE] with current data._
On the 900s wall [870,920] — count: **1** of 172

## 3. Route mix (24h)

`none` 75 · `moodreel` 58 · `minimal_speech_uncut` 35 · `minimal` 3 · `hype` 1

Premium share: **34.3%** (59/172).

## 4. Delivery layer — since the column landed 2026-08-11T19:50:15Z (n=193 terminal)

`callback` 169 · `NULL` 15 · `orphan_callback` 1 · `reconciler` 6 · `durable_poll` 2

fallback_timer share **0.0%** — PASS bar met (~0).

## 5. Fulfillment — honor **49.6%** (target ≥70%) · dropped-silently **36.7%** (target <5%)

n=8818 asks over 4115 judged jobs (all-time table).

> ⚠️ **COVERAGE: these figures describe 100.0% of completions.** **0% of envelope-absent completions have ever been scored** — not a sampling choice, a structural one: the judge hard-filters on `edit_recipe`, and **210 of 210** envelope-lost completions carry none. Honor and dropped-silently are statements about the **healthy ~61%** only, and must never be quoted as statements about the product.

> **IS THE LOST CLASS SCOREABLE AT ALL? — NO, and the split is exact.** The **ASK** side survives: `vibe_input` is a top-level COLUMN, intact on **210/210** lost rows. The **VERDICT** side does not: `edit_recipe` moved INSIDE `result` jsonb on **2026-08-04**, the exact object the lost update clobbers — **0/210**. So for these jobs we can know what the user asked for and **never what was done about it**. Fulfillment needs both, so **the already-lost population is PERMANENTLY UNSCOREABLE** — no reprocessing recovers a verdict that was never persisted.

> **It is recoverable FORWARD, two ways, and they are not equivalent:** (a) the CAS fix stops the clobber, which restores scoreability only while it holds; (b) moving `edit_recipe` back OUT of `result` — where it lived before 08-04 — makes the verdict channel **structurally immune** to any future `result` failure. (b) is the one that survives the next unrelated bug. Pre-08-04 jobs would still be scoreable today under exactly this outage.

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

wall_viewed **934** → started **89** (9.5%) → paid **6** (6.7% of starters)
purchase_failed n=167, self-cancelled at the sheet **164** (98.2%) — the leak is the OFFER, not the funnel.

## 7. LUMEN cost baseline — First Light  🔒 **FROZEN 2026-08-15**

> **COST BOARD FROZEN.** The campaign has pivoted to quality. Every figure and guard below is held as-is: the per-function anchor (orchestration 72.3%), L1/L2 at $4,450–$5,586/yr current-window, the all-in $0.21 recent-slice vs $0.151 cycle-average split, the ~4-scene quota ceiling, acceptance-adjusted effective cost, the agent/ephemeral standing line, and the [OWNER-SUPPLIED] provenance tag. **Guards remain armed** — bottom-up-runs-low, vestigial-column, window-homogeneity, verified-zero, cycle-vs-slice — so the board keeps self-checking while frozen. Unfreeze only on a new invoice or a config change, which invalidates the anchor by the config caveat already attached to it.


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

### Optional-component decline rate

| component | plans w/ key | carries content | **decline** |
|---|---:|---:|---:|
| motion_graphics | 172 | 13 | **92.4%** |
| generated scenes | 75 | 0 | **100.0%** |
| brand copy | **0 — key never appears** | — | _absent, not declined_ |
| transitions | 172 | 6 | **96.5%** |
| outro | 172 | 172 | **0.0%** |

**The pattern is NARROWER than "the model declines optional components", and `outro` is why.** Outro carries content on **every** plan — 0% decline — while `motion_graphics` and `generated_scenes` are declined at ~100%. A pooled number would have averaged those into one figure and hidden the counter-example that constrains the diagnosis: the model is not indifferent to optional components in general, it declines *specific* ones. Whatever explains scenes and MG must also explain why outro is always taken.

_`brand_copy` never appears as a key in any production plan — that is **absent, not declined**, and it is the production-side reading of state (4). The build-lane runs showed the field reaching the model and being declined on the NEW code; production plans do not carry it at all._

### Built-not-wired check — production counters, not certs

- Lumen scene vocabulary: **WIRED** — completions carrying scene telemetry = 75 on real traffic.
- `callback` delivery stamp: **WIRED** — completion_delivery=callback rows = 169 on real traffic.
- NamePlate (component D): **WIRED** — completions carrying a name-plate = 7 on real traffic.
- EndCard (component F): ⚠️ **[BUILT-NOT-WIRED]** — cert built + renderer-registered, but completions carrying an end-card = 0. Cert-green proves capability, not connection. Five prior instances in this project ran exactly here.

_The `callback` line is the class resolving in real time: it was [BUILT-NOT-WIRED] for 432+ completions and is now wired — the predicate fix connected a stamp that had always been written and always discarded. The scene vocabulary is still on the other side of that line._

_NO LIVE DATA: there are still ZERO Lumen renders in `video_jobs`. These are harness in-run figures, not production measurement, and were measured in-run precisely because envelope loss corrupts `result` on ~39% of completions._

_Denominator guard — completed renders/day: n=2 — too short to test homogeneity_
_**Denominator basis:** the completion denominator behind cost-per-render figures is a **7-DAY MEAN** (~233/day over 08-08→08-15), **not the current regime** (~150/day since 08-11). Cost-per-render on the 7-day mean understates the current per-render figure by ~1.55x for exactly the reason the cycle-average understates the recent slice. State which basis any per-render number uses._

### Deploy quiet-window — the GATE's own verdict

**BUSY — push BLOCKED**

```
QUIET-WINDOW: BUSY — 2 in-flight user job(s). Deploying now orphans live user work.
    queued  a80e1860-b008-4300-ae71-5354223c8ddb  2026-08-21T02:22:28.425418+00:00  stale=342s
    processing  af3d2c48-130f-48d9-9557-60e0f765803a  2026-08-21T02:24:46.1384+00:00  stale=16s
  Wait for them to settle and re-run. Deliberate override: PROMPTLY_ALLOW_BUSY_DEPLOY=1 (and attribute the orphans in DEPLOY_LOG.md).
```

**No wedged rows surfaced.**

> **CORRECTION to my previous board (2026-08-15).** I published that wedged rows *hold the deploy gate shut* and that the gate "sees 1 busy when at most 0 could be live." **That is no longer true and the gate is the thing that is right.** `preflight_quiet_window.py` now splits LIVE from WEDGED on staleness and excludes anything past `CONTAINER_CAP_S=1200` — because nothing can still be running past the Modal timeout, so excluding it cannot exclude live work *by construction*. The corpse I found was real, and the gate correctly reported QUIET anyway.

_The premise is HISTORICAL, not current: one wedged row (fb702c40, 2,180s old, last touched 2,170s ago) did block every deploy for ~17 minutes — including the fix for a live bug — which is what forced the container-cap split. So "corpses hold the gate" was exactly right until it was fixed today._

_Why the count still belongs on the board: the gate deliberately surfaces wedged rows LOUDLY rather than silently ignoring them, because trading a blocked deploy for an invisible stuck job is the worse of the two. It is now a defect metric that the gate refuses to hide — not a deploy blocker._

### Agent / harness spend — counted like user jobs [Rule 6]

| run | $ | note |
|---|---:|---|
| First Light (10 scenes + 2 hero attempts) | **$1.96** | of a $2.00 ceiling; 14 billed image calls |
| worker deploy image rebuild (08-03) | ~$0.10 | build compute, logged not assumed free |
| JUDGE lane, all sessions to date | **$0.00** | every measurement DB-read or local ffmpeg |
| **agent / ephemeral, ongoing** | **$0.37/day** ($11.10/mo) | **standing line** — 1.2% of a ~150-render day today |
| **campaign total to date** | **~$2.06** | |

_Rule 6: harnesses count exactly like user jobs and land in the same ledger._

# 📊 ANALYTICS SPEND — $280/cycle ($9.20/day), and it is 100% session replay

| term | value | cost |
|---|---:|---:|
| PostHog events/month | 865,000 `[OWNER]` | **$0** — 86.5% of a FREE 1M tier |
| mobile recordings/month | 37,000 `[OWNER]` | |
| **billable recordings** | **32,000** | **$280 → $0.00875 each** |
| tracked+named, measured here | 244,303/mo · 32 names | $0 — **and all of it is already in Supabase** |
| **autocapture — no name at all** | **620,697/mo (72%)** | $0 today · **62% of the free tier** |

_**Events cost nothing; replay is the entire bill** — so retiring events recovers **$0**. Recordings/session = **1.01**: replay records essentially EVERY session, unsampled (SDK default, never tuned). 10% sampling takes $280 → **~$28**._
_**No reader, proven not asserted:** ZERO of this lane's reports cite a session recording — the only file mentioning replay is the one written to explain the bill. A recording is watched by a human or not at all, so replay carries none of the read-census caveat named events do._
_**Both halves are waste, for opposite reasons:** the 28% that is tracked duplicates `analytics_events` byte-for-byte (dual-sink writes both unconditionally); the 72% that is unique — autocapture and replay — is the part nobody asked for and nobody reads._

_**Why the $0.37/day agent line stays on the board even at 1.2%:** it was **17% of the bill eleven days ago**. A line that was material once can be material again, and a figure only removed from the board when it looks small is a figure nobody is watching when it grows. Standing lines catch returns; ad-hoc checks do not. ($11.10/mo ≈ 0.35 subscriber-months.)_

### Instrument self-check

**The standing question — what does each instrument report when IT breaks?**

| instrument | on its own failure | safe direction? |
|---|---|---|
| this board (`bleeds.js`) | throws FATAL, exits 1, writes no report | ✅ loud |
| fetch/read parity | prints the violating fields by name | ✅ loud |
| `lumen_first_output_watch` | exit 2 = no-hit, other = ERROR (never 0) | ✅ fixed 08-16 |
| `lumen_watch.sh` | retries; 5 consecutive errors = exit 1 LOUD | ✅ fixed 08-16 |
| `chat-liveness-alert` | exit 2 = UNKNOWN, never 0 | ✅ fixed 08-16 |
| `delivery-48h-verdict` | exit 2 = NOT-READABLE/ERROR | ✅ fixed 08-16 |
| `score_component` | throws on unreadable artifact; exit ≠ 0 | ✅ loud |
| `preflight_quiet_window` | exit 2 = UNKNOWN → BLOCKS the push | ✅ fail-closed |
| chat events/day (above) | a positive counter — cannot go quiet undetected | ✅ by design |
| `brand_components_built` | emitted BY the worker — silent if the worker lacks the code | ⚠️ **state (4) blind spot** |
| fulfillment judge | skips rows without `edit_recipe` — coverage hole, not an error | ⚠️ **silent narrowing** |

**The two ⚠️ rows are the honest ones:** both fail by reporting LESS rather than by reporting wrong, and reporting less looks like a quiet day. `brand_components_built` cannot see code the worker does not contain (the state-(4) blind spot, remedy: add `build_sha`). The fulfillment judge silently narrows its denominator to rows carrying a recipe — which is why the coverage line is attached to every quality figure rather than mentioned once.

✅ **FETCH/READ PARITY: clean** — every field read was fetched.

