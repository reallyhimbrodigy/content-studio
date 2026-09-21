# The thirteen from 4d11fcf — landed, or why not

**Builder 2, 2026-09-21.** Recoverable from `4d11fcf` and tag `v1.3.36-256`.
One line per item, each either on main as its own commit or refused with a
reason. Nothing is left as "maybe later".

## Landed

| item | commit | what it was |
|---|---|---|
| `validate_token` **issuance** | `d00f7db` | NOT recovered — see below. Written fresh; it existed on no branch. |
| `result_url` in the deletion key capture | `333ea9d` | five URL columns exist, the capture read four |
| `free_credit_grants` / `free_credit_periods` on deletion | `333ea9d`, `fbf58de` | 12 orphaned rows in each; grants SCRUBBED, periods deleted |

## Refused, with the reason

### `lib/video-processor/dispatch-to-modal.js` +33/−1 — **DO NOT LAND**

Two things, and neither survives contact with today's ruling.

**`clientValidateAuth()` is superseded and its fallback is now forbidden.** It
resolves `MODAL_VALIDATE_SECRET` and then **falls back to `MODAL_RUN_SECRET`**.
Its own comment is honest about why: *"The fallback exists only so the client
half can ship before the separate secret is provisioned."* Zac ruled the
opposite on 2026-09-21 — required, no fallback, fail closed — and
`lib/validate-token.js` implements that.

**It is not merely superseded, it is actively dangerous right now.**
`/api/health` reads `modal_validate_secret: false` and `modal_run_secret: true`
in production. So on today's environment this function returns
**`MODAL_RUN_SECRET`** and hands the GPU dispatch secret to every client — which
is the exact outcome the same comment names as the thing to avoid: *"sharing
run_job's secret means an extraction also buys the ability to dispatch arbitrary
GPU renders."* The fallback defeats the separation the function exists to create.

**`WORKER_AUTH_FIELD = '_worker_auth'` is not worth the export.** The literal
occurs twice in that one module. Its other occurrences are in gates
(`__smoke_worker_dispatch_auth`, `__smoke_validate_token`) which assert the WIRE
name on purpose and must keep the literal — a gate that reads the constant would
pass a rename that breaks every shipped client.

**What IS worth keeping from it, and is kept:** the trimming lesson. Trim each
candidate, never the winner of an `||` — a whitespace-only `MODAL_VALIDATE_SECRET`
is truthy, so trimming after the `||` let it beat a perfectly good secret and
then resolve to null, leaving the endpoint reading as armed and handed nothing.
`validateSecret()` has a single candidate so it cannot hit that trap, and
`__smoke_validate_token` gates the whitespace case regardless.

### `lib/__smoke_account_deletion_job.js` — **DO NOT LAND**

It gates `lib/account-deletion.js`, a resumable-job design main does not have;
run against main it dies `ENOENT` on that module. Main's own
`lib/__smoke_account_deletion.js` gates the design main actually ships, and now
carries seven more legs. Landing this would red-gate a design decision.

### `lib/account-deletion.js` (207 lines) — **DO NOT LAND; main's inline is canonical**

Its central argument is stale. It says the handler it replaces *"deleted rows
first, then cleaned S3, and the keys live in video_jobs — already deleted by
then."* Main captures `s3Keys` in **step 1**, before any delete. Main also
measured `profiles_id_fkey` as `ON DELETE NO ACTION` and added a verify-and-retry
before the auth delete, which the module lacks. Its two real findings are landed
above; its sixth URL column, `proxy_video_url`, does not exist on the table.

### `lib/__smoke_validate_token.js` — **superseded, rewritten rather than restored**

The original gates `clientValidateAuth()` and a shared-secret design. Rewritten
against the per-user signed token: 12 legs, 4 RED-proven.

### `lib/__smoke_revoke_keeps_active.js` — **BLOCKED on code that is not on main**

It fails 10 legs with `tierAfterRevoke is not a function`. The function is the
`+32` in `lib/entitlement.js` that was reverted, so the **fix** is missing, not
just the gate. A gate without the code it guards is red furniture. Landing it
means landing that entitlement change first, which is a live billing decision
and is NOT mine to make unasked — a Max→Pro downgrade whose expiration revokes
the Pro they still pay for. **Open, and named rather than quietly dropped.**

### The remaining scripts — **not assessed, and saying so**

`crash-signatures.js`, `verify-sandbox-purchase.js`, `s3_abort_mpu_lifecycle.js`,
`sentry-pipe-notify.sh` and the two sentry fixtures are operator tooling, not on
a live request path. They are recoverable from `4d11fcf` and I have not read
them. Recorded as UNASSESSED rather than implied-refused.

## The correction this whole list rests on

`validate_token` was described as recoverable from `4d11fcf`. **It is not.** The
string appears ZERO times in `4d11fcf:server.js` and zero times on main. Three
of four pieces existed — the secret picker, the gate, and the client read shipped
in build 256 — and the **producer was never written on any branch**. So the
shipped app's `validateToken` has always been nil, which is exactly why 11 of 11
real `/validate` calls arrived unauthenticated. It was authored fresh in
`d00f7db`, not restored.
