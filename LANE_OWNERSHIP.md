# LANE OWNERSHIP — who may touch what (published by TRUTH, 2026-08-09)

Five lanes work in parallel. **Only the TRUTH lane runs `deploy.sh` or pushes a
deploy branch, on either repo.** Every other lane commits to its `lane/<name>`
branch and files a deploy request with TRUTH. A deploy request whose diff
touches files outside the requesting lane's ownership is REJECTED.

The same map is published in both repos (`promptly-gpu-worker` and
`content-studio`); this copy and that copy are maintained together by TRUTH.

## The map

| Lane | Owns | Never touches |
|---|---|---|
| 1 JUDGE | content-studio `scripts/` (new), new Supabase tables/migrations, report files | server.js, dispatch-to-modal.js, worker repo |
| 2 HARNESS | worker `golden/`, `cert_golden_output.py`, `harness_plan_diff.py`; validate_deploy.py ADDITIONS via TRUTH | handler.py edits, modal_app.py, content-studio |
| 3 TRUTH | git state of both repos (branches/remotes/worktrees), deploy.sh, predeploy_no_regress.py, validate_deploy.py MERGES, validate_deploy.js, render.yaml, ci.yml, CANON, CLAUDE.md Rule 0, LANE_OWNERSHIP.md, DEPLOY_LOG.md | all runtime behavior (handler.py logic, server.js handlers, prompts, schemas) |
| 4 DELIVERY | modal_app.py completion-POST path, handler.py `write_job_status` region + lang_bundle population + latency-flag flip requests; content-studio dispatch-to-modal.js, server callback + RC-webhook handlers, job-reaper.js | prompt/schema regions of handler.py, chat endpoints, EditorView |
| 5 SEAM | handler.py prompt-assembly + adapter regions (NEW modules preferred), general/hype/minimal/moodreel_editor.py; content-studio NEW `lib/chat-actions.js` + new route file (one-line server.js mount via TRUTH) | write_job_status region, dispatch-to-modal.js, validate_deploy internals |

## Deploy queue — standing rules (TRUTH enforces)

1. **One deploy at a time.** File requests; they are serialized.
2. **Quiet window.** No deploy over in-flight user jobs — Modal tasks are
   polled and the deploy waits (standing law: every deploy orphans in-flight
   jobs; batch, announce the window, attribute the orphans).
3. **Gate green.** `validate_deploy.py` (worker) / `validate_deploy.js`
   (content-studio) must pass.
4. **No-regress green.** `predeploy_no_regress.py` must pass — including its
   lineage-ancestry check (the live commit must be an ancestor of the deploying
   HEAD).
5. **Diff-vs-ownership check.** The request's diff must stay inside the
   requesting lane's Owns column.
6. **Secret readback** after every worker deploy (part of deploy.sh already).
7. **Deploy log entry** — who, what, sha, version — in `DEPLOY_LOG.md`.

## How to file a deploy request

Commit to your `lane/<name>` branch, push it, and state in your report: the
branch, the sha, one line per change, and the check that makes each change's
regression impossible (Rule 1). TRUTH merges into `zero-reject-routing`
(worker) or `main` (content-studio), runs the gates, and deploys in the next
quiet window.
