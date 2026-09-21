# Video history rot — 1,959 renders already unreachable, ~90/day joining them

> **AMENDED 2026-09-19 — this document is INCOMPLETE as written. Frontend
> (content-studio-44) closed its open question and found two things it misses;
> read those before acting on the fix shape below.**
>
> 1. **The objects ARE present — I checked the wrong bucket.** The origin is
>    `thisismybucketagainwooo` (us-west-2), not `promptly-video-storage`. I
>    listed the account's two buckets, HEADed only one, got 404s, and wrote the
>    limitation up instead of trying the other name. Frontend's HEAD found both
>    sample objects present with correct size and content-type. **The inference
>    below is now a fact: nothing is deleted, only the credential aged out.**
> 2. **The rot is also in `chats.messages`, and that is the surface users see.**
>    2,600 messages across 1,771 users carry a signed `renderedVideoUrl`; 1,951
>    are already dead. The client renders video from the chat bubble, not from
>    `video_jobs`. **The fix shape below covers only the jobs table — migrating
>    just that leaves 1,951 dead links in the bubbles**, including 28 renders
>    Frontend repaired by hand last week, which are rotting on the same clock.
> 3. **The reason to migrate the 6,222 unsigned rows is stronger than the one
>    given below.** They are not merely "unpromised" — they ARE the defect
>    signing was introduced to fix: 6,200 permanent public links, and "a grant
>    expires; a link does not" (`lib/completion-reconcile.js`). So the old
>    behaviour is not available as a fallback; the durable-looking rows are the
>    open hole. `DEFAULT_TTL_S = 7 days` in `lib/deliverable-url.js` is the
>    SigV4 maximum, which is exactly the cliff measured here.
> 4. **Sequencing:** the API must sign-on-read BEFORE the columns become keys.
>    Shipped clients read the field directly and build 246 is still ~880 of
>    ~1,000 active users, so columns-first would break every old build the
>    moment the data changes.


**For: Frontend. Read-only investigation, 2026-09-19. Nothing was written.**

## The number

**1,959 of 2,617 signed renders (74.9%) are already unreachable**, affecting
**1,329 of 6,792 users (19.6%)**. About **90 more cross the line every day** —
one day's completions, arriving 7 days late.

## What actually happened, and it is not what it looks like

`rendered_video_url` stores a **CloudFront signed URL with a 7-day TTL**
(`Expires` / `Key-Pair-Id` / `Signature`). When the signature expires the row
still holds a URL, the UI still renders a link, and the link 403s.

**The rot was INTRODUCED on 2026-08-23.** Before that date the column held
UNSIGNED CloudFront URLs, and those still work today:

| stored form | rows | first seen | state |
|---|---|---|---|
| CloudFront, **unsigned** | 6,214 | 2026-06-25 | **still serve — HTTP 206 on a June row today** |
| CloudFront, **signed, 7-day** | 2,592 | **2026-08-23** | 1,959 expired, 633 live |
| S3 direct, signed | 27 | 2026-08-23 | expired |

So history was durable for the first two months and became perishable on a
single day. Every render since 08-23 has a 7-day shelf life.

## The cliff, by completion day

```
2026-09-10   101 jobs   101 expired  100%
2026-09-11   111 jobs   111 expired  100%
2026-09-12   112 jobs    20 expired   18%   <- the line, mid-day
2026-09-13   132 jobs     0 expired    0%
2026-09-14+                0 expired    0%
```
Exactly 7 days wide. The oldest still-live URL expires **2026-09-19T07:16:37Z**
(job completed 09-12) — by the time you read this it is likely gone too.

## THE OBJECTS ARE NOT LOST. Only the signature is.

This decides recovery vs schema change, so it was tested rather than assumed:

- a **still-live** signed URL serves **HTTP 206**;
- an **expired** signed URL returns **403**, and so does the same path with the
  query stripped — CloudFront rejects both;
- an **unsigned URL from 2026-06-25 serves HTTP 206 today**, from the same
  distribution and the same `renders-private/` prefix.

Nothing is being deleted. A URL that never had a signature still works after
three months, so the storage is intact and only the credential on the link has
aged out.

**One honest limit on that claim:** a direct `HEAD` could not confirm the object
from here. `renders-private/` has **0 objects** in `promptly-video-storage`, and
even a LIVE row's key 404s there — the distribution's origin is not visible to
these credentials. And CloudFront returns 403 for an expired signature whether
or not the object exists, so the 403 alone proves nothing. The June-row evidence
is what carries the conclusion. **If you can HEAD the real origin, do that
before committing to the fix** — it is one call and it converts a strong
inference into a fact.

## The fix shape

1. **`rendered_video_url` and `thumbnail_url` become KEYS, not URLs.** Store
   `renders-private/<job>/<file>.mp4`. A key does not expire.
2. **The jobs API signs on read, with a SHORT TTL** — minutes, not days. A
   signature minted when the user asks is always fresh, and a short TTL is
   safer than the current long one rather than riskier.
3. **The client reads through the API and never caches a signed URL.** Caching
   the signature is what re-creates this bug at a shorter interval; cache the
   key, ask for a signature when playing.

Migration for the 2,592 existing signed rows is a string operation — the key is
the URL's pathname, already present in every row. **The 6,214 unsigned rows
should be migrated to keys too**, not left alone: they work today by virtue of
the distribution serving unsigned reads on that prefix, which is a property
nobody has promised and a future CloudFront policy change would silently end.

## How to re-run this

```
SELECT id, completed_at, rendered_video_url
  FROM video_jobs WHERE status = 'completed';
-- parse the `Expires` query param (UNIX seconds) from the URL.
-- expired  := Expires < now()
-- NOTE: the parameter is `Expires`, NOT `X-Amz-Expires`. These are CloudFront
-- signatures, not S3 presigns. A first pass keyed on X-Amz- matched 2 rows of
-- 8,833 and concluded there was no problem.
```
