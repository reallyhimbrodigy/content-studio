# CHECKOUTS — which working copy is for what (TRUTH, 2026-08-09)

**Server code is only ever read from `origin/main`.** The deployed server is
`main` on Render (autoDeploy); any other branch's `server.js` is a stale or
divergent copy and has already caused misdirected investigations (the primary
checkout sat 124 commits behind the running server).

| Path | Branch | Purpose |
|---|---|---|
| `/Users/zaclibman/content-studio` | `app-1.3.x` | **iOS app work** (Xcode). Its `server.js` is STALE by construction — never read server truth here. |
| `/Users/zaclibman/content-studio-main` | `main` | **Canonical server-truth checkout.** Kept fast-forwarded to `origin/main`. Read server code here (or from `origin/main` directly). |
| `/Users/zaclibman/content-studio/.worktrees/lane-*` | `lane/<name>` | Per-lane worktrees, branched from `origin/main`. Commit lane work here; TRUTH merges + deploys. |
| `/Users/zaclibman/content-studio-pushes` | `render-pushes` | Historical push-fix worktree (pre-lane). Do not use for new work. |
| `/Users/zaclibman/content-studio-runjob-auth` | `security/export-gate` | Historical security worktree (pre-lane). Do not use for new work. |

Deploy rules: see `LANE_OWNERSHIP.md`. Only the TRUTH lane pushes `main`
(every push to `main` IS a Render deploy and orphans in-flight jobs — batch,
announce the window, attribute the orphans in `DEPLOY_LOG.md`).
