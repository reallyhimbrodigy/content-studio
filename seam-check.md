Report follows. Nothing is deployed — this is on the branch (`7b30150`), sequenced behind one migration.

---

# Report to Zac — launch-critical, all four + a blocker

## ⛔ The blocker (found while proving #1 — this is the headline)

**`video_jobs.valid_status` only allows `(queued, processing, completed, failed)`.** Everything the worker's v191 writes — `complete`, `canceled`, `needs_input` — is **rejected by the constraint**. And because `write_job_status` patches `status + result + phase` in **one atomic UPDATE**, a rejected status **silently drops `result` and `phase` with it.** So the worker's rich terminal state isn't being clobbered by the app so much as **it can't land at all** in the DB I can see. Same constraint rejects the app's cancel value `'cancelled'` → **Cancel Render has been failing in prod** (row stays `processing`, worker never sees the cancel).

**Proof** (against prod DB, service key):
```
ALLOWED video_jobs.status:  ✅ queued ✅ processing ✅ completed ✅ failed
                            ❌ complete ❌ canceled ❌ cancelled ❌ needs_input ❌ needs_clarification
```

**Fix:** migration `supabase/migrations/20260704_video_jobs_status_vocab.sql` (prepared, idempotent) expands `valid_status` to both vocabularies. **This must be applied before the app/worker terminal writes work.** It touches the worker-shared schema during the freeze, so I did **not** apply it — that's a coordination call for you + the worker session.

## #1 — Stop clobbering (app side: done + proven)
The app now writes **only owned columns** (URLs / recipe / thumbnail) and sets the terminal status **first-terminal-wins** via `.not('status','in', <terminal set>)` — **never `result`/`phase`, never over a terminal status the worker set, never a respell.** Both `dispatchJobToModal` (completion + all 4 failure writes) and `modal-progress` fixed.

**Proof** (prod DB): with a terminal row carrying `result={vocab,floor,enhancements_dropped}` + `phase`, the app's completion writes ran and **`result` + `phase` survived**, the app's URL merged in, status was not respelled. Hard-terminal rows were not resurrected. ✅ *(Run end-to-end against the worker's actual `complete` vocab is gated on the migration.)*

## #2 — Failure envelope + kill the spinner (iOS: done, build passes)
- `JobLifecycle.isTerminal` is now the single source of truth (worker + app + client vocab). **`MessageBubble` hides the progress UI on ANY terminal status**, and the SSE poller treats every terminal as done — no screen spins past a terminal row.
- **Root cause the envelope never showed:** the server pushed **camelCase** SSE keys but iOS decodes **snake_case** (`user_message`, `requires_new_video`, …), so the whole envelope silently failed to decode. Fixed the server push → the existing iOS handler now surfaces `user_message` (incl. the **CLIP_TOO_LONG** "trim and resubmit" copy), honors **`requires_new_video`** (reopens the picker), `requires_vibe_change`, and `retryable`.
- Library query now includes `complete` so worker-completed renders show.

**Proof:** `xcodebuild` SUCCEEDED (0 errors); the terminal-status set covers every vocab so the hide-condition can't miss one.

## #3 — Cancel contract (done)
Cancel is now an **atomic first-terminal-wins** UPDATE (`.not('status','in', terminal)` + row-count check): if the render reached terminal in the read→write window, the cancel is a no-op — **no resurrect, no double-refund**. (Its `'cancelled'` value needs the migration to be writable at all.) The worker session's mirror check tonight should confirm the reverse direction.

## #4 — Deploy discipline (followed)
- **No worker `./deploy.sh` run.** Worker repo untouched this task.
- App fixes committed to branch `7b30150` only — **not deployed to `main`.** I'm holding for your go so the app deploy can be **stamped + announced** and sequenced *after* the migration.

## Recommended sequence
1. **Apply `20260704_video_jobs_status_vocab.sql`** (you, coordinating with the worker session — it unblocks both sides).
2. I re-run the end-to-end proof against the worker's real `complete` vocab (should pass — logic already verified).
3. I deploy the app, **stamped + announced**.

Want me to proceed to step 3 on your word once the migration's in — or hand the migration to the worker session to apply with theirs?
