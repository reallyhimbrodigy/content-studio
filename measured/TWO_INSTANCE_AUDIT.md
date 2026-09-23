# Is the server stateless? Audit before going to 2 instances
Builder 2 · 2026-09-23 · content-studio `main`

Surveyed every module-level `new Map()` / `new Set()` / `setInterval` in
`server.js`, `lib/*.js` and `services/*.js`. Classified by what a SECOND
instance does to it, not by whether the state exists — every one of these is
correct on one instance, which is why none of them looks wrong in review.

## ONE THING BREAKS, AND IT BREAKS SILENTLY

### `sseClients` — `server.js:747`

```js
const sseClients = new Map();          // jobId -> Set<res>
function pushProgressToSSE(jobId, data) {
  const clients = sseClients.get(jobId);
  if (!clients || clients.size === 0) return;      // <-- silent
  ...
}
```

The **client** holds an SSE stream open against whichever instance the load
balancer gave it. The **producer** is the Modal completion webhook
(`server.js:2750`, `:2765`) and the cancel route (`:6800`), which arrive on
whichever instance the load balancer gives *them*. Those are independent
draws, so on two instances roughly **half of all renders push progress to an
instance that has no client for that job**, and `pushProgressToSSE` returns
without a word.

Severity is set by what happens next: the durable status layer still lands the
result, so the video is not lost — the user watches a progress bar stop moving
and the video appears later through the fallback. **It reads as a slow render,
not as a broken one**, which is the worst available failure mode because it
routes the investigation into the render path.

Three ways out, in order of how much they cost:
1. **Sticky sessions** on the SSE route only. Cheapest, and it fails closed —
   an instance restart drops the stream and the client reconnects.
2. **Publish progress through the database** and have each instance push what
   it reads for its own clients. No broker, one extra write per progress tick.
3. **A broker** (Redis pub/sub). Correct and the most infrastructure.

Nothing else in the survey has this shape.

## WEAKENS — correct, but the guarantee halves

| what | where | on 2 instances |
|---|---|---|
| `_rateBuckets` | `server.js:328` | every limit becomes **2× per instance**. `checkRateLimit(res, 'submissions:upload-url', ip, 100, 600)` admits 200/600s. A limit, not a lock — nothing corrupts. |
| `_selfHealNextAllowed` | `server.js:329` | self-heal cooldown halves; it can fire twice per window. |
| `spend-guard._firedAlerts` | `lib/spend-guard.js:27` | **alerts only, never the count** — the file says so, and the cap itself is DB-counted. Two instances page twice per threshold per day. Noisy, not dangerous. |
| `dark-refusals._counts`, `job404-guard` | both libs | per-instance de-dupe of LOG noise. Double lines, no behaviour. |

## SAFE — already designed for this

| what | why it holds |
|---|---|
| `withKeyLock` / `_keyLocks` (`server.js:1512`) | **one call site** (`:7142`, `render:${userId}`), and the real guard is the DB advisory lock behind `claim_usage_slot` (`:3423`). The comment says it outright: "Single-process scope; the DB advisory-lock RPC covers the multi-instance case." Verified rather than believed — I checked there is no second call site relying on the in-memory lock alone. |
| `runOrphanRedispatch` | claims with `.is('modal_call_id', null)` plus a CAS on `updated_at`. A second sweep matches zero rows. **This is the one that would cost money if it were wrong** — a double dispatch is a double Modal charge. |
| `runRefundLeg` | claims `refunded_at NULL -> now()` atomically; only the winner refunds. |
| `api-outcome-ledger._buckets` | **INSERTs**, never upserts. Two instances produce two partial rows per window, which sum correctly. |
| `install-seen.cache` | read-through with a TTL, and "a seen device never becomes unseen". Two caches means a doubled miss rate, not a wrong answer. |
| the other 8 `setInterval` sweeps | each writes through a DB claim or is idempotent; they run twice and converge. |

## THE ANSWER

**One blocker: `sseClients`.** Everything else is either already guarded at the
database or degrades in a direction that is visible and harmless.

Fix that one — sticky sessions on the SSE route is enough — and two instances
is safe.

## THE PART THIS AUDIT CANNOT DO

It read module scope. It did **not** prove that no request handler stores state
on a closure that outlives the request, and it did not test anything: it is a
reading of the source, not a run with two instances behind a balancer. The
honest check before launch is to run two locally and drive one render through
with an SSE client attached — that is the only thing that would have caught
`sseClients` without knowing to look for it.
