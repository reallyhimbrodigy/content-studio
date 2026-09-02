# Server contract — `POST /api/reverse-trial/grant`

**Owner: BUILDER (server).** Frontend's spec is right and this builds to it. The
response shape is here **before wiring**, so the client trigger and expiry
surface are built against something real.

---

## Why this is a server endpoint at all

`grant_referral_reward` and `qualify_referral` were revoked from `authenticated`
in the referral security migration, and `referral_rewards` inserts run as
`service_role`. That revoke closed a live exploit — three throwaway accounts for
a week of unmetered Pro. **Letting the client self-grant a 72-hour trial reopens
that hole under a friendlier name.** So the grant lives here.

---

## Request / response

```
POST /api/reverse-trial/grant
Authorization: <Supabase user>
→ { "device_id": "<stable, reinstall-surviving id>" }

201 { "granted": true,  "pro_until": "2026-09-03T04:12:07Z",
      "expires_in_seconds": 259200, "already": false }
200 { "granted": true,  "pro_until": "2026-09-03T04:12:07Z",
      "expires_in_seconds": 118431, "already": true }     ← idempotent replay
409 { "error": "already_used",  "device_id_seen_at": "2026-08-01T…" }
400 { "error": "device_id_required" }
429 { "error": "rate_limited" }
503 { "error": "grant_unavailable" }
```

**`201` vs `200 already:true` is the idempotency signal.** A double-tap on
Decline returns the *same* `pro_until`, never a second grant. The client can
render both identically; the distinction exists so a replay is visible in logs
rather than looking like two grants.

`expires_in_seconds` is computed at response time, not stored — the client
should drive its countdown from this rather than from clock arithmetic on
`pro_until`, which drifts against device clock skew.

---

## The four properties, as implementation

### 1. 72 hours from grant timestamp, never calendar days
```js
const untilMs = Date.now() + 72 * 3600 * 1000;
```
Not `startOfDay + 3`. A decline at 23:50 must yield 72 hours, not eight.

### 2. Once per install, server-enforced

Keyed on `device_id`, in a dedicated table (below) — **never a client flag**,
which is a reinstall away from free Pro forever.

> **⚠ BLOCKING QUESTION FOR FRONTEND — this property depends entirely on the
> answer.** `device_tokens`' own migration states: *"the same physical device
> generates a fresh token after reinstall."* So the **APNs push token cannot be
> this key** — reinstall would re-grant, which is the exact hole being closed.
>
> **What is `device_id` in 241?**
> - **Keychain-persisted UUID** → survives app deletion. Correct key. ✅
> - **`identifierForVendor`** → resets when all vendor apps are removed, and is
>   not guaranteed across a delete/reinstall. **Weaker than the property
>   requires**, and I would not call the endpoint once-per-install if this is it.
> - **Anything derived per-launch** → not a key at all.
>
> I have not assumed an answer. If it is IDFV, say so and we decide explicitly
> whether that is good enough rather than discovering it from a support ticket.

### 3. Idempotent
The device row is claimed with a unique constraint on `device_id`; a second
grant attempt hits it, reads the existing row, and returns `200 already:true`
with the **original** `pro_until`. A double-tap cannot produce 144 hours.

### 4. Does not consume the free export
The endpoint touches `pro_until` and the reward ledger only. It writes **no**
`usage_events` row and does not mark the free export used.

---

## Where the grant lands — one path, not a second

Through `profiles.pro_until` **and** the existing `referral_rewards` ledger with
`provider:'db'`, `provider_ok`, following the exact sequence the referral grant
already uses:

1. Read the rolling-30-day SUM of `days_granted` for this user.
2. Read `profiles.pro_until` → `pro_until_before`.
3. **Insert the ledger row first with `provider_ok: false`** — a row exists
   either way, so a failed grant is visible rather than silent.
4. Update `profiles { tier:'pro', pro_until }`.
5. On success, flip `provider_ok: true`.

**It counts against the same rolling-30-day cap.** `days_granted: 3` for cap
arithmetic, while `pro_until` is the exact 72-hour timestamp. If the trial did
not SUM against that cap, the two paths together would be an **uncapped Pro
faucet** — referrals capped, trials unbounded, both writing the same column.

**Cap-exhausted behaviour:** if the 30-day cap has no room, the grant is
**refused** (`409 { error: "cap_exhausted" }`), not silently truncated. A
one-hour "72-hour trial" is worse than an honest no.

---

## Migration

```sql
CREATE TABLE IF NOT EXISTS reverse_trial_grants (
  device_id   text PRIMARY KEY,           -- the once-per-install claim
  user_id     uuid NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  pro_until   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reverse_trial_user ON reverse_trial_grants (user_id);
```

`device_id` is the **primary key**, so once-per-install is a database
constraint rather than application logic. Two concurrent requests cannot both
insert.

---

## Verification bar

- a double-tap grants **once**, and the second response carries the *original*
  `pro_until`,
- a reinstall does **not** re-grant (**contingent on the blocking question**),
- 23:50 + grant = 72 hours, not 8,
- the free export is **still available** after a grant,
- a user at the 30-day cap is **refused**, not given a stub trial.

Each with a control arm — "no second grant happened" and "the test never ran"
are otherwise identical.
