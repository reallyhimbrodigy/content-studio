# RevenueCat + App Store Connect setup

> ⚠️ **Sections 1–5 are the ORIGINAL 2026-05 walkthrough and are SUPERSEDED
> (2026-07-21, FREEMIUM pivot).** The trial model and the $19.99/$199.99 prices
> there are obsolete. They are kept for history. **The dashboard inventory below
> is the current truth** — read it first.

## 0. CURRENT INVENTORY — every dashboard object, and what breaks without it

**Why this section exists.** This doc used to describe Pro monthly + yearly and
nothing else. It did not mention `promptly_pro_weekly` (which 12 of 24 paying
subscribers are on) and it did not mention Max at all. That omission is how
`promptly_max_yearly` came to be missing from the `default` offering with nobody
noticing: the paywall enumerates `offering.availablePackages` with **no
product-id filter**, so a package that is not attached simply does not render,
and no code anywhere fails. **The failure mode of every object below is a silent
absence, not an error.**

### 0a. Products (RevenueCat → Products)

| Product ID | Tier | Duration | Package on `default` | Status |
|---|---|---|---|---|
| `promptly_pro_weekly` | pro | 1 week | `$rc_weekly` | live |
| `promptly_pro_monthly` | pro | 1 month | `$rc_monthly` | live |
| `promptly_pro_yearly` | pro | 1 year | `$rc_annual` | live |
| `promptly_max_monthly` | max | 1 month | `max_monthly` (custom) | live |
| `promptly_max_yearly` | max | 1 year | `max_yearly` (custom) | ❌ **MISSING** |

Prices are deliberately NOT recorded here. They are read live from StoreKit, and
a stale price table in this file is exactly what made the rest of the doc
untrustworthy. **Apple is the source of truth for price; this file is the source
of truth for identifiers and wiring.**

`max_monthly` / `max_yearly` are **custom** package identifiers, not
`$rc_monthly` / `$rc_annual` — an offering holds one package per built-in type,
and Pro already occupies all three. This matters in the client: RevenueCat
returns custom packages with
`packageType == .custom`, so any code testing `packageType == .annual` will not
see them (see `Services/PlanPeriod.swift`, which reads `subscriptionPeriod`
first for exactly this reason).

### 0b. Entitlements (RevenueCat → Entitlements)

| lookup_key | Attach | Verify |
|---|---|---|
| `pro` | the three `promptly_pro_*` products | `/api/health` → `.revenuecat.entitlementTiers` |
| `max` | both `promptly_max_*` products | same — must contain **both** `max` and `pro` |

The server maps entitlement → tier by lookup_key in
`lib/entitlement.js` (`ENTITLEMENT_TIER_BY_LOOKUP_KEY`), resolving the highest
`tierRank` when a customer holds both. There is **no product-id → tier map on
the server**, so a new product of an existing tier needs no server change — but
a product attached to the WRONG entitlement grants the wrong tier silently.

### 0c. Virtual currency (RevenueCat → Virtual Currencies)

| Code | Allowance/period | Set by |
|---|---|---|
| `CRD` | free 30 · pro 200 · max 1000 | `TIER_ALLOWANCE` in `lib/credits.js` |

Per-product recurring grants are attached **in the dashboard** and fire on
purchase and renewal. A weekly product grants its own smaller amount (a weekly
is not 200) — attaching the monthly amount to the weekly product is an
arbitrage: buy weekly, get a month of credits.

Free-tier credits have no product to hang on and are granted by this server
(`ensureFreePeriodGrant`, lazily). Currency creation and product-amount
attachment are **dashboard-only** — there is no API for either.

### 0d. Completeness check

A doc cannot fail, so treat this as a pre-submission checklist, not a guarantee:

```bash
curl -s https://usepromptly.app/api/health | jq .revenuecat
# expect: probe "ok"  AND  entitlementTiers containing BOTH "max" and "pro"
```

`entitlementTiers` proves the entitlements exist. **It does NOT prove the
offering is complete** — the offering is a separate object, and a missing
package is invisible to it. The only current way to see the packages is to dump
`offering.availablePackages` from the client. If the Max tab renders fewer
duration rows than the table in 0a, a package is unattached.

### 0e. ⚠️ App Review screenshots

`docs/screenshots/app-review/max-yearly-iap-review-17pro.png` (on branch
`app-conversion-surface`) shows a **Year $799.99** row that the app can no
longer offer, because `max_yearly` is not on the offering. **Do not submit it.**
Apple would be reviewing a plan that does not exist. Re-capture it after the
package is attached, then submit. `max-monthly-iap-review-17pro.png` is
unaffected.

### 0f. Adding Max Yearly (the outstanding gap)

1. **App Store Connect** — in the Max subscription group, create a subscription:
   Product ID `promptly_max_yearly`, Duration 1 Year. Clear `MISSING_METADATA`
   (localizations + review screenshot) or it will not appear in RevenueCat.
2. **RevenueCat → Products** — `+ New`, identifier `promptly_max_yearly`,
   type Auto-Renewable Subscription.
3. **RevenueCat → Entitlements → `max`** — attach `promptly_max_yearly`.
   *Skipping this ships a purchase that grants nothing.*
4. **RevenueCat → Offerings → `default`** — `+ Add Package`, custom identifier
   `max_yearly`, attach the product. **This is the step that was missed.**
5. **RevenueCat → Virtual Currencies** — attach the `CRD` recurring grant
   (1000) to the product.
6. Re-capture the App Review screenshot (0e) and verify the Max tab shows two
   duration rows.

No code change is required for any of the above: `CreditsService` maps the
allowance by substring (`"max"` → 1000), and the paywall enumerates whatever the
offering contains.

---

Everything in the code is wired. To actually take payments, you need to
do the manual steps below. Total time: ~30 min.

---

## 1. App Store Connect — create the subscription products

You need ONE subscription group with TWO products (monthly + yearly).

### 1a. Sign the Paid Apps Agreement (if you haven't)

1. Open https://appstoreconnect.apple.com
2. Click **Business** → **Agreements, Tax, and Banking**
3. Sign the **Paid Apps** agreement (it's a multi-step wizard — banking
   info + tax forms). Without this, in-app purchases will not work.

### 1b. Create the subscription group

1. Apps → **Promptly** → **Subscriptions** (left sidebar)
2. Click **Create Subscription Group**
3. Reference Name: `Promptly Pro`
4. Save

### 1c. Create the monthly product

1. Inside the `Promptly Pro` group, click **+** to add a subscription
2. **Reference Name**: `Promptly Pro Monthly`
3. **Product ID**: `promptly_pro_monthly` ← must match exactly
4. Click **Create**
5. On the product detail page:
   - **Subscription Duration**: 1 Month
   - **Subscription Prices**: click **Add Subscription Price** → pick
     tier 20 (which is **$19.99 USD**). Apple auto-fills the rest of
     the world's prices.
   - **Localizations** (English):
     - Display Name: `Promptly Pro (Monthly)`
     - Description: `Unlimited renders, unlimited chats, re-edit any video.`
   - **Review Information**:
     - Screenshot: take a screenshot of the paywall screen (any size
       1242x2208 or similar will work)
     - Review notes: `Pro subscription unlocks unlimited daily renders, unlimited daily AI chats, and the re-edit feature. Test with sandbox account.`

### 1d. Add a 3-day free trial

Still on the monthly product:

1. Scroll to **Subscription Prices** → click the **+** next to your
   $19.99 base price → **Create Introductory Offer**
2. **Offer Type**: Free
3. **Eligibility**: New Subscribers (default)
4. **Duration**: 3 days
5. **Number of Periods**: 1
6. Save

### 1e. Create the yearly product

Repeat 1c with these changes:

- **Reference Name**: `Promptly Pro Yearly`
- **Product ID**: `promptly_pro_yearly`
- **Subscription Duration**: 1 Year
- **Subscription Price**: tier 200 — **$199.99 USD** (saves ~17% vs monthly)
- **Display Name**: `Promptly Pro (Yearly)`
- **Description**: `Unlimited renders, unlimited chats, re-edit any video.`
- Add the same 3-day free trial (1d above).

### 1f. Generate the App Store Shared Secret

RevenueCat needs this to validate receipts on your behalf.

1. Apps → Promptly → **App Information** → scroll to **App-Specific
   Shared Secret** → **Generate**
2. **COPY IT NOW** — Apple only shows it once. Save it somewhere safe.

---

## 2. RevenueCat — connect Apple + create the offering

### 2a. Create a RevenueCat project (if you haven't)

1. Sign up / log in at https://app.revenuecat.com
2. Click **+ Project** → name it `Promptly`
3. Add **iOS app**:
   - Bundle ID: `app.usepromptly.ios` (matches your Xcode project)

### 2b. Connect to App Store Connect

1. Project Settings → **Apps** → click your iOS app
2. **App Store Connect API Key**: paste the App-Specific Shared Secret
   from step **1f** into the **In-App Purchase Key** field
3. **App Store Connect API Key (modern)**: optional but recommended —
   create an API key at App Store Connect → Users and Access → Integrations
   → App Store Connect API (Issuer ID + Key ID + .p8 file). Paste all
   three into RevenueCat.

### 2c. Import your products

1. RevenueCat → **Products** (left sidebar) → **+ New**
2. Identifier: `promptly_pro_monthly` (exact match to step 1c)
3. **Type**: Auto-Renewable Subscription
4. Save
5. Repeat for `promptly_pro_yearly`

### 2d. Create the entitlement

1. RevenueCat → **Entitlements** → **+ New**
2. Identifier: `pro` ← must be exactly "pro" (lowercase)
3. **Attach products**: select both `promptly_pro_monthly` and
   `promptly_pro_yearly`
4. Save

### 2e. Create the offering

1. RevenueCat → **Offerings** → **+ New**
2. Identifier: `default` ← must be exactly "default" (lowercase)
3. Description: `Default paywall`
4. **Packages**:
   - **+ Add Package** → **Monthly** (`$rc_monthly`) → attach product `promptly_pro_monthly`
   - **+ Add Package** → **Annual** (`$rc_annual`) → attach product `promptly_pro_yearly`
5. Mark this offering as the **Current Offering** (toggle at top)
6. Save

### 2f. Grab the public iOS SDK key

1. RevenueCat → Project Settings → **API Keys**
2. Copy the **iOS** public key — it looks like `appl_xxxxxxxxxxxxxxxx`

### 2g. Paste the key into the iOS app

Open `ios/Promptly/Promptly/Services/SubscriptionService.swift` and
replace this line:

```swift
private let revenueCatPublicKey = "appl_PASTE_YOUR_PUBLIC_KEY_HERE"
```

with your real key. Commit + ship a new TestFlight build.

### 2h. Configure the webhook (server-side entitlement sync)

This is what lets the SERVER know who's Pro — without this, the iOS
client thinks they're Pro but `/api/video-jobs` will still 402 them.

1. RevenueCat → Project Settings → **Integrations** → **+ New** → **Webhook**
2. **Webhook URL**: `https://usepromptly.app/api/revenuecat/webhook`
3. **Authorization header**: type any long random string (e.g., run
   `openssl rand -hex 32`). Copy this string — you need it in step **2i**.
4. **Events**: leave all checked (we want every event so we can react
   to renewals, cancellations, refunds, etc.)
5. Save

### 2i. Set the webhook secret in Render env

1. Open Render dashboard → your `content-studio` service → **Environment**
2. **+ Add Environment Variable**:
   - Key: `REVENUECAT_WEBHOOK_AUTH`
   - Value: the random string from step **2h**
3. **Manual Deploy** → **Deploy latest commit** so the env change takes effect

---

## 3. Run the database migration

The migration adds `pro_until` + `usage_events` to Supabase.

1. Open https://supabase.com/dashboard/project/ejxkzsfruykvgeouymfy/sql/new
2. Open `migrations/2026-05-27-revenuecat-usage.sql` in your editor
3. Copy/paste the entire file into the Supabase SQL editor
4. Click **Run**

---

## 4. Test the flow (sandbox)

### 4a. Create a sandbox tester

1. App Store Connect → **Users and Access** → **Sandbox Testers** → **+**
2. Use any fake email and a strong password
3. Country: same as your Apple ID's country

### 4b. Sign into sandbox on your test device

1. iPhone Settings → App Store → scroll to bottom → **Sandbox Account**
2. Sign in with the tester credentials

### 4c. Test the purchase

1. Open Promptly (TestFlight build with the RevenueCat key set)
2. Tap Re-edit on any finished video → the paywall should appear
3. Select Monthly or Yearly → **Start free trial**
4. Approve the sandbox purchase prompt
5. Within ~1-3s the paywall should auto-dismiss and the re-edit fires
6. Open the Account page → Subscription row should read **PRO**
7. Open Supabase → `profiles` table → your user row should have
   `tier='pro'` and `pro_until` set to ~3 days out

### 4d. Test the cap (free tier)

1. Sign in as a different account (or sign out + sign in fresh)
2. Do 3 renders → 4th should pop the paywall with "out of free renders" copy
3. Send 50 chat messages → 51st should pop with "out of free chats" copy

---

## 5. Submit your products for review

When you submit your next app binary that uses these IAPs, attach
the products in App Store Connect → My Apps → Promptly → **In-App
Purchases and Subscriptions**. Apple reviews them alongside the app.

After approval they go from "Ready to Submit" → "Approved" → live.

---

## Common gotchas

- **Webhook auth header**: it's the literal string after `Bearer ` in the
  Authorization header. RevenueCat's dashboard lets you type the value
  without the "Bearer " prefix — our server adds that prefix automatically.
- **Sandbox renewals are accelerated**: a "monthly" sandbox sub renews
  every 5 minutes for testing. Don't be alarmed.
- **First entitlement after purchase**: RevenueCat → server webhook is
  near-instant (1-3s). The iOS client unlocks INSTANTLY because it reads
  RevenueCat's local cache. If you want belt-and-suspenders, the server's
  `/api/usage` check is the gate.
- **`tier='pro'` but webhook hasn't fired yet**: rare race — RC SDK marks
  the user Pro but webhook hasn't written to profiles. The 5s gap is bridged
  by the iOS UsageService refresh which RevenueCat triggers automatically
  on customerInfo update.
- **"is_pro is false even after purchase"**: 95% of the time this is the
  webhook auth mismatch. Check Render logs for `[RevenueCat] webhook auth
  mismatch`. Re-verify the secret on both sides matches.
