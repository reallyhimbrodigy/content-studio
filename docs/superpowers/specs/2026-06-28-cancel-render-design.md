# Cancel Render (before the recipe) — Design Spec

Date: 2026-06-28
Status: Approved (design); building.

## Goal
Let a user cancel an in-progress render — but only **until Gemini starts writing
the edit recipe** (the `plan` stage). After that the expensive GPU render is
committed, so the cancel option disappears. A true cancel: it actually stops the
job and saves the render, and refunds the user's daily slot.

## Decisions (from brainstorm)
- **Scope:** true cancel — iOS + server cancel endpoint + worker honors it.
- **Cutoff:** cancel available while the current stage is BEFORE `plan`
  (`upload_local → analyze → download → transcribe`); hidden at `plan`+.
  (`plan` = PipelineStage id "plan", "Writing your edit recipe", Models.swift.)
- **Confirm:** a quick "Cancel this render?" confirmation before cancelling.
- **Quota:** refund — a render cancelled before it finishes does NOT count
  toward the daily limit (remove the usage event logged at dispatch).

## Why this cutoff
The cheap CPU work (download, transcribe) is before the recipe; the expensive
GPU render is after it. Cancelling before `plan` means the costly part never
runs. The worker must honor the cancel for this to actually save compute.

## iOS
- **Cancel affordance** on the processing bubble (`PipelineProgressView` and the
  `ProcessingIndicator` fallback), shown only when cancellable.
- **`isCancellable`** — pure helper on the pipeline order: true iff there is a
  current stage AND its catalog index < `plan`'s index AND the job isn't
  completed/failed. Unit-tested (swiftc, like FeedbackGate/TricklePacing).
- **Confirm** → on confirm, the cancel action:
  1. Cancel the in-flight per-clip dispatch `Task` (existing `JobDispatchCoordinator`
     `.cancelled` plumbing) + `pending.uploadTask?.cancel()`. To make the
     fire-and-forget per-clip Task cancellable from the button, store its handle
     keyed by the processing message id (`[UUID: Task<Void,Never>]`), cleared on
     terminal outcome.
  2. If the message has a `jobId`, `POST /api/video-jobs/:id/cancel` (best-effort).
  3. Stop the SSE for that job (`sseClients[jobId]?.disconnect()` + remove), and
     remove the processing bubble + persist (matches the existing `.cancelled`
     outcome — clean, no trace). Also stash the local "cancelled" so a late
     completion/SSE event for that id is ignored.
- Refresh `UsageService` after cancel so the freed slot shows immediately.

## Server (Render, server.js — additive)
- `POST /api/video-jobs/:id/cancel` — authenticated, **owner-only** (the
  `video_jobs.user_id` must equal the caller). Idempotent. If the job is still
  cancellable (status in queued/processing AND not past the recipe — practically
  just: not completed/failed), set `video_jobs.status='cancelled'` and **refund
  the daily usage** (delete the `render` usage_event(s) tied to this job/user
  from today). Returns `{ ok: true }`. If already completed/failed → `{ ok:true,
  noop:true }` (don't refund a finished render).
- **Worker cancel-check endpoint:** `GET /api/render-cancelled?job_id=…` →
  `{ cancelled: bool }`, reading `video_jobs.status === 'cancelled'`. Same
  internal worker→server trust model as `/api/modal-progress` (job_id is an
  unguessable uuid; mirror its auth). Lightweight.
- Validation/refund logic in a pure `lib/cancel.js` where feasible (unit-tested).

## Worker (Modal, promptly-gpu-worker/handler.py)
- Add `is_cancelled(job_id, app_url)` — a SYNCHRONOUS GET to
  `{app_url}/api/render-cancelled` (3s timeout, default false on error; never
  blocks the pipeline beyond the timeout).
- Check it at two boundaries: **right before the edit recipe** (`_do_edit_recipe_overlapped`
  / the `send_progress(job_id, "plan", …)` point ~handler.py:18460) and **right
  before `render_multi_clip`** (the GPU render). If cancelled, abort cleanly:
  skip the render, do not write a completed result, optionally report a final
  `cancelled` progress, and return early. The before-render check is the
  critical one (catches a cancel issued while the button was visible through
  `transcribe`).
- The user deploys the worker to Modal (provided command); the server is deployed
  by merging to main (Render).

## Edge cases
- Cancel during `transcribe` (button visible) → before-render check aborts; no GPU.
- Render already completed before cancel lands → cancel is a no-op (completion
  wins); no refund.
- App relaunch / chat-switch mid-cancel → the removed bubble stays removed
  (persisted); the cancelled job status stops any reconcile from resurrecting it.

## Testing
- iOS `isCancellable` pure tests (swiftc): before/at/after `plan`, completed/failed.
- `lib/cancel.js` validation/refund-decision tests (node --test).
- `node --check server.js`; `xcodebuild`; worker `python -c` import/syntax check.
- Adversarial verification pass on the cancel path (no double-charge, no
  resurrect, owner-only, worker abort correctness).

## Out of scope (YAGNI)
Cancelling after the recipe; pausing/resuming; cancelling someone else's job;
partial-result delivery on cancel.
