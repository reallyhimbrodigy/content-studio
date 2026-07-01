# Lumen Ask-Back Chat UI (Phase D — frontend + app-server) — Design Spec

Date: 2026-06-30
Status: Approved; building. Pairs with the worker directive (resume/partial_state).

## Goal
Lumen parks a Lumen job at `status=needs_input` with an `ask` payload. Surface
the ask in chat (in the existing progress bubble — bar pauses → question →
answer → bar resumes), collect the answer (text / image / clip / choice) or
skip, and resubmit `{ask_id, answer|skip}` on the re-edit rail so the worker
resumes from `partial_state`. Premium, collaborator feel — never a gate.

## Contract (confirmed)
- Row: `status=needs_input`, `ask jsonb = {ask_id, prompt, answer_kinds:[text|
  image|clip|choice], optional, context, choices?}`. `partial_state jsonb`
  worker-internal.
- Resume: extend the re-edit rail → re-dispatch to Modal `{job_id, resume:true,
  ask_id, answer:{…}}` (worker `mode=resume_ask`).
- Uploads → same presigned/S3 storage the pipeline reads; the answer carries keys.
- Feature-flagged OFF (worker ASK_BACK_ENABLED) until this ships + both columns
  applied. Coordinate the flip.

## Migration (CRITICAL)
`supabase/migrations/20260630_job_ask.sql`: `ALTER TABLE video_jobs ADD COLUMN
IF NOT EXISTS ask jsonb; ADD COLUMN IF NOT EXISTS partial_state jsonb;`
PostgREST silently drops reads/writes to unknown columns — without `ask` the
question never surfaces. Zac applies; confirm a round-trip after.

## App-server (server.js + lib/ask.js)
- **Poll:** add `ask` to the GET /:id select AND the iOS Supabase-REST select in
  `reconcileJobStatus`.
- **lib/ask.js (pure, unit-tested):**
  - `VALID_ANSWER_KINDS = ['text','image','clip','choice']`.
  - `isAnswerSubmission(body)` → true iff `body.ask_id` present.
  - `validateAnswer({ask_id, answer, skip, answer_image_key, answer_clip_key,
    answer_choice})` → `{ok, value}|{ok:false,error}` (ask_id non-empty string;
    at least one of skip / text / image_key / clip_key / choice; length caps).
  - `canAcceptAnswer({job, userId, askId})` → `{ok:true}|{ok:false,reason}` —
    THE guard: job exists AND `job.user_id===userId` AND `job.status===
    'needs_input'` AND `job.ask?.ask_id===askId`. Makes double-answer /
    after-timeout / stale / wrong-user safe rejects.
- **Re-edit rail** (`POST /api/video-jobs/re-edit`): if `isAnswerSubmission`:
  load the job, run `canAcceptAnswer` (403/409 on fail — a safe no-op the client
  treats as "already resumed"), `validateAnswer`, then: update row `status=
  'processing'`, `ask=null`, store the answer (into the resume dispatch), and
  `dispatchJobToModal({ jobId, resume:true, askId, answer, parentJobId:jobId,
  … })` → Modal `mode=resume_ask`. Else the existing change-request path runs
  unchanged. Relax "change_request required" only when `ask_id` present.
- **dispatch-to-modal.js:** thread `resume`, `askId`, `answer` into the payload
  (`resume:true`, `ask_id`, `answer`, `mode:'resume_ask'`) — gated Pro like re-edit.

## iOS
- **`AskPayload`** (Codable, in Models): `askId, prompt, answerKinds:[AnswerKind],
  optional, context?, choices:[AskChoice]?`. `AnswerKind` enum text/image/clip/
  choice (unknown → ignored). Pure `AskAnswer` builder + validation, swiftc-tested.
- **Persist:** `ChatMessage.ask: AskPayload?` + `SerializedMessage.ask` (init +
  toChatMessage) so it survives background/relaunch; keep in-flight on restore.
- **Poll:** `reconcileJobStatus` selects `ask`; on `status=='needs_input'` with a
  decodable `ask`: set `message.ask`, `jobStatus='needs_input'`, persist. (No ask
  → leave to the legacy needs_clarification SSE path; don't touch.)
- **Bubble/pause:** MessageBubble shows the progress view for `needs_input` too;
  the bar HOLDS (no re-ramp, no finish) with label "Lumen has a question" and the
  ask card below. On answer/skip → `jobStatus='processing'`, `ask=nil` → bar
  resumes (poll confirms).
- **Ask card** (`AskCard.swift`): warm prompt; affordances by `answerKinds` —
  `text`→reply field; `image`→PhotosPicker; `clip`→NativeVideoPicker; `choice`→
  chips. Prominent penalty-free **"Skip / use what I have."** Disabled + spinner
  while submitting.
- **Upload→key:** image/clip → `getUploadUrl(fileName)` → `uploadToS3` (multipart
  for clips) → key. Failure → inline error, ask stays (retryable).
- **Resubmit:** `APIService.answerAsk(originalJobId, askId, answer)` → POST
  /api/video-jobs/re-edit `{original_job_id, ask_id, answer|skip, answer_image_key?,
  answer_clip_key?, answer_choice?}`.

## Lifecycle
- Ask persisted → relaunch/foreground re-shows it from the polled row.
- Never-answered + worker timed out & completed → poll `status=completed` →
  existing completion path reveals the video; the ask card just disappears.
- Double-answer / after-timeout → `canAcceptAnswer` rejects (safe no-op); the
  client, on a reject, refreshes via the poll (which shows resumed/completed).

## Testing
- swiftc: `AskPayload` decode (all kinds, unknown-kind, missing fields),
  answer-kind→affordance, `AskAnswer` builder/validation (skip vs text vs
  image/clip/choice; at-least-one rule).
- node: `lib/ask.js` — isAnswerSubmission, validateAnswer (caps, at-least-one),
  canAcceptAnswer (owner/status/ask_id matrix incl. double-answer/after-timeout/
  wrong-user/missing-ask).
- xcodebuild; node --check server.js + libs.
- Adversarial workflow: double-answer, answer-after-timeout, upload failure,
  app-killed-mid-upload, + poll/lifecycle/security dimensions → verify → fix.
- Screens: ask in chat, image-upload answer, skip, background→reopen re-show.

## Out of scope (YAGNI)
Worker resume/partial_state (paired); generating asks (worker caps 1–2); the
legacy needs_clarification dead-end (left as-is); flipping ASK_BACK_ENABLED.
