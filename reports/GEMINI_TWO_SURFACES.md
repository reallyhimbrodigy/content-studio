# The two-uploads hypothesis — CONFIRMED, in a sharper form: two BILLING SURFACES, one video

**JUDGE, 2026-08-22. Tested from code before building any counter, because the
answer changes what the counter has to measure.**

## The literal hypothesis is refuted; the meaningful one is confirmed

**Not two uploads.** Inside the worker, `_ensure_proxy_reference` is already
LEVER 4 ("upload once, reference everywhere", Zac 2026-07-10): **one https
reference per job**, read by the editorial call *and* every repair re-ask
instead of re-sending bytes. That optimisation is real and it holds.

**But the same source video is TOKENIZED TWICE, on two different Google
products, against two different credentials:**

| | content-studio | worker |
|---|---|---|
| file | `lib/video-processor/analyze-video.js` | `handler.py` |
| endpoint | **`generativelanguage.googleapis.com`** (Gemini API) | **`vertexai`** (Vertex AI) |
| credential | **`GOOGLE_AI_API_KEY`** | **`gemini-vertex`** service account |
| transport | resumable **Files API upload** of the video | https reference to a **480p@16–18fps proxy** |
| model | `gemini-2.5-flash` | editorial call |
| cadence | **per job** (`pre-analyze` → `process-job`) | per job, editorial |

**Video tokens are billed per `generateContent` call that references the file,
not per upload.** So one source video, analysed twice, bills twice — once as a
full-resolution Files API object on the Gemini API, once as a 480p proxy on
Vertex.

## The consequence that matters most: the cost board has ONE Gemini line and there are TWO bills

`GOOGLE_AI_API_KEY` and the `gemini-vertex` service account are **separate
billing surfaces on separate Google products.** The owner-reported "~$1,000/mo
Gemini" is therefore one of:

1. the Gemini API bill only (content-studio — full-res, per job, Flash),
2. the Vertex bill only (worker editorial — 480p proxy), or
3. both summed.

**Which one it is changes every conclusion downstream**, including whether the
Flash A/B has any prize at all — content-studio is already on Flash, so if (1)
is the bill, the A/B's target is not where the money is. **This is a one-line
question against the Google Cloud console, and it is now the top Gemini item —
ahead of building counters, because the counters should be built on whichever
surface actually bills.**

## What the counter must measure, revised

Instrumenting `analyze-video.js` alone would have measured **one of two
surfaces** and reported it as the total — the same shape as attributing the
PostHog bill across `analytics_events` when 30% of those rows never reach
PostHog. The counter must therefore emit, per job:

- `prompt` / `cached` / `output` token counts **tagged by surface**
  (`gemini_api` vs `vertex`), and
- the **video seconds tokenized** on each surface, since a full-res upload and a
  480p@16fps proxy do not cost the same per second of source.

Only then is `$/job` for Gemini a real number rather than a share of an
unattributed total.

## The cheapest lever this exposes, stated but NOT ranked

If both analyses genuinely need to happen, they are analysing **the same video
twice at different fidelities.** Whether the content-studio pre-analysis can
read the worker's proxy reference — or whether the worker's editorial call can
consume the pre-analysis output instead of re-tokenizing — is a **design
question I cannot settle from measurement**, and I am not ranking a lever whose
size I have not measured. **It is named here so it is not lost, with its size
explicitly UNKNOWN.**

## Standing correction carried forward

Yesterday this board said six Gemini callers on Pro-tier including a daily
`bleed-meter`. **Four callers; bleed-meter makes zero Gemini calls; the trend
cron is weekly; the production path is already Flash.** Corrected on the board
at `4cb0577` and repeated here so the two files cannot disagree.
