# Freemium drop-off funnels (PostHog)

Definitive event taxonomy for the four freemium conversion funnels, 2026-07-21.
Every event fires through `Analytics.track` (iOS) or `funnelEvent` (server), which
dual-sink to **PostHog** (where these funnels live) and **`analytics_events`** (the
SQL mirror). Same event names, same props, both sinks.

**Identity.** `Analytics.identify(userId:)` at auth resolve ties the device's
anonymous history to the Supabase `user.id` — the SAME id the server funnel events
key on, so the client/server halves of ACTIVATION join on one person. Person
properties: `preferred_language`, `territory`, `tier`. **Super-properties** (ride
every event): `tier` (`free`/`pro`) and `country`. `reset()` on sign-out.

To build a funnel in PostHog: New insight → Funnel → add the steps below in order →
breakdown by `tier` or `country` as noted.

---

## 1. ONBOARDING

| # | Event | Fires |
|---|-------|-------|
| 1 | `language_selected` | LanguageSelectionView — a language tapped (prop `language`) |
| 2 | `signup_completed` | OnboardingFlow — Sign in with Apple resolves mid-flow |
| 3 | `social_proof_viewed` | SocialProofView appears |
| 4 | `onboarding_completed` | Wall dismissed (purchased or continued free) |

Breakdown: `language`, `country`. This funnel is anonymous→identified: step 1 may be
pre-signup; the identify at step 2 merges it onto the person.

## 2. ACTIVATION

| # | Event | Fires | Sink |
|---|-------|-------|------|
| 1 | `upload_started` | EditorView — upload pipeline begins (post-precheck) | client |
| 2 | `upload_completed` | EditorView — source bytes confirmed in S3 | client |
| 3 | `render_started` | dispatch-to-modal — job dispatched (props `mode`,`premium`) | server |
| 4 | `render_completed` | dispatch-to-modal — job marked completed | server |
| 5 | `result_viewed` | MessageBubble — finished render opened in the player | client |

**Rejection / failure branches** (not linear steps — track as separate funnels or
drop-off reasons):
- `not_talking_head_rejected` — client pre-render, prop `stage` = `precheck`
  (on-device Vision) or `validate` (server sample-validate). `proceeded` on precheck
  distinguishes "picked another" from "Try Anyway".
- `render_failed` (prop `error_code`) — server, at render time.
- `no_speech_rejected` / `no_audio_rejected` / `not_talking_head_rejected` (render-time)
  — server, derived from the worker error code at dispatch.

Breakdown: `tier`, `country`. The client fires the pre-render halves; the server
fires the authoritative render-time halves — they join on the shared user id.

## 3. UPGRADE

| # | Event | Fires |
|---|-------|-------|
| 1 | `free_limit_hit` | AppState paywall routing — prop `limit` = `daily_cap` / `daily_chats` / `re_edit` / `lumen` / `second_upload` |
| 2 | `upgrade_wall_viewed` | TrialWallView + PaywallView appear — prop `context` (onboarding/lapsed/door/reedit/lumen/…) |
| 3 | `plan_selected` | A plan tapped — prop `plan` = `weekly` / `monthly` / `yearly` |
| 4 | `purchase_started` | SubscriptionService.purchase entry |
| 5 | `purchase_completed` | SubscriptionService — StoreKit purchase succeeded |

**Failure/drop:** `purchase_failed` (props `billing_error`, `cancelled`) — fires for
BOTH a real decline (`cancelled=false`, `billing_error` = `<domain>#<code>`) and a
user-cancel (`cancelled=true`). Every `purchase_started` pairs with exactly one
`purchase_completed` or `purchase_failed`.

Breakdown: `limit` (which cap drives upgrades), `plan`, `context`, `country`.

## 4. RETENTION

| Event | Fires |
|-------|-------|
| `session_started` | PromptlyApp — cold launch + every real background→active resume (not transient inactive blips) |

Not a funnel — a returning-user signal. Use for DAU/WAU and Day-1 / Day-7 / Day-30
retention on the identified person, broken down by `tier`.

---

## Sinks & verification

- **PostHog** (US Cloud, `us.i.posthog.com`, key `phc_zqZ…`): capture API verified
  live (HTTP 200). Client SDK initialized in PromptlyApp with session replay + auto
  lifecycle capture.
- **`analytics_events`** via `POST /api/events`: allowlist gates event names — every
  name above is allowlisted (server rev confirmed live). Server funnel events
  (`render_*`, render-time `*_rejected`) insert directly, not through this endpoint.
- Real client events flow once the staged iOS build reaches a device; the pipe
  (both sinks) is confirmed reachable and the taxonomy is drift-checked
  client↔server↔allowlist.
