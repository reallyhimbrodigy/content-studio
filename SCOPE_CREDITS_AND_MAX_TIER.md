# SCOPE — server-side credits meter + the Max tier row

Written 2026-09-02 against live `main` @ `4a6e719`. Every claim below is either
a file:line, a live endpoint read, or the output of running the function.

---

## Headline

**The meter is ~90% built. The Max tier row is not built, and it is the harder
of the two — because Max is currently a tier the server does not recognise as
paid at all.**

Proven by running it, not by reading:

```
isUserPro({tier:'pro',     pro_until:+30d}) -> true
isUserPro({tier:'teams',   pro_until:+30d}) -> true
isUserPro({tier:'premium', pro_until:+30d}) -> true
isUserPro({tier:'max',     pro_until:+30d}) -> false   <-- a Max subscriber is NOT pro
isUserPro({tier:'free',    pro_until:+30d}) -> false
```

**And the two items are coupled.** `/api/credits/balance` derives allowance from
`isPro`:

```js
if (_dec && _dec.isPro) tier = _dec.plan === 'max' ? 'max' : 'pro';   // server.js:6912
```

`isPro` is false for Max, so that line never fires, `tier` stays `'free'`, and a
Max subscriber is told their allowance is **30**, not 1000. Arming the meter
before the tier row lands ships a wrong number to exactly the users paying most.

---

## 1 — CREDITS METER

### Already built and on live main

| piece | where | state |
|---|---|---|
| RC v2 client | `lib/credits.js` (194 lines) | `getBalance` / `debit` / `credit` / `shouldDebit` |
| Cost + allowances | `lib/credits.js` | `COST_PER_RENDER=10`, `TIER_ALLOWANCE {free:30, pro:200, max:1000}` |
| Balance endpoint | `server.js:6892` | auth'd, rate-limited 60/60, returns `balance / currency_code / found / tier / allowance / cost_per_render` |
| Debit at dispatch | `server.js:5792` | gated `!isDemo && CREDITS_DEBIT_ENABLED && isConfigured()` |
| Refund leg | `lib/refund-leg.js` | reads `credits_debited` / `credits_refunded_at` |
| Claim columns | `migrations/20260831_video_jobs_credits.sql` | **APPLIED** — `credits_debited`, `credits_refunded_at`, `refund_attempts`, `refund_last_error` confirmed live on `video_jobs` |
| Re-edits never debit | `shouldDebit()` | ruling 3 encoded as a function, not a comment |
| Health flag | `server.js:3621` | `credits` served, default `off` |

The hard correctness work is done and done well: no pre-read (RC validates and
deducts atomically, so read-then-spend was a TOCTOU race), 422 treated as the
insufficient signal with nothing deducted, `UNREACHABLE` distinguished from
`RC_ERROR`, balance never cached and never falling back to a stored number, and
exactly-once carried by our own claim columns because RC documents no
idempotency key.

### What is actually missing

1. **Provisioning — Zac, not code.** Create the `CRD` currency in the RC
   dashboard; set per-tier grants and the **monthly refresh**. Note the monthly
   cycle is an *RC dashboard* behaviour, not something this codebase implements
   — `TIER_ALLOWANCE` is explicitly "listed here only so the balance endpoint
   can report what a user is working against."
2. **Env on Render:** `REVENUECAT_SECRET_KEY`, `REVENUECAT_PROJECT_ID`
   (`isConfigured()` requires both), optionally `REVENUECAT_CREDITS_CODE`
   (defaults `CRD`).
3. **The Max allowance is wrong until §2 lands** — see Headline.
4. **Arming, staged:** `CREDITS=1` (meter) then `CREDITS_DEBIT_ENABLED=1`
   (debit). Both currently off.

### One design correction worth making before building

**`credits_monthly` should NOT go on `/api/health`.** The client reads it there
(`creditsMonthlyAllowance = obj?["credits_monthly"] as? Int`), but `/api/health`
is **unauthenticated** — it is the pre-auth endpoint — so it cannot know the
user's tier and can only ever serve one constant. A per-tier allowance served
from an endpoint that has no user is a number that is wrong for everyone except
one tier.

`/api/credits/balance` **already returns the correct per-tier `allowance`**, and
it is authenticated. The client should read it from there. Recommend dropping
the `credits_monthly` health key from the plan rather than implementing it.

### Cost

| | |
|---|---|
| Code remaining | **~0.5 day** — allowance source decision, smoke tests on the debit/refund claim path, staged arming |
| Zac / dashboard | RC currency + grants + monthly refresh + 2 env vars |
| **Long pole** | **end-to-end verification against a real RC sandbox customer** — debit, 422-insufficient, refund-on-failure. Cannot be faked; the 422 path in particular is the one that must be seen, since it is what protects against double-spend. |

---

## 2 — MAX TIER ROW

### What exists

`TIER_RANK` already ranks Max above Pro, and the no-clobber work is done:

```js
const TIER_RANK = { max: 40, teams: 30, premium: 30, pro: 30, paid: 30, trial: 20, free: 10, none: 10 };
tierAfterGrant('max', 'pro') -> 'max'    // a grant correctly refuses to lower Max
```

So the *intent* that Max is the top tier is already in the codebase. The
*enforcement* is not.

### What is missing — four distinct gaps

**a) Three pro predicates omit `'max'`.** Each independently enumerates the paid
tiers:

- `lib/entitlement.js:24` — `if (tier !== 'pro' && tier !== 'teams' && tier !== 'premium') return false;`
- `server.js:413` — `return tier === 'pro' || tier === 'teams' || tier === 'premium';`
- `server.js:855-856` — `if (plan && (plan === 'pro' || plan === 'teams')) return true;`

**b) `effectiveTier` collapses Max to free** (`lib/wall-enforcement.js:106`):

```js
if (enforce) {
  if (tier === 'paid' || tier === 'trial') return 'paid';
  return 'free';                                  // <-- 'max' lands here
}
```

This is the "effectiveTier lying" — under enforcement a Max subscriber is
resolved to the 1-render/day free tier.

**c) `capabilities()` has no `max` row, and its default FAILS CLOSED TO THE WALL:**

```
capabilities('max') -> {appUsable:false, uploadMax:0, renderLimit:0, chatLimit:0,
                        reedit:false, lumen:false, limitHitRouting:'wall'}
```

> ### ⚠️ SEQUENCING HAZARD — the one thing that must not be got wrong
> If `effectiveTier` is taught to pass `'max'` through **before** `capabilities`
> has a `max` row, every Max subscriber hits `default:` and is **locked out of
> the app entirely** — `appUsable:false`, a 403 wall, not a paywall. The row must
> land **first, or in the same commit**. Never the other order.

**d) CONFIRMED 2026-09-02 — and it is worse than "inert".** Zac has created a
`max` entitlement in RevenueCat with both Max products attached, so the
entitlement exists. Nothing server-side reads it:

- `resolveProEntitlementInternalId()` (`server.js:886`) resolves **one** id —
  the entitlement whose `lookup_key === PRO_ENTITLEMENT_ID`, and
  `PRO_ENTITLEMENT_ID = 'pro'` (`lib/entitlement.js:97`).
- `proEntitlementFromV2ActiveList(items, proEntId)` then **filters the user's
  active entitlements down to that single id**.
- Both write sites hardcode `tier: 'pro'` (`server.js:~1016` sync, `~4940`
  webhook). Nothing can store `'max'`.

Run against the real function:

```
Pro subscriber (pro entitlement only)     -> active=true
MAX subscriber, max entitlement ONLY      -> active=false   <-- NOT PRO
MAX subscriber, max AND pro both attached -> active=true    (but stored as 'pro')
```

**So the outcome depends entirely on RC product attachment, and one branch is a
paying user getting nothing:**

- If the Max products are attached to **both** `max` and `pro`, a Max buyer is
  granted Pro and stored as `tier='pro'` — they get Pro access and the **Pro
  allowance of 200, not 1000**, and Max is invisible to the server.
- If the Max products are attached to **`max` only**, `active=false` →
  `RC_NOT_ACTIVE` → **isPro false → the buyer gets FREE.** A completed purchase
  grants nothing.

The single-entitlement fallback ("null → accept any active entitlement") does
**not** rescue this: it only triggers when the lookup *fails*. With a `pro`
entitlement present the lookup succeeds, so the strict filter always applies.

**This is a live purchase-path risk the moment a Max product is buyable — it is
not gated behind `max_tier`, which only controls client UI.** The capability row
shipping dark does not touch it either way.

**Fix (the next commit):** `PRO_ENTITLEMENT_ID` becomes a lookup_key → tier map
(`{max: 'max', pro: 'pro'}`), resolution keeps the **highest-ranked** active
entitlement via `tierRank`, and the two write sites write the resolved tier
instead of the literal `'pro'`. `tierAfterGrant` already guarantees a later
Pro-grant cannot lower a stored Max.

**First, verify in the RC dashboard which entitlements the Max products are
attached to** — that decides whether this is "Max buyers get Pro-level access
and the wrong allowance" or "Max buyers get nothing".

### The build

1. `lib/tier-capabilities.js` — add `case 'max':`. Identical to `paid` today
   except that allowance lives in `credits.TIER_ALLOWANCE`, not this table. Add
   the row anyway, per the ruling: it is what lets a Max-only capability land
   later without restructuring, and what stops `effectiveTier` lying.
2. Add `'max'` to the three predicates in (a).
3. `effectiveTier` — preserve `'max'` in **both** branches.
4. **Client mirror.** `lib/tier-capabilities.js`'s own header: *"Mirrored
   cell-for-cell in EntitlementTier.swift"* (`ios/Promptly/Promptly/Services/`).
   The row is not done until both sides agree.
5. **RC → `'max'` write path** (gap d). `PRO_ENTITLEMENT_ID` likely needs to
   become a map from entitlement id → tier.
6. **Tests.** The file's standing law: *"a cell without a green test does not
   exist."* 22 tests today; a new row is 7 capability cells plus the
   `effectiveTier` and predicate cases — **~10-12 new tests**.

### Cost

| | |
|---|---|
| Code | **~1 day** — the row, 3 predicates, effectiveTier, Swift mirror, ~10-12 tests |
| Blocked on | the RC-side Max entitlement/product (gap d) and App Store review of the Max product — the client comment says it "can be armed the moment Max clears review" |
| Risk | **low, if sequenced right**; **total lockout of paying users if not** (hazard above) |

---

## Recommended order

1. **Max tier row first** — capabilities row + predicates + effectiveTier + Swift
   mirror + tests. Ship dark (`max_tier=off`); nothing writes `'max'` yet, so it
   changes no live behaviour.
2. **Confirm the RC → `'max'` write path** (gap d) and the Max entitlement id.
3. **Provision credits** (CRD, grants, monthly refresh, 2 env vars).
4. **Arm the meter** `CREDITS=1` — the allowance is only correct once step 1 has
   landed.
5. **Arm debit** `CREDITS_DEBIT_ENABLED=1`, after the RC-sandbox end-to-end.
6. `MAX_TIER=1` when Max clears App Store review.

Steps 1-2 are the critical path, and step 1 is the one with a lockout hazard if
sequenced internally wrong.
