# IDENTITY SPLIT — REFUTED, and what is actually broken instead

**JUDGE, 2026-08-11. This report exists because `IOS_FINAL_BUILD.md` item 5
cites me for a "post-cancel identity split" that my own data does not support.
Correcting it on the record is the point of this lane.**

## VERDICT: there is NO post-cancel analytics identity split. [MEASURED]

Window 2026-07-25 → 2026-08-11, **228,082 analytics_events**, all sinks.

| test | result |
|---|---|
| users bound to >1 anon id (the classic split) | **0** of 8,900 users |
| anon ids bound to >1 user_id (device carrying two people) | **0** of 23,299 |
| iOS-only anon ids regressing identified → NULL (a stray `reset()`) | **0** of 23,245 |

**My own false positive, named:** a naive pass over the mixed event stream
reported *1,194 anon ids regressing to `user_id=NULL` after being identified*.
That number is an ARTIFACT and I am withdrawing it. Server events
(`render_started`, `push_sent`, `prewarm_frozen` — 60,249 rows, 99.9% carrying
`user_id`) interleave with client events, which carry `user_id` only when the
device is identified *at that moment*. Sorting the two sinks together makes a
normal pre-identify client event look like a post-identify regression. Cut to
**iOS-only** rows — the correct control, since only the client can call
`reset()` — the count is **exactly zero**. The client identity contract
(`identify()` at auth resolve, `reset()` only on sign-out) is holding.

**Consequence for the iOS build: item 5 should be DELETED, not implemented.**
Rewriting a correct `reset()` call site on my unsourced say-so is pure risk.

## What IS broken — the RevenueCat identity, not the analytics identity

The adjacent real defect, which I believe was the germ of the claim:

**`rc_identify_failed` — 10 events, every one an unretried dead end.** [MEASURED]
All carry `anon_user_id` = `$RCAnonymousID…` and `user_id` = NULL, all after
**3 attempts**, all network/TLS ("A TLS error caused the secure connection to
fail", "The network connection was lost"). Dates: 08-01 (×5), 08-04, 08-08 (×3),
08-10.

That is a **RevenueCat** identity split: `Purchases.logIn(supabaseUserId)`
failed, so the device stays on an `$RCAnonymousID`. Everything the SDK then
reports is keyed to an id our profiles table has never seen. If a purchase
lands in that state, the webhook cannot match a profile — the
`no_profile_matched` → 500 → RC-retry path — and the subscriber is stranded
exactly as an orphaned purchase.

**Scale of the exposure** [MEASURED, 7d 08-04→now, 172,482 events]:
`offerings_loaded` fires **26,230** times, of which **8,406 (32%) carry a
`$RCAnonymousID`** — a paywall whose data loaded while RC was still anonymous.

**Has it cost money yet? NO — and that is the honest read.** Every
`purchase_started` (238), `purchase_failed` (228) and `purchase_completed` (4)
in the window is **100% identified**. So the anonymous window closes before
anyone transacts; the 10 failures are a live *risk*, not a realized loss. I am
not inflating it.

**The one-line client ask (replaces item 5):** `rc_identify_failed` must not be
terminal after 3 tries — retry `logIn` with backoff on app-foreground and
before presenting the paywall, and refuse to present the purchase sheet while
the RC id is still `$RCAnonymousID`. Cheap, and it closes an orphaned-purchase
class before it can strand a paying customer.

## Method (re-runnable, $0)

`analytics_events` paginated 1,000/page; splits computed as set-cardinality per
id in both directions; the regression test re-run with `platform='ios'` as the
control. No LLM, no Modal.
