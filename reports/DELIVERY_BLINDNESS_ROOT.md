# DELIVERY BLINDNESS — the primary path DOES stamp; the stamp is thrown away

**JUDGE, 2026-08-14. Answers priorities (2) and (3), and CORRECTS my own 48h
verdict. [CODE]-cited, $0.**

## (2) Does the primary path stamp and lose a race, or not stamp at all?

**Neither. It stamps correctly, and then the stamp is DISCARDED.** Not a race —
a structurally always-false predicate.

The chain [CODE]:

1. `server.js` settles the callback with `via: 'callback'`, and
   `stampDelivery` is first-stamp-wins [CODE modal-webhook.js:14-17]. So
   `output.completion_delivery = 'callback'` **is** written, correctly.
2. Back in the dispatcher, that stamped object is `result`. It then faces
   [CODE dispatch-to-modal.js:1421-1424]:

```js
const _delivered = !!result && (
  String(result.status || '').toUpperCase() === 'COMPLETED'
  || (result.output && (result.output.video_url || result.output.public_url
                        || result.output.rendered_video_url)));
```

3. **Both disjuncts are structurally false on the success path:**
   - the worker returns `"status": "success"` [CODE handler.py:40050], and
     `"SUCCESS" !== "COMPLETED"`;
   - `registerPendingModalJob` resolves with the **output itself**
     [CODE modal-webhook.js:81], so `result` **IS** the output. `result.output`
     is `undefined`, and the URL actually lives at `result.video_url`.
4. `_delivered === false` for every successful job → the projection path runs →
   `stampDelivery(recheck.output, 'reconciler')` stamps a **different object**
   freshly read from Supabase → `result = recheck` → **the `callback` stamp is
   discarded with the object that carried it.**

That is why `callback` has never appeared once in 432+ completions, while p50
sits at 86s: **delivery is fast and working; the instrument overwrites its own
evidence.**

**This is not only an instrument bug.** Every successful job takes an
unnecessary extra Supabase read and enters `respawnDecision`. It returns
`project` while the durable write is present — but if a re-check ever lands
*before* that write, the decision is `respawn` and a **completed job re-renders
and is paid for twice.** The blindness and a double-pay risk are the same defect.

**Fix (builder's, one predicate):** accept the worker's real vocabulary and read
the URL where it is written —
`['COMPLETED','SUCCESS'].includes(status)` **or** `result.video_url ||
result.public_url || result.rendered_video_url` (keeping the nested `result.output.*`
form for the recovery shapes). Then preserve the existing stamp rather than
re-stamping a replacement object.

**Making the three paths distinguishable** then follows for free: `callback`
(primary), `durable_poll` (75s poller), `repair`/`reconciler` (recovery),
`fallback_timer` (900s). All five values already exist in code; only the
predicate is stopping four of them from ever being observed.

## (3) The 23 repairs — why the completion write still misses

[MEASURED] 23 rows, **23 distinct users** (no retry inflation), e2e clustered
**901.0–907.2s** (median 904.2s), spanning 08-11T23:54 → 08-14T12:18.

**Two facts name the mechanism:**

1. **904s ≈ 900s + ~4s.** That is the 15-minute `registerPendingModalJob`
   timeout, then the repair pass. These jobs waited out the full fallback timer.
2. **`stage_timings` is absent on all 23 of 23.** The worker's result envelope
   never reached the row at all — so this is not the stamp-overwrite class
   above. For this cohort the completion POST **and** the 75s durable poll
   **and** the worker's own durable Supabase write all missed; `repair`
   reconstructed the completion from the rendered artifact in S3.

So the answer to "why does the write still miss": for these 23 the worker
produced a render but **no result envelope ever landed in Postgres**, which
matches the worker-side hang class (a wedged `write_job_status` under the job
lock leaves exactly this signature: artifact in S3, row untouched, no timings).
The 15s postgrest timeout + terminal-write receipts shipped for that class are
the relevant fix; this cohort is its user-visible tail.

## CORRECTION to my own 48h verdict

I reported *"the fallback timer settled NOTHING in three days."* That is
**stamp-accurate and user-experience-wrong**, and I withdraw the framing. The
900s timer **fired 23 times**; it simply did not get to *stamp*, because when
its check finds no completion the repair path rescues the render and stamps
`repair` instead. The correct statement: **the 900s wall is still load-bearing
for ~5% of completions; it was relabelled, not removed.** 23 real users waited
~15 minutes for a video that had already rendered.

## PRE-REGISTERED — what the quiet window will and will not mean

Last repair **08-14T12:18Z**; **11.5 hours** and **91 terminal completions**
have since passed with zero repairs.

- Active-window repair rate: **23 / 459 = 5.01%** of completions.
- Expected repairs in the quiet window at that rate: **4.56**.
- P(0 | rate unchanged) = **0.010**.

**So the quiet window IS statistically meaningful (p=0.01) — and I still will
not call it healed.** A zero has two parents: the bug stopped, or the
*instrument* stopped. If the repair path itself broke, repairs read 0 exactly
the same way. Per the standing law, no zero is believed until the probe fires
on a known-bad window.

**Binding conditions to claim "repair class healed":**
1. ≥60 further repair-free completions (expected ≥3 at the old rate, p<0.05
   independently of the current window), **AND**
2. the repair path is proven still armed — a deliberately orphaned completion
   (row non-terminal with the artifact present in S3) is shown to be *counted*
   as `repair`, **AND**
3. no migration of the same 900s band into another stamp — check the
   [870,920] band by `completion_delivery`, not just the `repair` count.

If (1) holds but (2) is not run, the honest report is *"consistent with healed,
unproven"* — not healed.
