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

---

# CONFIRMED — the owner's PostHog figures settle it. The bill is 100% session replay.

**2026-08-20, second pass.** Owner-supplied from the PostHog console: **865k
events/month**, a **step change on Jul 28**, **37k mobile recordings**. This
converts §2 from `[INFERRED]` to `[MEASURED]` and confirms the diagnosis.

## The arithmetic, and it is unambiguous

| term | value | cost |
|---|---:|---:|
| events/month | **865,000** | **$0** |
| PostHog free tier | 1,000,000 | — 86.5% of a FREE allowance |
| recordings/month | **37,000** | |
| replay free tier | 5,000 | |
| **billable recordings** | **32,000** | **$280 → $0.00875 each** |

**Events cost nothing. Session replay is the entire $280.** My first-pass
inference was right, and the ranked event-retirement list would have recovered
exactly zero dollars.

**Recordings per session: 37,000 / 36,600 = 1.01.** Replay is recording
**essentially every session, unsampled** — the default, never tuned.

## The Jul 28 step change is an ADOPTION curve, not a config flip

`sessionReplay` and `captureScreenViews` were written in **one commit,
`8b8e3b9` on 2026-07-20**, and a `git log -S` across all branches shows **that
config has never been modified since**. The step is therefore not a change in
what the app does — it is **1.3.3 (builds 220/221, shipped Jul 27) reaching real
devices on Jul 28**. Nothing was turned on that day; the code that was already
written simply arrived.

## Which names carry the volume — and 72% have no name at all

| slice | events/mo | share | in Supabase? | read? |
|---|---:|---:|---|---|
| **autocapture** (screen views + lifecycle) | **623,237** | **72%** | **NO** | **never** |
| tracked, named (32 names) | 241,763 | 28% | **YES — every one** | 10 of 32 |

**The volume is carried by events that have no name in our registry.** The 32
named events I could measure are the *minority* of PostHog's ingestion. The
autocapture majority is invisible to every instrument we own, has never been
queried, and exists because the SDK defaults to on.

## The duplication cross-check — and it cuts both ways

`AnalyticsService.track()` writes **both** sinks unconditionally, so:

- **Every one of the 241,763 tracked events is ALREADY in Supabase**, with the
  same name, the same props, plus `app_version`, `platform`, `territory`,
  `storefront`, `anon_user_id` and `user_id`. **PostHog holds nothing about them
  that `analytics_events` does not.** 28% of ingestion is byte-for-byte
  duplicative.
- The 72% that is **not** duplicative — autocapture and replay — is precisely
  the part **nobody asked for and nobody reads.**

**Both halves are waste, for opposite reasons.** The duplicated half is free and
redundant; the unique half is unread and is the whole bill.

## "A $280/month line with no reader" — proven, not asserted

- **26 reports exist in this lane. ZERO cite a session recording.** The only
  file in the repository that mentions session replay is *this* one, written
  today to explain the bill.
- **22 of 32 named events are read by zero scripts or reports here** — with the
  §4 limit still standing: that measures our tooling, not the owner's PostHog
  dashboards.
- **Replay carries no such caveat.** A recording is watched by a human or it is
  not watched at all, and no analysis in this lane has ever cited one.

## The call

1. **Set the replay sample rate.** At 1.01 recordings/session, 10% sampling
   takes $280 → **~$28** and still yields ~3,700 recordings/month — far more than
   the zero anyone has watched. One config line in `PromptlyApp.swift`.
   `screenshotMode` stays: the code's comment says it is the supported SwiftUI
   capture path.
2. **Turn autocapture off** (`captureScreenViews`, `captureApplicationLifecycle
   Events`). It is 623k events/month, unnamed, unread, and not in Supabase. It
   costs $0 today but consumes **62% of the free tier**, which is what would push
   the next increment of real growth over 1M into paid ingestion.
3. **Decide whether PostHog earns its place at all.** With replay sampled and
   autocapture off, what remains is 242k events that are **already in Supabase**.
   The honest question is not which events to retire — it is whether the funnel
   UI is worth a second copy of data we already own and already query.
