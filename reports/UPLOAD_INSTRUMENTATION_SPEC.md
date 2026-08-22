# UPLOAD PATH — the reported taxonomy, and why the silent 62% CANNOT be instrumented from the client

**JUDGE, 2026-08-22.** 1,128 users/week lost before a job exists — 80% of all
delivery loss. Before specifying new instrumentation I measured what the existing
events already say, and it changes where the instrument has to live.

## What is ALREADY measured — the reported 38%

`upload_failed`, n=871 events, 08-14→08-20:

| mechanism | n | share |
|---|---:|---:|
| `cancelled` | 366 | 42.0% |
| `resume window expired` | 160 | 18.4% |
| `upload_failed` | 153 | 17.6% |
| `timeout` | 117 | 13.4% |
| `unknown` | 53 | 6.1% |
| `network_lost` | 14 | 1.6% |
| `http_400` | 7 | 0.8% |

| path | n | | http_status | n |
|---|---:|---|---|---:|
| **`background_orphan`** | **428 (72.7%)** | | **`0` (no response at all)** | **419 (97.9%)** |
| `multipart` | 161 (27.3%) | | `400` | 9 |

**`background_orphan` is 73% of every failure carrying a path, and 98% of
failures with an HTTP status got status `0` — no server response of any kind.**
Add `resume window expired` (160) and the **app-lifecycle class dominates the
reported failures**: uploads die when the app leaves the foreground.

Notable in `error_desc`: **"Export failed: Disk Full" (28)** and PHPhotos/CloudPhotos
errors — device storage and Photos-library access are real, smaller classes that
no one has named.

## Why the silent 62% is structurally invisible to the client

**A client event cannot report a failure that kills the client.**

`upload_failed` is fired from `BackgroundUploadManager.swift` and
`ResumableMultipartUploader.swift`. When iOS terminates a backgrounded app, the
process dies **with the reporting code inside it** — and `AnalyticsService.track`
is best-effort by default (`durable` only retries the *DB mirror* POST, and the
retry loop dies with the process too).

**So the reported 38% and the silent 62% are very likely the SAME failure mode,
separated only by whether the app lived long enough to say so.** `background_orphan`
at 73% of reported failures is the strongest evidence for this: it is the mode
that, when slightly worse, leaves no witness at all.

**Consequence: shipping more client events would measure the population that
already reports, and miss the one that does not.** That is the same shape as
instrumenting `analyze-video.js` alone and calling it the Gemini total.

## The instrument must be SERVER-SIDE, and the data already exists

The upload is **S3 multipart** (`services/s3.js` — `CreateMultipartUploadCommand`,
`UploadPartCommand`, `AbortMultipartUploadCommand`; client side
`ResumableMultipartUploader.swift`).

**An abandoned multipart upload is a durable server-side artifact.** Every upload
that started and never finished leaves parts in the bucket, visible via
`ListMultipartUploads` — **no client cooperation required, and no App Store build.**

### Spec — `upload_abandonment` sweep

Read-only, scheduled, zero client dependency:

| field | source | why |
|---|---|---|
| `upload_id`, `key` | `ListMultipartUploads` | identity |
| `initiated_at` | S3 | start of the attempt |
| `parts_uploaded`, `bytes_uploaded` | `ListParts` | **how far it got — the single most diagnostic field, and nothing today records it for silent losses** |
| `age_at_sweep` | derived | separates in-flight from abandoned |
| `user_id` | key prefix / DB join | **Rule 7 — cut by user, not by upload** |
| `has_upload_failed_event` | join to `analytics_events` | **splits REPORTED from SILENT on the same population** |

**That last row is the whole point:** it measures the silent bucket *and* proves
whether it is the same mode as the reported one, rather than assuming it.

### Pre-registered reads, before the data

- **`bytes_uploaded` clusters near zero** → failures are at *initiation*
  (permissions, disk, file export), not transfer. The "Export failed: Disk Full"
  and PHPhotos classes are then the target, not network.
- **`bytes_uploaded` spread across the range** → transfer-death, consistent with
  `background_orphan`, and the fix is background-transfer robustness.
- **silent abandonments show the same `bytes_uploaded` profile as reported ones**
  → one mode, one fix, and the 62% is not a separate problem.
- **profiles differ** → two distinct modes and the silent one has never been
  characterised; do not reuse the reported taxonomy for it.
- **abandoned uploads ≈ 1,128/week** → the accounting closes. **Materially fewer
  and a second loss channel exists that neither events nor S3 can see** — I would
  report that gap rather than attribute it.

## Lane note

`services/s3.js` and the iOS client are **not JUDGE's lane** — this is a spec,
filed, not built. The sweep script itself (read-only, `scripts/`) **is** in my
lane and is the part I can build once the bucket/prefix convention is confirmed.

**A secondary check costing nothing:** abandoned multipart parts are **billed S3
storage** until aborted. If no lifecycle rule expires them, this is quietly on the
cost board too — and it would be the first line on it that is *caused by* the
delivery-rate defect.
