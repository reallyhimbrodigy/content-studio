# ANALYTICS SPEND — the $280 is not event volume, and retiring events would save $0

**JUDGE, 2026-08-20. New standing board line. Nobody has measured this before,
and the first measurement refutes the question's premise — so the ranked
retire-list is not the deliverable it looked like.**

## 1. Tracked event volume, measured — and it is inside the free tier

Clean 7-day window 08-14→08-20, `platform=eq.ios` (the population that actually
reaches PostHog — see §3), complete pagination, no truncation:

| | |
|---|---:|
| iOS events, 7 days | **55,669** |
| per day | **7,953** |
| **projected monthly** | **~241,763** |
| **PostHog free tier** | **1,000,000 events/mo** |

**Tracked ingestion is at ~24% of the free allowance.** At $280, that implies
**$1.16 per 1,000 events — roughly 23x PostHog's list event rate.** A bill cannot
be 23x list for a volume that is *free*. **Event ingestion is not what was
billed**, and therefore **sampling or retiring events recovers $0 today.**

## 2. What IS billing — and every instrument I have is blind to it `[CODE]`

`PromptlyApp.swift:222-229` configures three things that **never pass through
`AnalyticsService.track()`**, so **none of them appear in `analytics_events`** and
none are visible to any measurement in this report:

```swift
phConfig.captureScreenViews = true                  // :222
phConfig.captureApplicationLifecycleEvents = true   // :223
phConfig.sessionReplay = true                       // :224  ← the suspect
phConfig.sessionReplayConfig.screenshotMode = true  // :229  ← SwiftUI path
```

**Session replay is billed PER RECORDING, at roughly two orders of magnitude more
per unit than an event**, and it is the one line item whose unit economics can
produce $280 at this traffic. `session_started` runs **1,205/day ≈ 36,600
sessions/month**; replay on a five-figure session count is the ordinary way a
PostHog bill reaches this size. `screenshotMode` — required for SwiftUI, per the
code's own comment — uploads image data per frame rather than a DOM wireframe,
which is the expensive capture path.

**`[INFERRED]`, and I want it labelled as such**: I cannot read the PostHog
billing breakdown, so I cannot state the split as observed. **What settles it is
a 30-second look at PostHog → Billing → usage by product.** That check is worth
more than anything else in this file, and I am asking for it rather than
asserting the answer.

**Autocapture is the second blind term.** `captureScreenViews` fires per
navigation and `captureApplicationLifecycleEvents` per foreground/background —
both invisible to the mirror. At ~36,600 sessions/month, even 10 screen views per
session adds ~366k events, which would put total ingestion near
**~600k/month — still free, but at 60% of the tier with no instrument watching
it.** That headroom is the reason to care about event volume at all.

## 3. 30% of `analytics_events` is not PostHog cost — do not attribute across it

15-day window, all platforms, n=201,000:

| platform | rows | reaches PostHog? |
|---|---:|---|
| ios | 141,205 | **yes** — `PostHogSDK.shared.capture` on every `track()` |
| server | 52,279 | **no** |
| worker | 5,363 | **no** |
| web | 2,153 | unverified |

**There is exactly ONE `phCapture` call site in the entire server**
(`server.js:3586`, the RevenueCat webhook mirror). The sink's own docstring says
server capture is "reserved for events only the server truly knows." So the
57,642 server+worker rows are **DB-only**. Attributing the bill across all
`analytics_events` would have overstated the server's share by ~30% and aimed the
fix at the wrong emitter.

## 4. Read census — and its honest limit

Of the 32 iOS event names, **22 are read by ZERO scripts or reports in this
lane.** The top of the volume table is almost entirely unread:

| event | /day | share | read by our tooling |
|---|---:|---:|---:|
| `api_outcome` | 1,643 | 20.7% | **0** |
| `offerings_loaded` | 1,594 | 20.0% | 1 |
| `session_started` | 1,205 | 15.2% | **0** |
| `upload_started` | 785 | 9.9% | 1 |
| `result_viewed` | 454 | 5.7% | 4 |
| `upgrade_wall_viewed` | 411 | 5.2% | 2 |
| `upload_completed` | 276 | 3.5% | **0** |
| `not_talking_head_warned` | 257 | 3.2% | **0** |

**THE LIMIT, STATED SO IT IS NOT OVERREAD: this measures OUR tooling, not
PostHog.** A dashboard, insight or funnel in PostHog reads none of our files, and
I cannot see PostHog's query history. **"read_by=0" means "no script in this lane
consumes it" — it does NOT mean nobody looks at it.** Treating it as a retire
list would delete the owner's dashboards. It is a *candidate* list requiring one
human check.

Two of the three biggest are also suspiciously per-session:
`api_outcome` at **1.36 per session** and `offerings_loaded` at **1.32 per
session** — both generic catch-alls firing more than once per launch, and both
the shape that a closed investigation leaves behind.

## 5. What I recommend, ranked — and it is not the ranked event list

1. **Read the PostHog billing breakdown by product.** Free, 30 seconds, and it
   converts §2 from `[INFERRED]` to `[MEASURED]`. Nothing else should be done
   first, because every lever below depends on which line item is actually $280.
2. **If replay dominates (expected): sample it.** PostHog supports a replay
   sample rate; 10% keeps the diagnostic value of replay for a tenth of the cost,
   and costs one config line in `PromptlyApp.swift`. Turning `screenshotMode` off
   is NOT available — the code comment says it is the supported SwiftUI path.
3. **Only then consider events, and only for headroom, not for money.**
   `api_outcome` + `offerings_loaded` are **40.7% of tracked volume** and near-
   unread; halving their per-session duplication buys ~20% headroom against the
   1M tier. **It saves $0 at today's bill.**
4. **Instrument the blind terms.** Replay recordings and autocapture events have
   no counter anywhere in this system. That is why a $280 bill was the first
   signal — the standing failure shape where the thing nobody measures is the
   thing that bleeds.

## 6. Board line

`analytics_spend` joins cost and speed as a standing term: **$280/cycle,
~$9.20/day** — for comparison, agent/ephemeral spend is $0.37/day and orchestration
is ~$25.94/day. **Analytics is currently the third-largest line on the cost board
and the only one with no instrument behind it.**
