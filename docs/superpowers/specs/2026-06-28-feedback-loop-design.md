# In-App Feedback Loop — Design Spec

Date: 2026-06-28
Status: Approved (design); building.

## Goal
Add a feedback loop to the iOS app — App Store review prompts + in-app feedback —
that feels professional and is never annoying. Sentiment-gated: happy users are
routed to the App Store; unhappy users route private feedback to the owner.

## Decisions (from brainstorm)
- **Model:** sentiment-gated routing. After a watched, successful render
  (rarely), a subtle inline card asks "Happy with this edit?" 👍/👎.
  - 👍 → trigger Apple's native review prompt (StoreKit), only if eligible.
  - 👎 → expand to "What would make it better?" (optional text) → stored privately.
- **Placement:** inline card under the finished video in MessageBubble (not a
  bottom sheet). Non-blocking, dismissible (✕).
- **Passive entry:** an always-available "Send feedback" row in Settings/Account
  (user-initiated, no prompt) → same submission path.
- **Storage:** new Supabase `app_feedback` table + a private owner-gated
  `/feedback` dashboard (reusing the /review auth pattern + the admin gate).
- **Cadence:** "rare & earned", all thresholds tunable constants.

## Anti-annoyance rules (FeedbackGate, all tunable)
- Never on the user's 1st successful render (require ≥2).
- Only after a render the user actually watched; never blocks the UI.
- ≥14 days between prompts; **back off** when ignored (14→30→60 days); reset to
  baseline once the user answers (👍 or 👎).
- App Store prompt fires ONLY after a 👍 **and** ≥90 days since the last one
  (Apple separately caps native prompts at ~3/year).
- Respect a permanent "don't ask again" once the user has left a review/answered
  enough times (optional; at minimum the back-off makes it effectively rare).

## iOS components
- **`FeedbackManager`** (`@MainActor` ObservableObject singleton) — owns state in
  UserDefaults: `successfulRenderCount`, `lastPromptAt`, `ignoreStreak`,
  `lastAppStorePromptAt`, `lastAnswerAt`. Methods: `recordRenderWatched()`,
  `shouldShowPrompt()`, `recordPromptShown()`, `recordDismissed()`,
  `recordThumbsUp()` (→ maybe trigger review), `recordThumbsDown()`.
- **`FeedbackGate`** — PURE, unit-tested decision module (no UIKit/clock):
  `decide(state, now) -> { showPrompt: Bool }` and
  `appStoreReviewEligible(state, now) -> Bool`. Mirrors the TricklePacing
  pure-function pattern so the cadence/back-off logic is testable with `swiftc`.
- **`FeedbackPromptView`** — the inline card: "Happy with this edit?" 👍/👎 + ✕;
  on 👎 expands to an optional text box + Send. Gentle animation, no blocking.
- **StoreKit review** — on an eligible 👍, request the native prompt via the
  active window scene (`SKStoreReviewController.requestReview(in:)` /
  `AppStore.requestReview(in:)` per deployment target). Swallow failures.
- **Wiring:** MessageBubble's completed-video view shows `FeedbackPromptView` for
  the most-recent completed render when `FeedbackManager.shouldShowPrompt()`.
  `recordRenderWatched()` is called when a completed video is viewed/played.
- **Settings entry:** a "Send feedback" row in Account/Settings → a small sheet
  with optional rating + text → POST /api/feedback.
- New files registered in the Xcode target (pbxproj).

## Backend (server.js, additive)
- `POST /api/feedback` — AUTHENTICATED (requireSupabaseUser). Body
  `{ rating: 'up'|'down'|null, text?, job_id?, app_version? }`. Validates via a
  new pure `lib/feedback.js` (rating enum, text length cap, etc.). Inserts a row
  into `app_feedback` (user_id from the token; never trusted from the client).
- `GET /api/admin/feedback` — owner-gated (reuse `isAuthorizedSubmissionReviewer`).
  Returns rows newest-first.
- `lib/feedback.js` — pure validation helpers (unit-tested with `node --test`):
  `isValidRating`, `validateFeedback({rating,text,job_id,app_version})`.

## Data model — `app_feedback` (migration)
```
id          uuid pk default gen_random_uuid()
created_at  timestamptz not null default now()
user_id     uuid not null references auth.users(id) on delete cascade
rating      text check (rating in ('up','down'))   -- nullable (text-only feedback)
text        text
job_id      text            -- which render, when available
app_version text
```
RLS enabled, NO client policies (service-role only), mirroring `creator_submissions`.
Index on `created_at desc`.

## Dashboard — `/feedback` (feedback.html)
Owner-gated (Supabase session → Bearer; same auth as /review). Shows feedback
newest-first: rating (👍/👎), text, linked video (job_id), user, date, app
version; filter by rating. On-brand (reuse /css/theme.css etc.).

## Testing
- `FeedbackGate` pure-logic tests (swiftc standalone, like ios/Promptly/Tests):
  first-render skip, cooldown, back-off growth + reset, App-Store eligibility
  (post-👍 + 90-day cap), never-double-prompt.
- `tests/feedback.test.js` (node --test): rating enum, text cap, payload validation.
- `node --check server.js`; `xcodebuild` build; manual smoke.

## Out of scope (YAGNI)
NPS surveys, email digests, prompts outside the earned after-render moment +
the passive Settings entry, server-driven remote config of thresholds.
