# OWNER ACTIONS — the things only Zac can do (TRUTH, 2026-08-09)

Everything else in the queue ships without you. These four cannot: three need
credentials this machine does not have, one needs a dashboard.

---

## 1. Apply three migrations (blocks two watches, not two deploys)

[MEASURED] DDL cannot run from this machine: no `psql`, no `pg` module, and the
pooler URL carries no password — independently confirming the JUDGE lane's same
finding. All three are **additive-only** (`create table if not exists` /
`add column if not exists`); none touches an existing column's type or data.

Paste into the Supabase SQL editor, in any order:

| file | what it creates | whose watch it unblocks |
|---|---|---|
| `supabase/migrations/20260810_fulfillment_scores.sql` | `public.fulfillment_scores` + 2 indexes | JUDGE — back-catalog judgments |
| `supabase/migrations/20260810_daily_scoreboard.sql` | `public.daily_scoreboard` | JUDGE — the daily row (retires the JSONL fallback) |
| `migrations/20260810_completion_delivery.sql` | `video_jobs.completion_delivery`, `video_jobs.worker_started_at` | DELIVERY — the 48h `fallback_timer → ~0` watch |

**The code ships before you do this and stays safe**: `scripts/scoreboard.js`
falls back to `out/daily_scoreboard.jsonl` and prints `TABLE WRITE FAILED …
Apply supabase/migrations/…` [CODE](scripts/scoreboard.js:125), and DELIVERY's
columns are `if not exists`. So a missed migration degrades loudly instead of
crashing — but the watches stay blind until it lands.

## 2. GCP billing → Vertex 403 (the live outage)

Project `promptly-479218` has returned 403 PERMISSION_DENIED ("dunning decision
is deny") since 2026-08-08T11:16Z. Only you can clear it. Ping TRUTH the moment
it is fixed — it unblocks: HARNESS's freeze, the outage-recovery verification,
and the sentinel's baseline.

## 3. RevenueCat `/sync` env on Render

`REVENUECAT_PROJECT_ID` → the `proj…` v2 id, plus the matching `sk_…` key.
DELIVERY's self-proving probe verifies it afterward; TRUTH records the result.

## 4. One line from a Render build log (30 seconds)

[UNKNOWN] to this lane: whether Render auto-applies a `render.yaml`
`buildCommand` change without a manual blueprint sync — and there is no Render
API key on this machine, so I cannot read the build log myself. The CI half of
the gate is **proven red** [MEASURED] (a deliberately broken smoke failed
exactly the new CI step). After the next content-studio deploy, please confirm
the build log contains a line like:

```
✅ 20/20 smoke(s) passed. Safe to deploy.
```

If that line is **absent**, the Render half never armed and needs a manual
blueprint sync in the dashboard — tell me and I will re-file it.
