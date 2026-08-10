# EXPORT INVERSION — VERDICT: KILLED (inverted claim was a window artifact)

**Lane 1 / JUDGE, 2026-08-10. Script: `scripts/export-inversion.js` (read-only, paginated, zero Modal spend).**

## The claim under test
`QUALITY_FAULT_ROADMAP.md` (worker repo): *standard editorial exports at 9.9% while near-passthrough moodreel exports at 20%* — i.e. the editorial machinery is net-negative on the metric that matters.

## Verdict
**The inversion does not exist. On a clean cohort the relationship is REVERSED at ~1.6×: standard editorial is the MOST-exported route, and it survives every confound cut.** `[MEASURED]`

## The clean numbers (jobs created ≥ 2026-08-01, the birth of `export_completed` instrumentation)

Join: `analytics_events.props->>job_id` → `video_jobs.id` (direct; both `export_completed` and `result_viewed` carry `job_id` `[MEASURED]`). Route: `result->>route`; **absence of the key on a completed job = standard editorial**; lean routes carry `minimal|minimal_speech_uncut|moodreel|hype`. Window: earliest `export_completed` = 2026-08-01T06:04Z `[MEASURED]`, so pre-08-01 jobs could never log an export and are excluded from the cohort.

| route | n completed | viewed (%) | **exported / completed** | **exported / viewed** |
|---|---|---|---|---|
| **standard_editorial** | 1,391 | 87.3% | **415 → 29.8%** | **34.2%** |
| minimal_speech_uncut | 771 | 88.7% | 131 → 17.0% | 19.2% |
| **moodreel** | 646 | 87.5% | **124 → 19.2%** | **21.9%** |
| minimal | 255 | 91.8% | 51 → 20.0% | 21.8% |
| hype | 52 | 92.3% | 7 → 13.5% | 14.6% |

Arithmetic shown in-table: e.g. standard = 415/1,391 = 29.8%. Events pulled: 1,002 `export_completed` (743 distinct jobs; 692 save / 310 share), 9,381 `result_viewed` (2,807 distinct jobs). Sanity: 15 exported job_ids reference pre-window jobs (excluded); 0 exports of non-completed jobs.

**View rates are flat (87–92%) across all routes — users SEE both kinds equally. The divergence is at the SAVE step.** That is a content-preference signal, not a funnel artifact.

## Confound cuts — the inversion-reversal survives both

**1. Source-duration (quality proxy) — standard leads in EVERY bucket** `[MEASURED]`:

| route | 0–20s | 20–60s | 60–120s |
|---|---|---|---|
| standard_editorial | **27.1%** (92/339) | **39.4%** (87/221) | **39.5%** (15/38) |
| moodreel | 16.6% (35/211) | 25.4% (16/63) | 22.2% (2/9) |
| minimal_speech_uncut | 15.4% (22/143) | 19.1% (18/94) | 28.1% (9/32) |

(Caveat: `source_duration` is null on ~50% of rows → an `unknown` bucket, which also favors standard 27.8% vs 19.4%. The known-duration cells are consistent, so the null mass does not change the direction. `[MEASURED]`)

**2. Same-user control (the strongest cut) — among the 102 users who completed jobs on BOTH standard and lean routes: the SAME user exports their standard-editorial videos at 40.8% (42/103) vs their lean-route videos at 22.4% (32/143).** `[MEASURED]` This eliminates the "better creators pick different routes" confound entirely: identical humans, ~2× preference for the edited output.

**3. Per-user:** 27.3% of standard-only users (n=1,147) exported at least once, vs 18.8% of moodreel-only (n=584), 16.8% of minimal_speech_uncut-only (n=686). `[MEASURED]`

## Where the false 9.9% came from
All-time (contaminated) cut: standard 415/2,081 = 19.9%, moodreel 124/679 = 18.3% `[MEASURED]`. Standard editorial is the OLDEST route — 690 of its 2,081 all-time completed jobs (33%) pre-date export instrumentation and can never log an export; the lean routes launched later and carry almost no pre-instrumentation tail. `[INFERRED]` The roadmap's 9.9% was almost certainly computed on an even earlier snapshot when the pre-instrumentation fraction of the standard cohort was larger still — **differential window contamination, precisely the confound class this lane exists to kill.** Even the contaminated all-time cut today no longer reproduces 9.9% vs 20%.

## What this means for the other lanes (one line)
**The editorial machinery is net-POSITIVE on the export metric — ~1.6× over near-passthrough, ~2× within-user.** Quality lanes should optimize the editorial path, not question its existence. The weakest route by export preference is `hype` (13.5%, small n=52) and `minimal_speech_uncut` (17.0%, n=771) — the lean routes are where output is least save-worthy.
