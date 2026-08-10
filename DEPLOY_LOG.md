# DEPLOY LOG — content-studio (owned by TRUTH)

Every push to `main` IS a Render deploy and orphans in-flight jobs (Zac
2026-08-04). So every deploy is logged here — who, what, sha — with its window,
and orphans inside the window are attributed to the deploy, not counted as a
mystery class. Clean orphan cohort = job STARTED <20 min before the deploy AND
died at/after the deploy instant.

| when (UTC) | who | sha | carried | window/orphans |
|---|---|---|---|---|
| _pending_ | TRUTH | lane/truth batch | smoke-gate wiring (Render build + CI), LANE_OWNERSHIP.md, CHECKOUTS.md, this log | to be filled at deploy |
