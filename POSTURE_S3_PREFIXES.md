# S3 PREFIX POSTURE — an explicit decision, not an inheritance

Written 2026-08-23 by BUILDER. Every status below was **measured** against the
live distribution on that date, not read from configuration.

The occasion: `exports/` was found world-readable on 2026-08-22 and closed, and
`chat-media/` shipped world-readable on 2026-08-23 and is still open. Both were
the same mistake — assuming privacy is a property of the KEY when it is a
property of the CloudFront BEHAVIOUR. Every other prefix inherited its posture
by default. This document exists so that stops being true.

---

## 1. What is actually true today

| prefix | CDN, unauthenticated | S3 direct | contents |
|---|---|---|---|
| `exports/` | **403 restricted** | 403 | clean master (paywalled) |
| `sources/` | **206 PUBLIC** | 403 | **the user's raw original video** |
| `renders/` | **206 PUBLIC** | 403 | the finished edit |
| `thumbnails/` | **206 PUBLIC** | 403 | poster frame |
| `chat-media/` | **200 PUBLIC** | 403 | chat images (new today) |

**The CDN is the only door.** S3 direct is 403 on every prefix, so the entire
posture is decided by CloudFront behaviours, in one place.

**Scale of the currently-public set:**

```
9,306  source videos (raw user uploads)
6,204  renders
2,670  thumbnails
  577  DISTINCT USERS
```

**Not enumerable, but permanently readable.** A key is
`sources/{user_id}/{ms}-{ios-asset-uuid}.mov` — guessing one requires the user
id, a millisecond timestamp and a device asset UUID. So this is not a scrape
risk. It is a *durability* risk: any URL that ever leaks works forever, and
there is no expiry, no revocation and no audit.

---

## 2. The asymmetry that makes this worth deciding

`sources/` is the most sensitive prefix we have and the only one with **no
product reason to be public**.

- A render is something the user asked us to make and often intends to share.
- A source is raw camera-roll footage they uploaded to be edited. It contains
  everything they *didn't* choose to publish — the takes, the pre-roll, the
  background, whoever else was in the room.

It is public today purely because it was never decided.

---

## 3. What restricting each one costs

### `sources/` → RESTRICT (recommended)

**Blocker, real:** `video_jobs.video_url` holds the **public** CDN URL and the
worker fetches exactly that string to download the source. Restricting the
prefix without changing dispatch **breaks every render**.

**Fix:** mint a presigned GET at dispatch instead of storing a public URL.
`createPresignedGetUrl` already exists and SigV4 allows 7 days, which covers any
realistic queue depth. Re-mint on respawn/retry — the respawn path already
re-reads the row, so this is a small, contained change.

**Cost:** one dispatch change + a re-mint on the respawn path.
**Buys:** 9,306 raw user videos across 577 users stop being permanently
fetchable.

### `chat-media/` → RESTRICT (already agreed; check is RED)

No consumer needs it public — `/api/chat/media-resolve` mints per read. Pure
fix. Blocked only on the key pair id, because restricting while signing is
broken would 403 every chat image.

### `renders/` → DECIDE

Two consumers, and neither actually requires a *permanent* public URL:

1. **The public share page** (`renderResultPage`) embeds the URL in HTML. It is
   **server-rendered per request**, so it can mint a short-TTL URL at page-load
   time and the share link (`/v/{jobId}`) keeps working forever. The opaque
   thing we hand out stays the job id, not the asset.
2. **iOS**, which stores `rendered_video_url` — and already has
   `/api/video-jobs/:id/refresh-urls`, built for precisely this ("client calls
   this when AVPlayer hits a 403/expired error"). Already equipped.

**Recommendation: restrict.** The viral path is preserved by the share page
minting on each load; what we lose is the permanent hotlink, which was never
the product.

### `thumbnails/` → DECIDE, and this one has a genuine cost

Poster frames feed `og:image` on the share page. **Social crawlers cache OG
images and re-fetch them later**, so a short-TTL URL means link previews break
after expiry — in iMessage, Slack and X. That is a real, user-visible cost paid
for a low-sensitivity asset.

**Recommendation: keep public**, with the inconsistency named honestly: a
thumbnail is a frame of the video, so a public thumbnail leaks one frame of an
otherwise-private render. If that is unacceptable, the alternative is a
separate, deliberately-public "share card" image rather than the real poster
frame — more work, and it should be a decision rather than a side effect.

---

## 4. Recommended posture

| prefix | posture | why |
|---|---|---|
| `exports/` | restricted | done |
| `chat-media/` | restricted | no public consumer; blocked on the key pair id |
| `sources/` | **restricted** | raw user footage; no product reason to be public |
| `renders/` | **restricted** | share page mints per load; iOS already re-resolves |
| `thumbnails/` | **public** | OG crawler caching; least sensitive; named exception |

---

## 5. Sequence, because the order matters

1. **Fix `CLOUDFRONT_KEY_PAIR_ID`** — it currently holds the public key PEM, so
   signed URLs 403. Nothing below can land until signing works.
2. `chat-media/*` behaviour → the RED deploy-sanity check goes green.
3. Dispatch mints a presigned source URL → **then** restrict `sources/*`.
   In that order: restricting first breaks every render in flight.
4. Share page mints per load → **then** restrict `renders/*`.
5. `thumbnails/` left public by decision, recorded here.

Each step is independently reversible and each has a check that fails if it
regresses.
