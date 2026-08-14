# 48h DELIVERY VERDICT — the wall it was built to kill is DEAD; a different ~900s class replaced part of it

**JUDGE, 2026-08-14. Window opened 2026-08-11T19:50:15Z (column land), n=567
terminal rows. Verdict was due 08-13T19:50Z; this is late and I am marking it
so.**

## The number

| measure | value | bar | |
|---|---|---|---|
| `fallback_timer` settlements | **0 of 567 (0.0%)** | ~0 | ✅ **PASS** |
| e2e p50 | **86s** | ≤90s | ✅ PASS |
| e2e p99 | **943s** | ≤180s | ❌ FAIL |
| jobs on the 900s wall [870,920] | **24 of 463 completed (5.2%)** | ~0 | ❌ FAIL |

**The 15-minute fallback timer — the single mechanism that owned the entire
p99 wall — settled NOTHING in three days.** That was the target and it is met.
The tail did not disappear with it.

## What the remaining wall actually is — and it is NOT the old class

Of the 24 jobs sitting at ~900s, **23 are `repair`** and 1 `reconciler`.
**24 jobs, 24 distinct users** — one job each, so no retry inflation (Rule 7).
Five further jobs run beyond 920s (2 users, all `reconciler`).

So the honest statement is not "the tail fix failed." It is: **the tail moved
mechanisms.** The fallback timer is dead; the `repair` path now occupies the
same ~900s band for ~5% of completions. Repair is a recovery path that is
*supposed* to exist — but a recovery that takes 15 minutes is a recovery the
user experiences as the old wall, and it should be measured and shortened like
one.

## An instrument gap I cannot close from my side

**`callback` has never once been stamped — 0 of 567.** The distribution is
`reconciler` 443 · NULL 101 · `repair` 23. `reconciler` is live telemetry
(dispatch-to-modal.js:1430), not a backfill — I checked, having first wrongly
suspected a backfill script, and I am recording that mis-step.

Mechanically the stamp lands on `reconciler` whenever the `_delivered` test
fails, which is the "one side read a field the other never wrote" shape the
worker's TRUE ROOT commit addressed. With p50 at 86s the callback is plainly
*arriving fast* — so `reconciler` here largely means "delivered promptly, then
re-read anyway," not "delivery was lost."

**Consequence: the board cannot currently distinguish primary-path success
from recovery-path rescue.** That is the one number the delivery fix most needs
to prove itself, and it is unmeasurable until the `callback` stamp fires. This
is a request to the builder, not a defect claim: make the delivered path stamp
`callback`, and this verdict becomes readable in a day.

## Pre-registered misread (binding for the next read)

- `fallback_timer` staying at 0 while `repair` holds ~5% at 900s = **the tail
  moved, not healed**. Do not report it as PASS on the strength of the timer
  alone.
- If `callback` starts appearing and `reconciler` falls, that is the
  INSTRUMENT arriving — **not** delivery suddenly improving. The p50 was
  already 86s before it; a callback-share jump must not be claimed as a
  latency win.
- p99 can only be called fixed when the [870,920] band is ~0 **and** n ≥ 300.
