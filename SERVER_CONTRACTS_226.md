# SERVER_CONTRACTS_226 — exact shapes for the two remaining 226 client items

**Written 2026-08-12. Every shape below is read from the code named beside it,
and every live status line is a `curl` run today — not a recollection.**

The two 226 items are the chat router (item 1) and the upload leg's substance
(item 7). Both are blocked only on knowing exactly what the server accepts and
returns. That is this document. Nothing here needs the owner.

Server: content-studio `206cbca` (live). Worker: `v528`.

---

# CONTRACT 1 — `POST /api/chat/actions`, the `act_render` verdict

## The confirmation asked for

**YES — `act_render` takes the same post-upload video reference `/api/video-jobs`
takes.** Not an equivalent one: the *same field*, forwarded verbatim.

`routes/chat-actions.js:102` reads it, `:152-156` forwards it:

```js
const videoUrl = String(body?.video_url || body?.videoUrl || '').trim();
...
const fwd = await selfForward(PORT, '/api/video-jobs', authHeader, {
  video_url: videoUrl,
  ...(proxyVideoUrl ? { proxy_video_url: proxyVideoUrl } : {}),
  vibe_input: verdict.vibe,
});
```

`/api/video-jobs` reads exactly the same two spellings [CODE server.js:4708, 4709, 4716]:

```js
const videoUrl      = String(body?.video_url  || body?.videoUrl  || '').trim();
const vibeInput     = String(body?.vibe_input || body?.vibeInput || '').trim();
const proxyVideoUrl = String(body?.proxy_video_url || body?.proxyVideoUrl || '').trim();
```

So a URL that works in the composer works in chat, byte for byte. The handler
holds **no parallel job-creation logic** — it self-forwards over loopback
(`127.0.0.1:PORT`) carrying the caller's own `Authorization` header, so auth,
the maintenance gate, rate limits, quota/entitlement and dispatch all hit
identically [CODE routes/chat-actions.js:12-19, 45-74].

## Request

```jsonc
POST /api/chat/actions
Authorization: Bearer <supabase JWT>          // same bearer as /api/chat
Content-Type: application/json

{
  "message": "make it punchy",                // required, trimmed
  "video_url": "https://…",                   // optional; presence is what makes it a render
  "proxy_video_url": "https://…"              // optional
}
```

- `videoUrl` / `proxyVideoUrl` camelCase are accepted identically [`:102-103`].
- `message` empty/whitespace → classified `converse` (trivial), never an error.
- **`video_url` presence is the entire render trigger**: `hasVideoAttached:
  Boolean(videoUrl)` [`:122`], and an attached video with a non-trivial message
  returns `act_render` unconditionally [CODE lib/chat-actions.js:79-81].

## Responses — the closed set

All are HTTP **200** with an `action` discriminator, except pass-throughs.

```jsonc
{ "action": "converse" }                          // client falls through to /api/chat/stream, unchanged

{ "action": "status",  "message": "<answer>" }    // deterministic, read from the job row

{ "action": "clarify", "message": "<question>" }  // NEVER silently acts, NEVER silently drops

{ "action": "render_dispatched",                  // the act_render success shape
  "job_id": "<uuid|null>",
  "message": "On it — your edit is rendering now. I'll post it here the moment it's done.",
  "job": { "success": true, "job_id": "<uuid>", "status": "queued" } }

{ "action": "reedit_dispatched",
  "job_id": "<uuid>",
  "message": "Got it — applying that change to your edit now. …",
  "job": { … } }
```

`job` is the **verbatim** `/api/video-jobs` body [CODE routes/chat-actions.js:166];
its success shape is `{success: true, job_id, status}` [CODE server.js:5081-5085].
`job_id` is lifted from `job_id || id || job.id` [`:158-159`].

### Failures pass through VERBATIM

A non-2xx from the forwarded leg is returned **with its original status and
body** [`:174`] — so the client renders a chat refusal exactly like a composer
refusal:

| status | body | meaning |
|---|---|---|
| 400 | `{"error":"invalid_video_url"}` | URL failed `isSafeRemoteMediaUrl` [server.js:4726] |
| 400 | `{"error":"invalid_proxy_url"}` | same, proxy |
| 402 | `{"error":"daily_limit_reached", …}` | quota |
| 429 | rate-limit body | job endpoint's own 10/15min budget |
| 503 | `{"error_code":"render_paused","user_message":…,"retryable":false}` | maintenance gate |

Route-level: **401** `{"error":"unauthorized"}` · **429** from the chat-scale
budget (30/15min, deliberately looser than job creation's 10/15min
[`:95-98`]) · **404** `{"error":"not_found"}` while the flag is dark.

## THE DEFERRED-UPLOAD CASE

There are **two different things** called "deferred upload" here, and they
resolve opposite ways. Getting them confused is the whole risk.

### (a) The URL exists but the BYTES have not landed — SUPPORTED, wait up to 600s

`/api/upload-url` and `/api/upload-multipart-init` both return the
`publicUrl`/`key` **before a single byte is uploaded**. You may send that URL to
`/api/chat/actions` (or `/api/video-jobs`) immediately.

Dispatch does a HEAD and, if the object is not there yet, **waits server-side**
with **no Modal container running** [CODE lib/video-processor/dispatch-to-modal.js,
the `waitForSource` block]:

| property | value | source |
|---|---|---|
| budget | **600_000 ms (600s)**, `SOURCE_WAIT_MS` overridable | `lib/source-presence.js:30` |
| poll | backoff starting at 500ms | `:143` |
| S3 cannot answer | `{present:true, unknown:true}` → **dispatches anyway (fail-open)** | `:148` |
| never arrives | terminal **without ever spawning Modal** | dispatch `else` branch |
| user-facing copy | *"The video didn't reach us — pick it again to start a fresh upload. You haven't been charged."* | `lib/failure-copy.js` `sourceMissingMessage()` |

The 600s budget is deliberate and documented as such: the wait moved off Modal,
so the only reason to shorten it (cost) is gone, and *"killing a slow-but-working
upload on a poor connection is strictly worse than a long wait."*

There is also a **dead-upload fast-fail**: if the CLIENT has already reported the
upload dead (a terminal in `UPLOAD_NEVER_STARTED` / `UPLOAD_STALLED` /
`UPLOAD_TIMEOUT` within the last 60s), the wait aborts early instead of burning
the full budget [`lib/source-presence.js:34`, and `jobId`/`since` are passed at
the call site]. It is consulted **only while the object is absent**, so a
slow-but-working upload is never cut short.

**So: send the URL as soon as you have it. Do not hold the request for the
bytes.** This is exactly the property item 7's resumable transfer needs.

### (b) NO URL yet at all — NOT supported, and there is a trap

`hasVideoAttached` is `Boolean(videoUrl)` at request time [`:122`]. A message
sent with **no** `video_url` is not an `act_render`, and falls through the
classifier's other branches [CODE lib/chat-actions.js:83-125]:

| message, no `video_url` | recent job | verdict |
|---|---|---|
| "make it punchy" (no imperative + component/prior-ref) | any | `converse` |
| "make the captions yellow" | completed, ≤48h | **`act_reedit` on the OLD job** ⚠️ |
| "make the captions yellow" | processing/queued | `clarify` — "still rendering…" |
| "make the captions yellow" | none/stale | `clarify` — "which video should I edit?" |

**The ⚠️ row is the trap.** An edit sentence sent before you have a URL can
re-edit the user's *previous* video instead of rendering the new one — and it
returns `reedit_dispatched`, so it looks like success, not an error.

**Client rule: never send an edit sentence without `video_url`.** You do not
need the bytes (see (a)) — you need the URL string, which you have the moment
`/api/upload-url` or `/api/upload-multipart-init` returns.

`REEDIT_WINDOW_MS = 48h` [CODE lib/chat-actions.js:44] is what makes the stale
job resolvable, and re-edit requires `status === 'completed'` [`:96`].

---

# CONTRACT 2 — the multipart pair (init / complete, + abort)

Live and auth-gated today; the client simply stopped calling it. [MEASURED
2026-08-12, since 08-06] `upload_url_requested` = **13,310 `single` vs 7
`multipart`**.

## `POST /api/upload-multipart-init`

```jsonc
Authorization: Bearer <supabase JWT>
{ "fileName": "clip.mp4",   // optional, default "video.mp4"
  "partCount": 12 }         // REQUIRED, integer
```

- `fileName` is sanitised server-side: `replace(/[^a-zA-Z0-9._-]/g, '_')`
  [CODE server.js:2859]. Never trusted as a path.
- `partCount` → `Math.max(1, Math.min(1000, parseInt(…, 10) || 0))`
  [`:2860-2861`]. **`0`/absent/NaN → HTTP 400** `{"error":"partCount is required (1-1000)"}`.
  **Server cap is 1000 parts** (S3's own limit is 10,000 — ours is lower).
- The key is **always server-generated**: `sources/{userId}/{Date.now()}-{fileName}`
  [`:2868`]. A client-supplied key is ignored.

**200 response** [`:2873`]:

```jsonc
{ "uploadId": "<s3 upload id>",
  "partUrls": ["https://…part1", "https://…part2", …],   // length === partCount, index 0 = PartNumber 1
  "key": "sources/<userId>/<ts>-clip.mp4",
  "publicUrl": "https://<cloudfront>/<key>" }
```

`partUrls[i]` is presigned for **`PartNumber = i + 1`** — the part number is
baked into the signature, so the array index is not a hint, it is binding
[CODE services/s3.js:194-206]. Part URLs expire in **3600s** [server.js:2869],
and the deploy gate pins that floor at ≥3600 [CODE lib/__smoke_multipart_intact.js].

Errors: **401** unauthorized · **400** partCount · **500**
`{"error":"Storage not configured"}` · wall/quota denial via `sendUploadDenial`
when the upload door is armed [`:2853-2856`].

## Uploading the parts — part size and ETag semantics

The server does **not** see the part bytes and does **not** enforce size; the
client PUTs each part straight to S3. Therefore **S3's rules are the contract**:

- **Every part except the last must be ≥ 5 MiB (5,242,880 bytes).** A short
  middle part is accepted at PUT time and fails only at *complete* — so a wrong
  chunk size surfaces as a confusing failure at the very end.
- The last part may be any size ≥ 1 byte.
- Max 5 GiB per part; our `partCount` cap of 1000 is the binding limit.
- **`UploadPart` is idempotent** — a single failed part can be re-PUT to the
  same presigned URL without restarting the upload [CODE services/s3.js:191-192].
  *This is the property item 7 exists to use.*

**ETag:** each successful part PUT returns an `ETag` **response header**
(a quoted string, e.g. `"9b2cf5…"`). Keep it with its part number. Send it back
**exactly as received, quotes included** — S3 compares it verbatim.

## `POST /api/upload-multipart-complete`

```jsonc
Authorization: Bearer <supabase JWT>
{ "key": "sources/<userId>/<ts>-clip.mp4",   // REQUIRED — from init
  "uploadId": "<s3 upload id>",              // REQUIRED — from init
  "parts": [                                 // REQUIRED, non-empty array
    { "PartNumber": 1, "ETag": "\"9b2cf5…\"" },
    { "PartNumber": 2, "ETag": "\"1a77de…\"" }
  ] }
```

- Field names are **PascalCase**: `PartNumber`, `ETag` [CODE services/s3.js:214].
- Any of key/uploadId/parts missing → **400**
  `{"error":"key, uploadId, and parts are required"}` [server.js:2893].
- **Order does not matter on the wire** — the server sorts ascending by
  `PartNumber` before calling S3 [CODE services/s3.js:218-219]. Send them
  sorted anyway; it costs nothing and matches S3's own requirement.

**200 response** [server.js:2898]:

```jsonc
{ "publicUrl": "https://<cloudfront>/<key>", "key": "sources/…" }
```

`publicUrl` is `CLOUDFRONT_DOMAIN`-based when configured, else
`https://<bucket>.s3.<region>.amazonaws.com/<key>` [CODE services/s3.js getPublicUrl].

**This `publicUrl` is the `video_url` for `/api/video-jobs` and for
`/api/chat/actions`** — the same value the single-PUT path returns, so the
downstream contract is unchanged.

Errors: **401** · **400** as above · **500** `{"error":"<message>"}` with the S3
error text (a short middle part surfaces here).

## `POST /api/upload-multipart-abort`

```jsonc
{ "key": "…", "uploadId": "…" }   →  200 { "ok": true }
```

400 `{"error":"key + uploadId required"}`. Safe no-op if already completed or
never initialised; it exists so abandoned parts stop billing [CODE
services/s3.js:233-247]. **Call it on give-up** — nothing else cleans them up.

## Single-PUT path, unchanged (for reference)

`POST /api/upload-url {fileName}` → `{uploadUrl, publicUrl, key}`. Its presign
TTL is **604800s (7 days)** [CODE server.js:2827], deliberately, and pinned by
the gate: it was raised 600 → 3600 → 7d to close an earlier
UPLOAD_NEVER_STARTED class where a background session resumed against an
expired URL. **Do not shorten it.**

---

# CONFIRMING LINE — the export alias

**`POST /api/jobs/:id/export` is LIVE (mounted and reachable) and DARK
(behaviourally inert).** [MEASURED 2026-08-12, live `206cbca`]

```
POST /api/jobs/00000000-0000-0000-0000-000000000000/export  ->  401
POST /api/export                                            ->  401
POST /api/chat/actions                                      ->  404   (flag dark)
POST /api/upload-multipart-init                             ->  401
```

401 (not 404) confirms the alias route exists and authenticates first; it hits
the *identical* entitlement + quota + private-asset logic as `/api/export`, the
only difference being where the job id comes from — path vs body [CODE
server.js:5674-5677, 5705]. After auth it returns **501**
`{"error":"export_not_enabled"}` until `EXPORT_GATE_ENABLED=1` [`:5699-5700`].

**One exception worth building against now:** the dry-run probe is evaluated
**before** the 501, so it answers while the gate is still dark [`:5694`]:

```jsonc
POST /api/jobs/<id>/export   { "gate_probe": true }
  → 200 { "allowed": true,  "tier": "paid", "reason": … }   // Pro
  → 402 { "allowed": false, "tier": "free", "reason": … }   // free
```

Use it to build and verify the paywall branch today, with no flip.

---

## Status of everything named here

| surface | live? | armed? |
|---|---|---|
| `/api/video-jobs` | ✅ | ✅ (the composer path) |
| `/api/chat/actions` | ✅ mounted | ❌ 404 until `PROMPTLY_CHAT_ACTIONS` — **flips at launch**, see LAUNCH_DAY §BUILD 225 |
| `/api/upload-multipart-*` | ✅ | ✅ — no flag, callable today |
| `/api/upload-url` | ✅ | ✅ |
| `/api/export` + `/api/jobs/:id/export` | ✅ mounted | ❌ 501 until `EXPORT_GATE_ENABLED=1` (`gate_probe` works now) |

The multipart pair needs **no flag and no flip** — item 7's substance can be
built and shipped against it whenever 226 starts.
