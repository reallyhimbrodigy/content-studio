# How much of ChatCut's 48s ingest floor can run before dispatch

**Read-only. 30 days to 2026-09-20. No spend.**

## The line

**For 62% of jobs the answer is NONE — the brief is already written when the
upload lands.** Median gap **1.2s**; 53.9% dispatch within TWO seconds of the
upload completing, and a further 7.9% send the brief BEFORE it completes.
Only **12.3% leave 48 seconds or more**.

## Distribution — signed gap, job.created_at minus upload_completed

| band | n | share |
|---|---|---|
| **BEFORE upload finished** (negative) | 255 | **7.9%** |
| 0–2 s | **1,749** | **53.9%** |
| 2–5 s | 238 | 7.3% |
| 5–10 s | 205 | 6.3% |
| 10–20 s | 183 | 5.6% |
| 20–48 s | 217 | 6.7% |
| 48–120 s | 162 | 5.0% |
| 120 s+ | 238 | 7.3% |

p10 0.6 · p25 0.8 · **p50 1.2** · p75 12.8 · p90 77.3 seconds (positive gaps only, n=2,992).

## The 0–2s spike is a ROUND TRIP, NOT A DECISION

53.9% of the population sits in one two-second bucket with p25 at 0.8s. No
human typing distribution has that shape. It is the client dispatching as soon
as the upload acknowledges, with a brief the user had already composed while the
transfer ran. Reading p50 = 1.2s as "users decide in about a second" would be
reading the network, not the person.

So the population is TWO populations, and only the second one has a window:
  * **~62%** — brief in hand at upload completion. Dispatch is immediate and
    there is no free time to spend, because there is nothing to wait for.
  * **~26%** — still composing, 2s to 48s. A partial window.
  * **~12%** — 48s or more. The full floor fits.

## Cohort and denominator

3,548 first-edit jobs in the window (`parent_job_id is null`, not demo,
`user_id` present). 3,247 paired to an `upload_completed` by the same user
within ±60 minutes — **91.5%**. The 301 unpaired are jobs with no upload event
in range; they are excluded rather than counted as zero.

## UPLOAD_TIMING DOES NOT EXIST IN THE DATA

`upload_timing` is in the server's analytics allowlist with a comment
describing `t_staged / t_first_byte / t_last_byte / t_ack / t_dispatch` against
a single t0 — and it has **ZERO ROWS, ever**. The event is allowlisted and
never sent. Every figure above therefore comes from `upload_completed`
(17,520 rows since 2026-07-24), which carries only `device_id`, `install_id`
and `app_version` — no job id and no clip id, which is why the pairing is
nearest-in-time by user rather than a join.

That means: the gap measured here is **upload-completed to job-created**, and
it cannot separate the client's own dispatch latency from the user's decision.
The t_ack/t_dispatch split that would separate them is exactly what
`upload_timing` was built to carry.

## What follows for the ChatCut entry

A pre-dispatch ingest call pays off on about an eighth of traffic and does
nothing for the majority. It is worth building only if it is free when the
window is zero — fire-and-forget at upload completion, behind a flag, with the
dispatch path never waiting on it. Which is the shape Zac specified.
