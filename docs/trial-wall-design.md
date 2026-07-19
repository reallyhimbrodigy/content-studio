# Trial Wall — Design Document (Release N+1, "the monetization release")

**Status:** DESIGN ONLY — no code lands from this doc. **Hard sequencing law:** the current cut (the four green commits: races, revenue hardening, pricing, failure copy) ships first and is **not delayed one hour** for this. This design depends on the current release's six funnel events being live so the wall can be measured against a real baseline.

**Decision on the record (Zac):** **no free tier.** Signup → start the free trial immediately → trial tier = today's free limits → paid = full Pro → an "instant convert" affordance.

**The monetization thesis.** Today anyone renders 3/day forever with **no payment method** — unbounded compute bleed against non-prospects (the surge: 642 signups, ~0 payment-verified). A mandatory trial forces an Apple-verified payment method *before* the first render, so compute is spent only on real prospects and is **capped at ~$2 each** (§6). The wall converts an unbounded free liability into a bounded, payment-gated funnel.

---

## 1. Tier mechanics — the state machine

### 1.1 The signal
RevenueCat exposes the entitlement's period on both client and server:
- **Client:** `CustomerInfo.entitlements["pro"]?.periodType` → `RCPeriodType { normal=0, intro=1, trial=2 }` (verified in the 5.75 SDK, `EntitlementInfo.swift:127`).
- **Server:** `profiles.rc_period_type` — already written by the webhook (`server.js:2859` et al.), currently **informational only**.

### 1.2 The four states
| State | Entitlement | What the user gets |
|---|---|---|
| **Pre-trial** (just signed up, no entitlement yet) | none active | **The wall.** Cannot render until they start the trial (payment method via StoreKit). |
| **In trial** (`periodType == .trial`) | active | **Limited tier** = today's free limits: 3 renders/day, 50 chats/day, 1 upload at a time, no re-edit, no Lumen, standard queue. |
| **Paid** (`periodType == .normal`) | active | **Full Pro:** unlimited renders/chats, 10 uploads, re-edit, Lumen, priority queue. |
| **Lapsed** (trial ended without conversion, or paid cancelled+expired) | none active | **The wall again.** Re-subscribe to continue. This is where win-back lives (§ see risks). |

Note the StoreKit reality: a "free trial" *is* a subscription with an intro offer — the entitlement is **active** during the trial and auto-converts to paid at trial end unless cancelled. The "limited trial tier" is therefore an **app-imposed** gate on `.trial`, not a StoreKit limit. Its purpose is to create the in-trial upgrade incentive (§2). **This is the central design tradeoff — see Risks.**

### 1.3 Feature gates — per tier, both halves named
The gate must become **three-way** (locked / trial-limited / full), replacing today's binary `effectiveIsPro`.

**Server half (authoritative — the render/chat gate + entitlement):**
- `lib/entitlement.js` `isUserPro()` → split into `entitlementTier(profile) → 'none' | 'trial' | 'paid'`. `comp_pro` and legacy hand-promotes map to `'paid'`. `rc_period_type === 'trial'` + active → `'trial'`; active + normal → `'paid'`; else `'none'`.
- `server.js` render/chat gate (`FREE_DAILY_RENDERS = 3` / `FREE_DAILY_CHATS = 50`, `:1790`): apply the daily cap to **both** `'none'` (pre-trial — but pre-trial should be walled client-side before dispatch) and `'trial'`; bypass only for `'paid'`. `'none'` that reaches the server → **402 with a start-trial reason**, not a daily-limit reason.
- `/api/usage` (`:2644`) returns a `tier` field alongside `is_pro` so the client renders the right wall/limit copy without guessing.
- Re-edit / 10-upload / Lumen server enforcement (where present) gates on `tier === 'paid'`.

**Client half (UX — trusts the server tier, RC for instant unlock):**
- `SubscriptionService`: add `var tier: Tier { … }` derived from `entitlements["pro"]?.periodType` (RC) reconciled with `UsageService.snapshot.tier` (server) — same composite pattern as `effectiveIsPro`, but three-valued.
- Every current `effectiveIsPro` gate re-points: `10 : 1` upload cap (`EditorView.swift:1079`), re-edit (`LibraryView`/`MessageBubble`/`EditorView`), Lumen (`ModelPicker`) → `tier == .paid`.
- The render/chat preemptive paywall (`UsageService.atRenderLimit`) fires for `.trial` at the cap; the **pre-trial** state fires a distinct **trial wall**, not the daily-limit paywall.

---

## 2. "Instant convert" vs StoreKit reality

**The constraint, stated honestly:** StoreKit has **no primitive to end a free trial early and charge now**, and intro offers **auto-apply to eligible users** — you cannot "opt out" of the trial on a product that has one. So "instant convert" cannot be a button that charges the trial user mid-trial on the same SKU.

**Options:**

| Option | Mechanism | Cost / risk |
|---|---|---|
| **A — Dual product path (recommended)** | Two products in one subscription group: `promptly_pro_yearly`/`_monthly` **with** the intro (free trial), and a parallel **no-intro** SKU (`…_nointro`). Wall shows dual-CTA: **"Start 3-day free trial"** (→ limited trial) and **"Get Pro now"** (no-intro → full Pro, charged immediately). In-trial, surface **"Unlock full Pro now"** = buy the no-intro SKU; StoreKit treats it as a crossgrade within the group. | +1 product per interval to configure/maintain; must be **same subscription group** (else double-billing); test the crossgrade + proration path; handle **intro-ineligibility** (below). |
| **B — In-app early unlock, no charge** | Lift the app-imposed trial limits early when the user takes a high-intent action. | Gives full Pro **free** during the trial (compute cost, no revenue pull-forward). Only justifiable as a conversion experiment. |
| **C — No true instant-convert** | Trial is limited, auto-converts at day 3; "instant convert" is messaging only. | Cheapest; forfeits the early-revenue lever the ruling asks for. |

**Recommendation: Option A.** It's the only honest, revenue-accelerating mechanism. **Intro-eligibility edge (must handle):** Apple grants the free trial **once per subscription group per Apple ID**. A returning/re-install user is intro-**ineligible** — showing them "Start free trial" would silently charge them full price. The wall must read eligibility (RevenueCat surfaces intro eligibility / StoreKit `isEligibleForIntroOffer`) and, for ineligible users, show **only "Get Pro now"** — never a trial CTA that lies.

---

## 3. The front door — the load-bearing guard

**A wall that greets a cold user dies.** The **sample before/after demo moves PRE-trial** — onto the first-run / upload screen, *before* the wall asks for a payment method. The prospect must see the product's wow at **zero render cost** first; only then does the wall read as "unlock this," not "pay to find out."

- Sequence: **install → sample before/after (canned, instant, no GPU) → first upload attempt → the wall** (start trial to render *your* video).
- The wall's headline is earned by the demo they just watched, not asserted cold.
- This makes the sample before/after pair a **hard dependency** of the trial wall (it's already on the train as a candidate — if it slips to N, the wall waits for it; the wall cannot ship without the pre-trial wow).

---

## 4. Instrumentation from day one

The wall is measured against the **current release's six-event baseline** (`paywall_view`, `offerings_loaded`, `offerings_load_failed`, `purchase_attempt`, `trial_start`, `purchase_error`), never vibed. Add via the existing `Analytics.track` → `/api/events` sink (allowlist in `server.js:2188`):
- **`wall_view`** `{ source: first_run|upload|lapsed, tier, territory }` — the wall was shown.
- **`trial_wall_start`** `{ product, intro_eligible, territory }` — user tapped Start free trial (→ StoreKit).
- **`trial_wall_bounce`** `{ dwell_ms, territory }` — wall shown, dismissed without starting.
- (reuse) `purchase_attempt` / `trial_start` / `purchase_error` carry through unchanged; `trial_start`'s territory closes the loop the four-for-four analysis needed.

`territory` on every event is what makes the India/Canada/etc. cohort legible — the field our DB has never had (`profiles` carries no country column; the event `territory` is the only source). Add the three events to the `/api/events` allowlist server-side.

---

## 5. App Review compliance

Mandatory-trial subscription apps **are permitted** (Guideline 3.1.2 — auto-renewable subscriptions). Requirements to satisfy in the same submission:
- **Disclosure at the wall:** title of the subscription, length + price of the trial, the price that auto-renews and its interval, and that it auto-renews unless cancelled — all visible **before** purchase. (Our Trust Package fineprint + confirmation already carry most of this; the wall inherits them.)
- **Functional app without immediate purchase for reviewers:** provide a **review-notes demo account** OR ensure the pre-trial sample (§3) lets a reviewer see the app's value without paying. Reviewers must not hit a hard paywall with nothing behind it — the pre-trial demo is the compliance guard as much as the conversion guard.
- **Links:** Terms (EULA) + Privacy Policy reachable from the wall.
- **Review notes must state:** "Subscription is required to render; a free trial starts the subscription; the pre-trial sample demonstrates output at no cost. Trial-vs-paid feature tiers gate on RevenueCat periodType." Plus the subscription-display changes already flagged for the current cut.
- **Screenshots:** update App Store screenshots to include the wall + a trial-disclosure frame (Apple requires the subscription surface be representative).

---

## 6. The cost model

- **Trial worst case:** ~3 days × 3 renders/day = **≤9 renders** per prospect before conversion/lapse. At the current per-render compute (~$0.20–0.25 range; pin against a Modal invoice), that's **≈$1.80–$2.25 per payment-method-verified prospect** — and only prospects with a valid Apple payment method ever reach it.
- **Today:** unbounded — every signup can render 3/day indefinitely with no payment method. The surge (642 signups) is pure liability under this model.
- **Projected reduction:** the bleed shifts from *(all signups × renders, forever)* to *(payment-verified trial starts × ≤9 renders, once)*. If trial-start rate among signups is even 10–20%, the payment-method filter alone removes the majority of non-prospect compute; the per-prospect cap removes the tail. Exact reduction is measurable the moment `wall_view` → `trial_wall_start` ships (§4).

---

## Risks & open questions (honest)

1. **Limited trial may depress trial→paid conversion.** A trial user who never tastes full Pro (unlimited, re-edit, Lumen) has less reason to convert than one on a full-featured trial. The four-for-four opt-out pattern suggests conversion is *already* fragile. **Mitigation to test:** Option B-style "taste of full Pro" moments, or a shorter limited window; make lever choice an A/B, not a guess.
2. **The lapsed wall is aggressive.** No free tier means a tried-and-didn't-convert user is fully walled. That's the point (bleed control) but it forfeits re-engagement surface. Win-back (a lapse-triggered offer, per the Canadian precedent) belongs here.
3. **Intro-ineligible users** (§2) — must be detected and shown the no-trial CTA, or the wall lies.
4. **Dependency:** the pre-trial sample (§3) and the six events (current cut) are hard prerequisites. The wall cannot ship without either.

## Sequencing
Release N+1. Prerequisite: current cut live (six events as baseline) + the pre-trial sample. Build order: server `entitlementTier` + `/api/usage` tier field → client three-way gate → the wall UI + dual-CTA → the three events → the pre-trial demo placement → App Review submission with the notes above.
