# `video_jobs` status-vocabulary reconciliation (Step 1)

Read-only. Frontend session's half (app WRITES + app READS, verbatim file:line) +
the proven constraint + a cross-read of the worker source for the worker-WRITES
column (worker session to ratify verbatim). Purpose: resolve the conflict —
"frontend proved the constraint bounces the worker vocab" vs "worker proved its
writes round-trip" — at source level before anyone designs a migration.

## 0. The crux — why BOTH proofs are correct (they describe different contexts)

The worker's durable `write_job_status` is doubly gated, and neither gate points at
`video_jobs` by default:

| Gate | Source (worker `handler.py`) | Default | Effect if unset in prod |
|---|---|---|---|
| `JOB_STATUS_WRITES_ENABLED` | `_job_status_enabled()` L19344–19345 | **OFF** | `write_job_status` is a **no-op** — nothing is written at all |
| `PROMPTLY_JOB_TABLE` | L1579, L1723 (`… or "jobs"`) | **`jobs`** | writes land in table **`jobs`**, NOT `video_jobs` |
| `PROMPTLY_JOB_STATUS_COLUMN` | L1725 (`… or "status"`) | `status` | — |

So the worker's round-trip proof can be true (against `jobs`, or against a
`video_jobs` with a permissive constraint in its env) **and** the frontend's proof
can be true (`video_jobs.valid_status` rejects `complete`/`needs_input`) at the
same time. **The seam only closes if, in prod: (1) `JOB_STATUS_WRITES_ENABLED=1`,
(2) `PROMPTLY_JOB_TABLE=video_jobs`, and (3) `video_jobs.valid_status` allows the
canonical vocab.** Confirming (1) and (2)'s live values is the worker session's
part of Step 1.

## 1. Constraint — PROVEN (frontend, prod DB, service key)

`video_jobs.valid_status` allows exactly: **`queued, processing, completed, failed`**.
Probe result:

```
✅ queued  ✅ processing  ✅ completed  ✅ failed
❌ complete  ❌ canceled  ❌ cancelled  ❌ needs_input  ❌ needs_clarification  ❌ error
```

Atomic-patch consequence (proven): `write_job_status` patches `status+phase+result`
in ONE update; a bounced status rejects the whole row, so `result`/`phase` are
dropped with it.

## 2. The reconciliation table (durable `video_jobs.status` — constraint-relevant)

| status string | WORKER writes → video_jobs? (handler.py) | APP writes (content-studio) | constraint allows? | APP reads/filters |
|---|---|---|---|---|
| `queued` | — | server.js:1655 (createQueuedVideoJob) | ✅ | EditorView:282; server concurrency 3064 |
| `processing` | ✅ 19761, 22413, 23013, 23507 (`_async_job_status`) | dispatch:276; server 3250 (ask-resume) | ✅ | EditorView:281; server 3289 |
| `completed` | ❌ — worker uses `complete` | dispatch:557; server:1562 (modal-progress) | ✅ | getUserEdits:380; SSEClient:216; EditorView:393 |
| **`complete`** | ✅ **23678** (`status="complete"` terminal) | ❌ — app uses `completed` | ❌ **BOUNCE** | getUserEdits:380; SSEClient:216; JobLifecycle:486 |
| `failed` | ✅ 20477, 20506, 20660, 23711 | dispatch:350/382/433/625; (SSE-only pushes 358/441/633) | ✅ | getUserEdits:380; SSEClient:231; EditorView:393; MessageBubble:271 |
| **`needs_input`** | ✅ **19706, 21017** | server.js:3286 (ask-park) | ❌ **BOUNCE** | getUserEdits:380; EditorView:283/1597/1607; MessageBubble:205 |
| **`cancelled`** (British) | ❌ — worker never writes it (only READS via is_cancelled) | **server.js:2927 (cancel endpoint)** | ❌ **BOUNCE** | server render-cancelled read 2981 (`status==='cancelled'`); JobLifecycle:487 |
| `canceled` (American) | ❌ — only in worker `_terminal` DETECTION set (19362); never written | ❌ | ❌ **BOUNCE** | JobLifecycle:487 |
| `needs_clarification` | ❌ (worker response-envelope only, not a DB write) | ❌ (SSE-only push dispatch:391; DB write is `failed`) | ❌ | getUserEdits:380; EditorView:394; JobLifecycle:488 |
| `error` | ❌ | ❌ | ❌ | SSEClient:231; JobLifecycle:486; MessageBubble:271 |

**Highlighted mismatches (the four that matter):**
1. **`complete` vs `completed`** — worker writes `complete` (23678); constraint + app use `completed`. Spelling split on the success terminal.
2. **`needs_input`** — worker writes it (19706/21017) AND app writes it (3286, ask-back); constraint rejects it. Both sides blocked on the same value.
3. **`cancelled` (app) vs `canceled` (worker detection set)** — app WRITES `cancelled` (2927) and READS `cancelled` (2981); worker's `_terminal` set expects `canceled`. Spelling split on cancel. Constraint rejects both.
4. **`needs_clarification`** — app SSE-transient + a read filter, never a DB write; harmless but non-canonical.

## 3. Two vocabularies (don't conflate)

- **Durable `video_jobs.status`** (constraint-governed, the table above): worker `write_job_status` + app DB writes.
- **Transient (unconstrained, never hits the constraint):** the Modal HTTP response `result.status` (worker returns `success`/`needs_clarification`/`needs_input`/`cached`/`unknown` — handler.py 20095/21021/23647/19933/19602) and the SSE-event `status` the app pushes to the client (`completed`/`failed`/`needs_clarification`/`cancelled`). These are read by iOS but are NOT DB writes; canonicalization is optional for them, but aligning avoids a translation layer.

## 4. Canonical alignment — app-side deltas (if canonical = `queued, processing, completed, failed, canceled, needs_input`)

Frontend changes required in Step 3, on branch `7b30150` (not yet merged):
- `server.js:2927` cancel write `'cancelled'` → **`'canceled'`**.
- `server.js:2981` render-cancelled read `=== 'cancelled'` → **`=== 'canceled'`** (worker's `is_cancelled` depends on this).
- `server.js:2954` SSE push `status:'cancelled'` → `'canceled'` (transient, for consistency).
- `server.js:209` `TERMINAL_JOB_STATUSES_SQL` → drop non-canonical (`complete`, `cancelled`, `needs_clarification`); keep canonical terminal set.
- `dispatch-to-modal.js:391` SSE push `'needs_clarification'` → **`'needs_input'`** (or leave transient; DB write already `failed`).
- `Models.swift:485–488` `JobLifecycle.terminal` → canonical terminal set (`completed, failed, canceled, needs_input` + keep `error` for client-only).
- `APIService.swift:380` getUserEdits filter → canonical (`completed,processing,queued,failed,needs_input`; drop `complete`/`needs_clarification`/`cancelled`).

## 5. Open items for the WORKER session (Step 1 completion)

1. Live prod values of `JOB_STATUS_WRITES_ENABLED` and `PROMPTLY_JOB_TABLE` — is durable-write ON, and does it target `video_jobs`? This decides whether the round-trip was ever against `video_jobs` at all.
2. Re-run the round-trip **explicitly against `video_jobs`**: attempt `status="complete"` and `status="needs_input"` writes and report bounce + whether `result` is dropped on bounce (mirror of frontend's proof).
3. If canonical ratified: worker `write_job_status` `complete` → **`completed`** (handler.py:23678); `needs_input` stays.

## 6. v188 "Cancel render" deploy stamp (per standing note)

- **Worker cancel** (is_cancelled + abort checkpoints): commit `860abb7` "Cancel render: is_cancelled() check before recipe + before GPU render" (worker repo; last handler.py author on record: `Codex <codex@local>`, 2026-07-03 18:32 PDT).
- **App cancel** (endpoint + red button + refund): commit `9ebdd7f` "Cancel render before the recipe (red button + true cancel)" (content-studio, this frontend session).
- **v188 Modal deploy stamp** (who/when shipped): Zac's note says **01:14 PDT, non-primary hand**. The exact deployer identity lives in the worker session's Modal deploy log / the v188 tag — **needs the worker session's one-line read** (frontend has no Modal deploy visibility).

## Protocol

Frontend session has adopted the file-first reporting protocol permanently: this
report is saved as a file (`status_vocab_table.md`) for Zac to upload — not pasted.
