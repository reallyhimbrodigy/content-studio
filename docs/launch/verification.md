> ⚠️ **SUPERSEDED 2026-07-21 — FREEMIUM pivot.** The trial model and the $19.99/$199.99 prices below are OBSOLETE. Promptly is now permanent FREE (2 videos/day) + PRO with NO trials: **weekly $12.99, monthly $39.99, yearly $399.99**. Prices in the app are read live from StoreKit. This doc is kept for history only.

# Promptly 1.2.0 — Whole-Flow Verification (machine evidence)

Everything below was verified by machine this session. Zac's single test script
([zac-test-script.md](zac-test-script.md)) is the one human gate that remains.

_Verified at commit `f7eefb3` (main, on origin). Re-run any check yourself:
`node scripts/deploy-sanity.js` · `node --test tests/*.test.js` ·
`bash ios/Promptly/Tests/run.sh`._

---

## 1. The truth table — verified in BOTH knob states

Tier × capability (`lib/tier-capabilities.js`, mirrored in `EntitlementTier.swift`):

| Capability | none | trial | paid |
|---|---|---|---|
| app usable | ❌ → wall | ✅ | ✅ |
| uploads (max) | 0 | 1 | 10 |
| renders/day | 0 | 3 | ∞ |
| chats/day | 0 | 50 | ∞ |
| re-edit | ❌ | ❌ | ✅ |
| Lumen | ❌ | ❌ | ✅ |
| limit-hit route | wall | paywall | — |

**How each state is proven:**
- **Knob OFF (production, live now)** — `scripts/deploy-sanity.js` against `usepromptly.app`, both seeded accounts: **24/24 ✓**. Pro reads `tier=paid / render_limit=unlimited / concurrency=10 / reedit=true`; free reads `tier=none / effective render_limit=3 / concurrency=1 / chat=50 / reedit=false / app_usable=true (no wall)`; all gated endpoints `401` unauthenticated. Health confirms `rev=f7eefb3`, `wall_enforcement=off`.
- **Knob ON (local server, the launch "move two" behavior)** — `scratchpad/verify-knob-on.js`: a wall-capable **`.none` account → `403 wall_required`** (`route:wall`, old-client-safe message), a **paid account still passes** (`200`, unlimited). This is the exact behavior that turns on at the flip.
- **Every cell, both layers** — `tests/tier-capabilities.test.js` + `tests/wall-enforcement.test.js` + `tests/entitlement.test.js` (**213/213 node**) and `ios/Promptly/Tests` (**27/27 Swift**), including the trial cells the live probes don't exercise, and the seam-bug regression cell (`isPro` decision with no row → paid).

## 2. Every door routes correctly

`docs/wall-doors.md` enumerates them. Server doors all wired to the tested core:
render · re-edit · chat (×2, incl. stream) · **upload (×3 — the new gate)** · prewarm · usage-read. Client stamps `X-Promptly-Wall-Capable: 1` on every gated request (`WallCapability.stamp` in `APIService.authorizedRequest`). A `403 wall_required` from any door routes to the trial wall (`throwIfWall → APIError.wallRequired → AppShell fullScreenCover`). **Knob OFF = byte-for-byte today** — the sanity pass's `401`s and knob-off caps confirm no behavior change.

## 3. The onboarding flow — recorded, every beat

`-reproOnboarding` harness walk (`scratchpad/onboarding-proof/`, 16 frames):

| Beat | Evidence |
|---|---|
| Hook (before/after) | `ob_02.png` — "Raw clip in. Studio edit out." |
| Quiz | walked (language-first) |
| Building (reveal) | review prompt fires at the peak — proven (appears in `ob_13`) |
| Social proof | `ob_09.png` — 700+ creators / ~2 min (true numbers only) |
| The trial wall | `ob_13.png` — timeline (Today / Day 2 🔔 / Day 3 charged), "3 days free, then $199.99", auto-renew disclosed, restore visible |

## 4. The wall is honest (law #4)

- Billed amount is the most-prominent price (19pt heavy vs 12pt monthly-equiv anchor **under** it).
- Auto-renewal disclosed; trial timeline shows the charge day + amount before confirm.
- Eligibility-truthful CTA ("Start free trial" only when StoreKit says a trial applies; lapsed users never see a fake trial).
- **One wall, no second flow**: abandon recovery ("No charge was made") returns to the **same** wall, same offer.
- Limited-trial copy matches `EntitlementTier.trial` ("3 edits a day", not "unlimited"/"re-edit").

## 5. Localization — 9 languages, proven incl. RTL

`Localizable.xcstrings` — 78 keys × 9 languages, **back-translation QA 624/624 passed, 0 English fallbacks**. Rendered in-sim (`scratchpad/loc-proof/`):
- **Hindi** (`hi_wall.png`): "आज ही बनाना शुरू करें", "दिन 2 — हम आपको याद दिलाएँगे" (Day %lld→2), "3 दिन मुफ्त, फिर $199.99".
- **Arabic RTL** (`ar_wall.png`): "ابدأ الإبداع اليوم" with timeline icons **auto-mirrored right**, "اليوم 2 — نذكّرك", "3 أيام مجاناً، ثم $199.99".

Format strings + loanwords (B-roll, Apple Account, Promptly) correct. Scope: onboarding+wall in 1.2.0; full app-chrome + full-app RTL → 1.2.1 ([localization-scope.md](localization-scope.md)).

## 6. Analytics pipe — proven by arrivals

PostHog both sinks + RC transaction mirror (battery: all `HTTP 200`, dual-sink row confirmed in `analytics_events`). 1.2.0 event registry (`onboarding_step`, `wall_view`, `trial_wall_start/bounce`, `purchase_result`, `package_selected`, activation set) allowlisted server-side and firing through the dual-sink wrapper (real `paywall_view` from a sim run confirmed landed).

## What machine verification CANNOT do (→ Zac's single test)
- A **real sandbox StoreKit purchase** (trial start → confirmation card → the trial actually granting) — needs a real Apple sandbox account on device.
- **Real-device RTL feel** + real APNs trial reminder delivery.
- The **knob flip on a real device** with a real wall-capable build.

These are the [zac-test-script.md](zac-test-script.md) checklist.
