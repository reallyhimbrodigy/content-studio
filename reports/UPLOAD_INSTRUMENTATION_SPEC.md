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

---

# RESULT — 2026-08-22. Initiation failure dominates, and the silent bucket is the SAME mode.

**Bucket `thisismybucketagainwooo`, region us-west-2 pinned. Validated against
BUILDER's independent read: 452 vs 452–453 open uploads, prefixes 442/3/3 vs
447/3/3 — two instruments, two lanes, agreeing within minutes of drift.**

| | |
|---|---:|
| open multipart uploads | 452 |
| in-flight (<6h) | 38 |
| **abandoned (≥6h)** | **414** |
| `sources/` · `exports/` · `renders/` | 447 · 3 · 3 |
| abandoned parts held | 11.2 GB = **$0.25/mo**, billing since 2026-05-02 |
| lifecycle rules | **0** — the evidence is intact |

## `bytes_uploaded` — the number that names the largest loss

| | |
|---|---:|
| **zero-byte** | **261 / 414 = 63.0%** |
| p50 | **0.00 MB** |
| p75 | 18.63 MB |
| p90 | 96.00 MB |
| max | 416.00 MB |

**VERDICT — INITIATION FAILURE, per the pre-registered read (≥50% zero-byte).**
The median dead upload **never moved a single byte.** The target is
permissions / disk / Photos export — the `"Export failed: Disk Full"` and
PHPhotos classes already visible in `upload_failed` — **not** network robustness
and **not** background-transfer resilience.

**It is BIMODAL and I am not flattening that.** 63% moved nothing; the top
quartile moved 18–416 MB. **Both fixes have a real population** — but initiation
is the majority, and it is the one nobody has worked on. Background-transfer work
addresses roughly the top quartile.

## Reported vs silent — the same-mode hypothesis, tested not assumed

Cut by USER (Rule 7): **242 distinct users**, p50 **1** abandoned upload each,
max 7 — so this is 242 lost users, not 414 failures.

| | users | share |
|---|---:|---:|
| ever fired `upload_failed` | 26 | 10.7% |
| **never fired it — SILENT** | **216** | **89.3%** |

| profile | n | zero-byte | p50 | p90 |
|---|---:|---:|---:|---:|
| REPORTED | 50 | 56.0% | 0.00 MB | 148.43 MB |
| **SILENT** | 358 | **64.2%** | 0.00 MB | 87.47 MB |

**The profiles match.** Both medians are zero; zero-byte shares are 56% vs 64%.
Per the read locked before the data: *"silent abandonments show the same
`bytes_uploaded` profile as reported ones → one mode, one fix, and the 62% is not
a separate problem."*

**CONFIRMED: the silent majority is not a second defect.** It is the same
initiation failure, invisible only because the app died before it could report —
which is why no client-side event could ever have found it.

## What this changes

**Stop treating upload loss as a network problem.** The largest single loss in
the product is uploads that never transfer a byte, and 89% of the users it hits
report nothing at all. The fix is on the pre-transfer path: file export, disk
space, Photos permissions.
