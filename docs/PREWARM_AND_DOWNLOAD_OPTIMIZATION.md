# Upload → Render latency: what ships now vs. what you need to do

## What this change does

Eliminates the ~20 second "Loading your footage" delay via three independent
optimizations, all composable. The first two ship in code on this commit;
the third requires ~15 minutes of AWS console work.

```
                           BEFORE                  AFTER
user taps Send  ────────►  [wait ~20s]         ►   [wait ~0-3s]
                           │  S3 download         │  cache hit OR
                           │  (single-stream,     │  fast parallel
                           │   cross-region)      │  boto3[crt] DL
                           │  THEN                │  + URL transcribe
                           │  transcribe          │  already running
                           │  THEN                │
                           │  trend fetch         │
                           ▼                      ▼
                        pipeline starts        pipeline starts
```

## 1. Tuned S3 downloads (active immediately on Modal redeploy)

- Modal image gained `boto3[crt]` — AWS Common Runtime for 2-6× S3 throughput.
- `TransferConfig(multipart_chunksize=16MB, max_concurrency=32)` applied to
  every `download_file` in the worker. 32 threads saturate the H100's network.
- **Expected:** 60MB file goes from 10-20s (stock boto3) to 2-5s (same-region)
  or 5-10s (cross-region).

## 2. Parallel URL-based transcribe + trend fetch (active immediately)

- New `transcribe_audio_url()` in `handler.py` hits Deepgram with a presigned
  S3 URL directly — Deepgram's servers fetch the video while Modal's own
  download runs concurrently.
- `get_trend_context()` fires on the same early pool (pure DB read, doesn't
  need the video).
- **Expected:** transcript is typically ready by the time the local download
  finishes, saving ~3-6s of serial work. Falls back gracefully to file-based
  transcribe if URL-based fails.

## 3. Attach-time prewarm with Modal Volume cache (active on next deploy)

iOS fires `POST /api/prewarm` the moment the S3 upload completes (well before
the user taps Send). Server forwards to Modal's `/prewarm` endpoint which
downloads the video into `promptly-prewarm-cache` Volume keyed by
`sha1(bucket/key)`.

When the real `/api/video-jobs` request arrives and the Modal worker reaches
the download step, it checks `/prewarm/{hash}/source.mp4` first — cache hit
= instant copy, cache miss = fall back to normal S3 download.

**Expected:** on a typical flow where the user takes >3s between attaching
and sending (which is almost every flow), the download step is ~0s.

---

## What you need to do

### Required: redeploy Modal

```bash
cd /Users/zaclibman/promptly-gpu-worker/promptly-gpu-worker
modal deploy modal_app.py
```

Creates the new `promptly-prewarm-cache` Volume and adds the `/prewarm`
endpoint alongside `run_job`.

### Required: set `MODAL_PREWARM_URL` (or let it auto-derive)

The server tries to derive the prewarm URL from `MODAL_ENDPOINT_URL` by
swapping `-run-job` → `-prewarm`. If your Modal URLs follow the default
`{org}--{app}-{class}-{method}.modal.run` pattern, this works automatically.

If you want to set it explicitly (recommended, safer against future Modal
URL format changes):

1. After `modal deploy`, Modal prints the prewarm endpoint URL.
2. On Render, set `MODAL_PREWARM_URL` to that URL.

### Strongly recommended: move S3 bucket to us-west-2

This is the single biggest win and ONLY you can do it (AWS console work).
Your bucket is currently `us-west-1` (N. California); Modal runs in
`us-west-2` (Oregon). Cross-region transfer is ~3× slower than intra-region.

**Steps:**

1. **AWS Console → S3 → Create bucket** in `us-west-2`. Same config as
   existing bucket (block public access, versioning off, etc.).
2. **Enable cross-region replication** from old bucket to new bucket so
   existing renders keep working. (Bucket → Management → Replication.)
3. **Update Modal secret `promptly-secrets`**: set `AWS_REGION=us-west-2`
   and `S3_BUCKET_NAME=your-new-bucket-name`.
4. **Update Render secret**: same two values on the server side so new
   uploads land in the new bucket.
5. **Redeploy Modal** once secrets are updated so containers pick them up.

After this: Modal → S3 is same-region AWS backbone, ~900 Mb/s realistic.
A 60MB file becomes sub-second even with stock boto3.

### Optional but cheap: keep a Modal container warm

Add `min_containers=1` to the `@app.cls(...)` decorator in `modal_app.py`:

```python
@app.cls(
    ...,
    scaledown_window=120,
    min_containers=1,  # keep one container always warm
    ...
)
```

This costs ~$40/month for an always-on H100 but eliminates ALL cold-start
latency. If you're on a Pro Modal plan, probably worth it.

---

## Measurement

After redeploy, pull these log lines from Modal for one fresh job and one
prewarmed job:

```
[pipeline] download complete: 47.3MB in 2.1s (s3-crt, 22.5 MB/s)
[pipeline] download complete: 47.3MB in 0.1s (prewarm-cache, 473.0 MB/s)
[pipeline] transcript ready from URL-based Deepgram (340 words)
```

- `s3-crt` means the tuned boto3 path — healthy numbers: >15 MB/s same
  region, >8 MB/s cross-region.
- `prewarm-cache` means the volume hit — should always be sub-second.
- `URL-based Deepgram` means the transcript arrived via the early pool.
  If this line is missing, the URL path failed and we fell back to file-based.

---

## Rollback

Every change is gated by a feature flag or graceful fallback:

- If `boto3[crt]` fails to install (image build), the image rebuild errors;
  redeploy the previous git commit.
- If URL-based Deepgram fails, we fall back to file-based automatically
  (logged `[deepgram] URL-based transcription failed` + `will fall back`).
- If the prewarm Volume mount fails, `os.path.exists` returns False and we
  fall back to direct S3 download. Zero regression.
- If the `/api/prewarm` route errors, iOS just logs and continues — the
  render flow is unaffected.
