# Flare / Lumen Model Picker — Design Spec

Date: 2026-06-29
Status: Approved (user-authored spec); building.

## Goal
A Claude-style model selector: a subtle pill under the vibe input showing the
active model — **Flare** (base, free, everyone) or **Lumen** (premium, Pro only) —
tappable to open a picker. Selecting the model sets ONE flag on the job payload
(`premium_pipeline_enabled`). It does not change how a video + vibe are submitted.

## The two models
- **Flare** — current editor. "Fast, everyday edits." Available to all. Default.
- **Lumen** — premium. "Premium cinematic edits with generated graphics." Pro only.

## Grounding (existing code this maps onto)
- **Entitlement source:** `SubscriptionService.shared.effectiveIsPro`
  (`isPro || UsageService.shared.isPro`) — THE documented gate signal. Reactive
  via `@Published isPro`. Do NOT invent a new tier source.
- **Premium pipeline already exists + is tier-gated server+worker-side:**
  worker `premium.py` reads `input_data.premium_pipeline_enabled`;
  `handler.py:17087` → `route_premium = is_premium AND premium_pipeline_enabled`.
  So this is a frontend + payload-plumbing task, not a pipeline build.
- **Paywall trigger:** set `AppState.shared.paywallReason = <reason>` (AppShell
  presents `PaywallView`). Enum `PaywallReason` (Models.swift): add `.lumen`.
- **Composer:** `VStack { reeditChip; inputBar }` (EditorView ~89). `inputBar`
  (EditorView:691) is a left-aligned VStack. The pill goes as a row at the
  BOTTOM of `inputBar`, under the text-field HStack, left-aligned (reference
  placement).
- **Job payload:** `APIService.createVideoJob` (APIService:134) builds a
  `[String:String]` body; two call sites — EditorView:1608 (cached/re-edit) and
  JobDispatchCoordinator:140 (main dispatch). Server `/api/video-jobs`
  (server.js:11365) reads named body fields and builds `input_data` inside
  `dispatchJobToModal`.
- **Theme:** `Theme.Space/Radius/Font/Surface/Border`. Lumen glow = a custom warm
  gradient (amber→gold→light, fitting "Lumen"=light) + soft shadow.

## New files (iOS)
1. **`Models/VideoModel.swift`** — `enum VideoModel: String, CaseIterable { case flare, lumen }`
   with `displayName`, `descriptor`, `isPremium`. Plus a PURE, unit-testable
   `enum ModelSelection`:
   - `canSelect(_ m: VideoModel, isPro: Bool) -> Bool` (flare always; lumen iff pro)
   - `resolve(selected: VideoModel, isPro: Bool) -> VideoModel` (lumen→flare if !pro)
   - `premiumFlag(selected: VideoModel, isPro: Bool) -> Bool`
     (`selected == .lumen && isPro` — the ONLY thing that puts true on the wire)
2. **`Services/ModelService.swift`** — `@MainActor final class ModelService:
   ObservableObject { static let shared }`. `@Published private(set) var selected`
   loaded from UserDefaults (key `model.selected`, default `.flare`). Methods:
   - `select(_ m: VideoModel, isPro: Bool)` — applies `canSelect`; persists.
   - `reconcile(isPro: Bool)` — `selected = ModelSelection.resolve(selected, isPro)`;
     persists. Called on launch + entitlement refresh (downgrade → Flare).
   - `premiumPipelineFlag(isPro: Bool) -> Bool` → `ModelSelection.premiumFlag(...)`.
3. **`Views/ModelPicker.swift`** — the pill + the selector sheet:
   - `ModelPickerPill` — understated rounded pill (Surface + hairline border),
     shows `selected.displayName`, subtle chevron; tap → opens sheet. Neutral
     resting state (no loud color).
   - `ModelPickerSheet` — lists both models with descriptor. Flare: neutral,
     selectable, check when active. Lumen for **Pro**: selectable normally.
     Lumen for **Free**: shown with premium/glowing ambience (warm gradient
     accent + soft glow + a lock/sparkle SF Symbol) — NOT greyed/disabled.
     Tapping locked Lumen does NOT select it → `AppState.shared.paywallReason =
     .lumen` + dismiss. Free users cannot reach Lumen-selected by any path.

## Shared-file edits
- **APIService.createVideoJob** — add `premiumPipeline: Bool = false`. Replace the
  `[String:String]` body with a typed `Encodable` body; include
  `premium_pipeline_enabled` only when `premiumPipeline == true` (omit otherwise →
  backend defaults off). Everything else identical.
- **JobDispatchCoordinator** — thread `premiumPipeline: Bool` through `dispatch(...)`
  into its `createVideoJob` call (line 140).
- **EditorView** — (a) place `ModelPickerPill` at the bottom of `inputBar`;
  (b) `.sheet` presenting `ModelPickerSheet`; (c) at BOTH dispatch points compute
  `let premium = ModelService.shared.premiumPipelineFlag(isPro: SubscriptionService.shared.effectiveIsPro)`
  and pass it; (d) `ModelService.shared.reconcile(isPro:)` on `.onAppear` and on
  `SubscriptionService.isPro` change.
- **Models.swift** — add `case lumen` to `PaywallReason`.
- **PaywallView** — `.lumen` copy (headline/sub: unlock Lumen — premium cinematic
  edits with generated graphics). Falls back to manual layout otherwise.
- **pbxproj** — register the 3 new Swift files + the test file.

## Server (server.js — defense in depth, I deploy)
In `/api/video-jobs` POST (and re-edit if it dispatches premium): read
`body.premium_pipeline_enabled`; compute
`const premiumPipeline = entitlement.isPro === true && body?.premium_pipeline_enabled === true;`
(a free or unverified user can NEVER set it true, regardless of client). Thread
`premiumPipeline` into `dispatchJobToModal(...)` → add `premium_pipeline_enabled:
premiumPipeline` to the `input_data` sent to Modal. The worker still double-gates
on `is_premium`. No new endpoint, no schema change.

## State & persistence
- Selection persists across sessions (UserDefaults). Free stays Flare; Pro's last
  choice remembered.
- Pro→Free downgrade with Lumen selected → `reconcile` falls back to Flare on next
  launch / entitlement refresh.

## Visual direction
- Pill understated like the reference (name + subtle secondary, no loud resting
  color). Flare neutral/clean.
- Lumen locked state = the premium ambience: gentle warm glow/gradient, lock or
  sparkle affordance, tap → upgrade. Aspirational, not broken/greyed.

## Testing
- `ModelSelection` pure tests (swiftc, like FeedbackGate/TricklePacing):
  canSelect (flare always, lumen pro-only), resolve (downgrade→flare), premiumFlag
  (true ONLY for lumen+pro; false for free-lumen, free-flare, pro-flare).
- `node --check server.js`; `xcodebuild` build.
- Adversarial review: free user can NEVER select Lumen or send the flag by ANY
  path (UI, persistence resurrection, stale selection after downgrade); server
  gate holds independent of client; pill reflects active model always.
- Screenshots: free (locked + glowing Lumen) and pro (both selectable).

## Acceptance (from request)
- Free: sees both; Flare selected + usable; Lumen locked + glowing; tap Lumen →
  upgrade; never sends premium flag.
- Pro: sees both; selects either; flag set correctly; selection persists.
- Pill reflects active model at all times; matches reference placement.

## Out of scope (YAGNI)
More than two models; per-model pricing UI; remote model config; changing the
premium pipeline itself (already exists); re-edit premium routing (unless trivial).
