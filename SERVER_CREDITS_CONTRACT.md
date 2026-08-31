# Server contract — credits: debit at dispatch, refund on failure

**Owner: BUILDER.** The client half (read + display) is being built now and is
inert without this. Can start in parallel — nothing here depends on the client
landing first.

---

## Why the server owns the mutation

RevenueCat's iOS SDK **5.75.0** (confirmed in the tree) exposes Virtual
Currencies **read-only**:

```swift
Purchases.shared.virtualCurrencies() -> VirtualCurrencies   // .all[code].balance: Int
Purchases.shared.invalidateVirtualCurrenciesCache()
```

There is **no client-side spend, debit, adjust or grant** — zero matches across
the whole SDK. So the client can show a balance and nothing else.

That split is correct on its own terms: a client-side debit is trivially
spoofable, and it would drift from the server's own render accounting the first
time a dispatch succeeded while the client died mid-write.

---

## The model

| | |
|---|---|
| cost | **10 credits per video, flat** — regardless of source length or route |
| Free | 30/month | 
| Pro | 200/month |
| Max | 1000/month |
| re-edits | **free on every tier, never charged** |
| failed render | **refunded instantly and visibly** |

Refresh is on the billing cycle. Free refreshes monthly too.

---

## What the server must do

### 1. Debit at dispatch — not at completion

Charge **10** when the render is accepted at `POST /api/video-jobs`, not when it
finishes. Charging at completion means a user can queue N renders against one
balance.

Debit via RevenueCat's server REST API against the same `app_user_id` the
webhook already uses. **A re-edit must not debit** — `/api/video-jobs/re-edit`
is free on every tier, which is also the argument that keeps a zero-balance user
in the product.

### 2. Refund on failure — and say so

Every terminal failure refunds the 10 credits. The existing refund-leg law
already says a failed row refunds; this adds the credit half.

**It must be visible.** A silent balance restore is indistinguishable from never
having been charged, so the user cannot tell the system did the right thing. Emit
an event the client renders as an in-thread refund message — the same channel the
render status already uses, so it appears in the conversation where the failure
did.

### 3. Idempotency

`client_job_id` is already the idempotency keystone — a double-submit replays the
existing job rather than minting a duplicate. **The debit must ride the same
key**: a replayed dispatch must not double-charge. This is the single most
important correctness property here, because the failure is invisible to the user
and only shows up as a balance that drains faster than their render count.

### 4. Zero balance

Return a **distinct, typed refusal** — not the generic 402 the export wall uses.
The client renders a specific in-thread message naming the balance, the refresh
date, and Max. If it arrives as the same 402 as the export gate, the user gets
"upgrade" copy for a problem upgrading may not solve, and the two conversions
become unreadable from each other.

Include in the payload: current balance, the cycle refresh date, and the cost of
the action that was refused.

---

## What the client already sends

- `device_id` on the dispatch (see `44a6184`) — auth-stable, so `render_started`
  can finally be joined to the client funnel. **Please echo it onto the
  server-emitted event**; without it the render tail of every funnel is
  structurally unjoinable and reads as 0%.

---

## What I need back

1. The **refusal shape** for zero balance (status + body), so the client can
   render the right surface rather than falling through to the paywall.
2. The **refund event** name and payload.
3. Confirmation that **re-edit does not debit**, since that is a product promise
   and not merely an implementation detail.

---

## Not in scope here

Balance display, the zero-balance surface, the free-export-used gate, and the
paywall claim rewrite are all client-side and in progress. The claim rewrite
matters to you only in that **"Unlimited videos, no daily cap" becomes false the
moment this ships** — it is already flag-matched to the meter, so the copy
follows whichever state the meter is actually in.
