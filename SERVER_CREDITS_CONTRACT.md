# Server contract — credits, debit/refund, and where the balance lives

**Owner: BUILDER (server).** Frontend cannot ship credits without this half.
This is the interface the two halves meet at, written *while* building so it is
not reconciled afterwards.

---

## The four rulings this encodes

1. **Debit at render dispatch, server-side.** Never on the client — a client
   debit is spoofable and would drift from render accounting.
2. **Credit back on failure, and the user SEES it.** An event the client renders
   as an in-thread refund message. A silent restore is not acceptable.
3. **Re-edits never debit.** On any tier.
4. **RevenueCat is authoritative.** Free 30/month refreshing, Pro 200, Max 1000.
   **We do not build a second ledger.**

---

## Why this is all server-side REST

RevenueCat Virtual Currencies is **read-only from the client SDK**. Every
mutation is a v2 REST call with the secret key, so the client can *display* a
balance but can never change one. That is the property that makes ruling 1
enforceable rather than merely intended.

The server already speaks RC v2 (`REVENUECAT_API_BASE`,
`reconcileEntitlementFromRevenueCat`), so this extends an existing integration
rather than adding a dependency.

---

## The endpoints

### `POST /api/credits/balance` → read-through

```
→ {}                                    (auth: Supabase user)
← { balance: 42, tier: "pro", allowance: 200, currency_code: "CRD", found: true }
```

`found:false` with `balance:0` distinguishes "this customer has no row for our
currency" from "this customer has zero" — they are different states and a single
`0` hides which one you are looking at.

Read-through to RC. **No DB copy is written.** If RC is unreachable this returns
`503` with `{ error: "balance_unavailable" }` — it does NOT fall back to a cached
number, because a stale balance that looks authoritative is worse than no
balance. The client shows the last value it held with a staleness marker.

### Debit — **not an endpoint.** It happens inside dispatch.

There is deliberately no `POST /api/credits/debit`. If it existed, it would be
callable, and ruling 1 would be a convention rather than a property. The debit
runs inside the existing render-dispatch path, before Modal is spawned, in the
same place the quota/entitlement gate already runs.

### `POST /api/video-jobs` (existing) — debit leg

```
BEFORE spawn:
  if (!shouldDebit({mode}))  → NO DEBIT                      (ruling 3)
  else try { await credits.debit(userId, 10) }               (attempt, no pre-read)
       catch INSUFFICIENT   → 402 { error:'insufficient_credits', needed:10 }
       catch UNREACHABLE    → 503 (do NOT spawn, do NOT free-render)
  → spawn
```

**CORRECTED 2026-08-31, after reading the RC v2 reference.** This originally
read "if (balance < COST) → 402 else debit" — a **TOCTOU race**: two concurrent
renders could each read 10 and each spend it.

RevenueCat **validates the balance and deducts atomically**, returning HTTP
**422** with `retryable:false` and **deducting nothing** when the balance is
short. So the check and the spend are one operation, at the place the balance
actually lives. There is no pre-read, and `402` is derived from RC's 422 rather
than from a number we compared ourselves.

The second correction: **RC documents no idempotency key on this endpoint.**
Exactly-once therefore cannot come from RC and must come from our claim marker.
Any design that assumed a safe retry would double-spend.

`COST_PER_RENDER = 10`.

**Order is load-bearing: debit BEFORE spawn.** Spawn-then-debit can spend GPU on
a render the user could not pay for. Debit-then-spawn can debit a render that
fails to spawn — which is why the refund leg below keys on *terminal state*, not
on spawn success.

---

## The refund leg

**Reuse `lib/refund-leg.js`'s shape; do not write a second one.** That module
already encodes the ruling that matters:

> a refund fires on EVERY transition to a terminal failure state, regardless of
> source — worker error, designed rejection, reaper stall. Users pay for
> renders, not failures.

and the idempotency that makes it safe: a job is CLAIMED by flipping an
app-owned marker `NULL -> now()` atomically, so only the winning pass refunds
and every route (sweep, reaper, cancel) is idempotent against every other.

Credits need the same marker, separate from the existing charge one:

```sql
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS credits_debited integer;
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS credits_refunded_at timestamptz;
```

`credits_debited` is **not a ledger** — it is the receipt of how much to give
back, so a refund cannot guess. RC remains the balance.

**Claim, then call RC.** If the RC credit call fails, UNCLAIM
(`credits_refunded_at -> NULL`) so the next sweep retries. Claiming after the
call would drop refunds on a transient RC error.

---

## The event the user sees (ruling 2)

A refund the user cannot see is indistinguishable from being charged. So the
refund leg emits, on the same channel the chat thread already consumes:

```json
{ "type": "credits_refunded",
  "job_id": "…", "amount": 10, "balance_after": 42,
  "reason_code": "RENDER_FAILED" }
```

`reason_code` is a **code, not a sentence** — the same mechanism the error copy
uses, so the words live in the iOS String Catalog where the localization gate
covers twelve languages. A server-authored sentence here would render English to
every reader, which is the exact gap being closed elsewhere this week.

Codes: `RENDER_FAILED`, `DESIGNED_REJECTION`, `STALLED`, `CANCELLED`.

---

## What must NOT be built

- **A credits table we treat as truth.** Balance is RC's. The two columns above
  are a claim marker and a receipt, nothing more.
- **A client debit path.** See above.
- **A silent refund.** See ruling 2.
- **A second refund module.** Extend the existing leg.

---

## Open questions for Frontend

1. **Insufficient-credits UX**: `402` carries `balance` and `needed`. Does the
   client route to paywall, or to a "wait for refresh" state? The server does
   not decide this; it reports the two numbers.
2. **Balance staleness**: on a `503`, what does the client show? Proposal: last
   known value, visibly marked stale, and no debit attempt until a read
   succeeds.
3. **Does the free tier's 30/month refresh land as an RC grant** we read, or do
   we need to trigger it? If we trigger it, that is a fifth ruling and needs its
   own idempotency marker.

---

## Verification bar

Not "the endpoint returns 200". The bar is:

- a render debits **exactly once** under a double-submit,
- a failed render refunds **exactly once** under concurrent sweep + reaper,
- a re-edit debits **zero** on Free, Pro and Max,
- and the refund **appears in the thread**, in the reader's language.

Each of those is a test with a control arm, because "no debit happened" and
"the test never ran" look identical otherwise.
