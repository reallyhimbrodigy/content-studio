# Durable-Poll Progress Bar — Design Spec

Date: 2026-06-29
Status: Approved; building.

## Goal
Fix the bar that snapped 50%→1% on background→reopen. It relied on pushed SSE
events it could miss and recomputed from a self-driving ramp that restarts at 0
on view-recreate. Rebuild it to track the durable `video_jobs` row by polling,
so progress reflects reality and survives backgrounding, force-quit, and
network drops. Honors the prior decision (monotonic, never premature/stuck,
smooth continuous motion) — see [[render-progress-bar]] — now that the backend
writes true durable progress.

## Decision (from brainstorm)
- **Hybrid, poll-authoritative.** Keep SSE for sub-second live updates, but the
  ~1–2s poll of the durable row is the source of truth and WINS all conflicts.
  Every value (poll or SSE) flows through one monotonic clamp.

## Grounding (existing code)
- Poll endpoint EXISTS: `GET /api/video-jobs/:id` → `{ status, progress (0–100),
  current_step, step_message, rendered_video_url, error_message, ... }`.
- `reconcileJobStatus(jobId:)` (EditorView) already polls (Supabase REST direct)
  on a 5s/15s heartbeat + on `scenePhase==.active` + on relaunch
  (`resumeSSEForInFlightMessages` / loadMessages) — but selects ONLY
  `status, rendered_video_url, hls_manifest_url, thumbnail_url, error_message`.
  It heals completion/failure but never rehydrates the bar position. THE GAP.
- `ChatMessage.jobProgress: Int?` + `stepMessage` already exist and persist.
- Bar = `TrickleProgress` (`@StateObject` in `PipelineProgressView`): self-driving
  ~30fps ramp via pure `TricklePacing.advance(...)`; backend value fed only as a
  monotonic CEILING (`update(target:)`). On view-recreate it eases from 0 → snap.
- Failed-state UI + retry EXISTS (`onRetry`, `isRetryable`, "Try again", error copy).
- Phase narrative = `StageTimeline` (maps worker step tokens → titles).

## Changes

### 1. Poll fetches progress + phase (EditorView.reconcileJobStatus)
Extend the Supabase select to add `progress, current_step, step_message`. On each
poll for an in-flight job, BEFORE the terminal-status handling:
- `messages[idx].jobProgress = max(messages[idx].jobProgress ?? 0, polledProgress)`
  (monotonic at the data layer).
- `messages[idx].stepMessage = polled.step_message` (when non-empty).
- Feed `current_step` into `messages[idx].stageTimeline?.receive(stepToken:)` so
  the phase label reflects reality (only advances; StageTimeline already infers).
Poll wins: if poll says completed/failed while SSE still thinks processing, the
poll's terminal handling runs (already does).

### 2. Monotonic clamp everywhere
- Data layer: `jobProgress = max(existing, incoming)` for BOTH poll and the SSE
  handler (SSE already monotonic via TrickleProgress; mirror it on the field).
- Bar layer: `TrickleProgress` already ignores a lower ceiling; add the explicit
  `displayed = max(displayed, …)` on rehydrate (below).

### 3. TrickleProgress.rehydrate(to:) — instant catch-up
New method: `rehydrate(to polled: Int)`:
```
let v = clamp(polled, 0, 100)
confirmedTarget = max(confirmedTarget, v)
displayed = max(displayed, v)          // snap up, never down
// realign the time schedule so pacing continues forward from `displayed`
// rather than stalling or re-ramping (back-date startedAt to the elapsed
// that the pure pacing maps to `displayed`); keep it clock-free + tested.
start()
```
Called from `PipelineProgressView.onAppear` (using the message's persisted
`jobProgress`) and whenever a poll feeds a value after a gap. Net effect: on
appear/foreground/relaunch the bar shows true progress immediately, never a
ramp-from-0, never backward. Continuous-viewing feed keeps the existing
glide-between-updates behavior (`update(target:)`).

### 4. Lifecycle rehydrate (the fix)
- `scenePhase == .active`: already reconnects SSE + reconciles; the extended
  poll now also rehydrates the bar. Confirm an immediate poll (don't wait for
  the heartbeat) — `reconcileInProgressJobs` already runs here.
- Relaunch: in-flight messages restore from disk with persisted `jobProgress`
  → `PipelineProgressView.onAppear` rehydrates the bar instantly from disk
  (before any network), then an immediate poll confirms / completes / jumps to
  the finished video. Add an immediate `reconcileInProgressJobs` on first
  appear so resume doesn't wait for the 5s tick.

### 5. Smooth + honest in the render band
TrickleProgress keeps gliding between poll points. In the long render band, if
consecutive polls return the same value for a short while, a subtle indeterminate
shimmer within the bar keeps it alive (never frozen). Phase label is the real
stage, not a generic spinner.

### 6. Terminal states
- `completed`/`complete` → `jobProgress=100`, `trickle.complete()` → finished
  video from `rendered_video_url` (pure-poll path; no push dependency). (Exists.)
- `failed`/`error` → existing error + retry affordance; surface the failed phase
  in the message if available. (Exists; verify the phase context.)
- `cancelled`/`canceled` → graceful: drop the bar, no error. Reserved (cancel
  feature parked); handle if seen.

## Testing
- TricklePacing unit tests (swiftc): extend for `rehydrate` — snap-up on appear,
  never-backward across a rehydrate, rehydrate above current target, idempotence.
- xcodebuild; node --check server.js (no server change expected; endpoint exists).
- Adversarial review: never-backward across every path (poll/SSE/rehydrate/relaunch),
  poll-wins-conflict, completion-via-pure-poll, failed→retry, no resurrection of a
  finalized message.
- Acceptance: (1) background→reopen no snap-back; (2) force-quit→relaunch resume or
  jump-to-video; (3) phase shape (fast early, long render band, quick finalize);
  (4) completion via pure poll (no push); (5) simulated failed → error+retry.
- Screen-record the background→reopen resume.

## Out of scope (YAGNI)
Submit/upload flow; the parked cancel-render feature; bar visual redesign;
changing the worker or the poll endpoint (both already correct).
