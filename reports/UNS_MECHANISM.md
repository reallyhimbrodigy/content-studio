# UNS — the mechanism, named [MEASURED 2026-08-12]

Window: jobs and events since **2026-08-06T00:00:00Z**. Every rate below carries
its denominator; user counts lead job counts (Rule 7).

## 1. The job-row discriminator nobody had used

| `source_type` | jobs | UNS | rate |
|---|---|---|---|
| `local` | 1,470 | **0** | **0.0%** |
| `icloud` | 66 | **0** | **0.0%** |
| `NULL` | 700 | 289 | 41.3% |

**All 289 UNS jobs have `source_type = NULL`. Not one upload that reported its
source type has ever leaked.** `modal_call_id` is NULL on 289/289 — the worker
never started, so this is entirely pre-dispatch.

NULL is necessary but not sufficient: 411 other NULL-source_type jobs exist and
379 of them **completed**. So the discriminator is not "NULL is fatal" — it is
that the client stops reporting at the same point it stops uploading.

## 2. The upload funnel — where it actually dies

| stage | n |
|---|---|
| `upload_url_requested` | 13,317 |
| `upload_started` | 4,825 |
| `upload_completed` | **1,161 (24.1% of started)** |
| `upload_failed` | 588 |

**`upload_failed`: 1,315 events / 720 USERS** across the window — ~2.8× the 258
users with a UNS *job row*. The job-row class is the tip; most upload loss never
creates a row at all.

| mechanism | events | % | users |
|---|---|---|---|
| `cancelled` | 704 | 53.5% | 395 |
| `upload_failed` | 304 | 23.1% | 213 |
| `timeout` | 194 | 14.8% | 136 |
| `unknown` | 86 | 6.5% | 39 |
| `http_400` | 15 | 1.1% | 11 |
| `network_lost` | 11 | 0.8% | 4 |

## 3. THE MECHANISM: a single non-resumable PUT that dies at byte ~zero

How much of the file had transferred when it died (n=487 carrying
`pct_complete`):

| p10 | p50 | p90 | max |
|---|---|---|---|
| 0.00% | **0.00%** | 24.17% | 100% |

- **79% (386/487) died with under 1% transferred.**
- **89% died under 20%.**

How long they hung first: p50 **0.0 min**, p90 **30.4 min**, max **133 min**;
76 hung ≥25 minutes. Observed timeouts sit at ~1,816–2,150 s elapsed with
`pct_complete` of 0.0013–0.20 — thirty-plus minutes to move a fraction of a
percent.

And the upload is **not multipart**:

| `upload_url_requested` path | n |
|---|---|
| `single` | **13,310** |
| `multipart` | **7** (0.05%) |

`background_orphan` accounts for 347 of the failures against 109 completions —
uploads the OS killed when the app left the foreground.

**Put together:** one PUT of the whole file, no resumability, no chunking. When
the app backgrounds or the network wobbles, the transfer dies — usually before
1% has moved — and the presigned key is dead. Nothing resumes, so every retry
starts from zero. That is why this is environmental (1.12 jobs per affected
user: breadth, not repetition) and why **82% of affected users never complete
anything, ever**: their first impression is a 30-minute hang ending in nothing.

The current remedy copy — *"pick it again to start a fresh upload"* — is
correct about the dead key and still asks the user to repeat, from zero, the
action that just failed.

## 4. What is NOT yet measurable, stated as such

**Size banding is impossible today.** `upload_attempt` (the `{size_mb, path,
src_key}` instrument that would band this by file size) is emitted **0 times**
in the window: it ships in 1.3.7 (225); live traffic is 1.3.6 (224) at
2,126/2,236 jobs. It is allowlisted server-side [CODE server.js:3178] and has
never fired. So "is this big files or slow networks?" is **[UNKNOWN]**, and the
unblock is shipping 225 — not another query.

Version rates, for completeness (n≥15 only): 1.3.6 (224) 283/2,126 = 13.3%;
223 6/74 = 8.1%; 221 0/18. The 224 population is ~95% of traffic, so the other
bands are too small to read as a version effect.

## 5. Server-side mitigations buildable now (dark)

1. **Restore the multipart/resumable upload server half** — mint multipart
   upload IDs and part URLs so a client can resume across suspensions. The
   server half is inert without the client, so it can ship dark today.
2. **Presign lifetime** — a key that dies mid-transfer forces the restart; size
   the TTL past the observed p90 (30 min) so a slow-but-live transfer is never
   killed by expiry alone.
3. **Honest copy** — stop telling a user on a slow connection to repeat a
   30-minute action unchanged.

The client half is IOS_FINAL_BUILD **item 7**.
