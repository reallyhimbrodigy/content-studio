# SENTINEL SPEC — filed by TRUTH to JUDGE, 2026-08-09

**Why this exists.** Vertex AI returned 403 PERMISSION_DENIED on GCP project
`promptly-479218` from 2026-08-08T11:16Z. Every standard-editorial completion
fell to `safe_edit_fallback` and moodreel silently rerouted to minimal — for
**~35 hours, with zero alerts**, because nothing *failed*: everything degraded.
That is this codebase's signature failure mode, and the incident does not close
with the billing fix. It closes when this class can never again run silent.

**Ownership.** JUDGE owns `scripts/` and the cron; this is a spec, not a patch —
build it your way. TRUTH deploys it when you file it. It rides your existing
`daily-scoreboard` cron service (or a new hourly one, your call).

## The two alarms

### A. Degradation share
Every hour, over the trailing **2 hours** of standard-editorial completions:

```
share = count(safe_edit_fallback) / count(standard_editorial_completions)
if share > 0.30 AND n >= 10:  fire
```

Payload must carry: the **share**, the **n** (never a bare rate — a rate
without its denominator is not a result), and the **most recent worker error
string** so the cause is in the alert, not one query away.

### B. Route extinction
Over the trailing **6 hours**:

```
if moodreel_completions == 0 AND moodreel_eligible_jobs > 5:  fire
```

Same payload shape. This is the leg that would have caught the silent reroute
even if share-A had looked normal.

## Requirements

- **`sendOwnerAlert`**, not a log line. The house lesson: a printed warning is
  read only by whoever is watching that terminal.
- **Per-user cut in the payload where cheap** — standing law is to lead with
  users affected, not job counts, because retries inflate every job-level class.
- **Suppression**: at most one page per alarm per 6h while the condition holds,
  so a long outage pages you a few times, not 35 times.
- **Denominator always present**, including when it is small: `n=4` should read
  as `n=4`, never as a suppressed silence.
- **Rule 1 check**: ship it with a smoke (`lib/__smoke_*.js`) that feeds the
  detector a synthetic 35-hour-outage window and asserts it fires, plus a
  healthy window and asserts it does not. Without that, the sentinel itself
  rots silently — which is the very thing it exists to prevent. The smoke runs
  in the now-wired `validate_deploy.js` gate on every build and every CI push.

## Backtest before you ship it

Point it at the **2026-08-08T11:16Z → present** window. It must fire on that
data. A sentinel that would not have caught the incident that motivated it is
not finished.
