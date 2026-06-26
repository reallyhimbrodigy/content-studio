# Creator Submission Portal — Design Spec

Date: 2026-06-26
Status: Approved (design); building.

## Goal
A professional way for contracted UGC creators to submit videos (single or
batch) for review before posting, and a private dashboard for the owner to
review and track them. On usepromptly.app, reusing existing infra (S3 +
CloudFront, Supabase, server.js routing, Supabase auth).

## Decisions (from brainstorm)
- **Review mechanism:** private dashboard on the site. No email alerts (no email
  provider wired up; out of scope).
- **Submission access:** open link, no gate. Mitigate abuse server-side
  (rate limit, content-type/size validation, server-derived S3 keys).
- **Tracking:** per-submission `status` (new / approved / needs_changes) + a
  private `review_notes` field for the owner.
- **Paths:** submission form at `/submit`, review dashboard at `/review`.
- **Admin gate:** env allowlist `SUBMISSION_ADMIN_EMAILS` (comma-separated).
  Enforced SERVER-SIDE on admin endpoints. **Fails closed** — if the env var is
  unset the allowlist is empty and all admin requests get 403 (no hardcoded
  default email). Owner must set it on the server to unlock /review.

## Form fields (/submit)
- **Name** — required (non-empty after trim).
- **Email** — optional (basic format check only if provided).
- **Video file(s)** — required, ≥1, `accept="video/*"`, single or batch.
- **Notes** — optional textarea, placeholder exactly: `Anything you want feedback on?`

## Data model — `creator_submissions` (Supabase Postgres, new migration)
```
id           uuid pk default gen_random_uuid()
created_at   timestamptz not null default now()
creator_name text not null
creator_email text
notes        text
videos       jsonb not null default '[]'   -- [{ url, key, filename, size, content_type }]
status       text not null default 'new' check (status in ('new','approved','needs_changes'))
review_notes text
```
- RLS enabled, **no client policies** — service role only (server endpoints are
  the sole gateway). Mirrors the `usage_events` pattern.
- Index on `created_at desc`.

## Endpoints (server.js, additive, mirror the existing `if (pathname...) { (async()=>{})() }` pattern)
1. `POST /api/submissions/upload-url` — PUBLIC, rate-limited.
   - Body: `{ fileName, contentType, size }`.
   - Validate: `contentType` starts with `video/`; `size` ≤ cap (1 GB); sanitize
     fileName (`[^a-zA-Z0-9._-] -> _`).
   - Key: `submissions/${Date.now()}-${randomUUID()}-${safeName}` (always under
     `submissions/` — never client-controlled prefix).
   - Returns `{ uploadUrl, publicUrl, key }` via `services/s3` createPresignedPutUrl/getPublicUrl.
2. `POST /api/submissions` — PUBLIC, rate-limited.
   - Body: `{ creator_name (req), creator_email?, notes?, videos: [{ key, filename, size, content_type }] (req, ≥1, ≤25) }`.
   - Validate: name non-empty (len cap ~200); email format if present; notes len
     cap (~5000); each `video.key` MUST start with `submissions/` (rejects forged
     keys). **Server derives the stored `url` from `s3.getPublicUrl(key)`** — never
     trusts a client-sent URL (prevents URL injection).
   - Insert row (status `new`). Returns `{ ok: true, id }`.
3. `GET /api/admin/submissions` — ADMIN only (`requireSupabaseUser` + email in
   `SUBMISSION_ADMIN_EMAILS`). Returns all rows, newest first.
4. `PATCH /api/admin/submissions/:id` — ADMIN only. Body `{ status?, review_notes? }`.
   Validate status enum. Updates row, returns it. (`:id` parsed from pathname.)

- **Admin helper:** `isSubmissionAdmin(email)` — pure, unit-tested, checks the
  comma-separated env allowlist (case-insensitive, trimmed).
- **Rate limiting:** reuse the existing server rate-limit utility (the one behind
  the 10-jobs/15-min cap) keyed per-IP for the two public endpoints.

## Pages (static HTML in repo root, served by the existing clean-URL handler)
- `submit.html` (`/submit`): brand-matched form. Client validates name + ≥1 file,
  then per file: POST upload-url → PUT to S3 with XHR progress → collect
  `{key, filename, size, content_type}` → POST /api/submissions. Per-file
  progress, graceful per-file error/retry, success state ("Thanks, <Name> — your
  video(s) are in for review."). No auth.
- `review.html` (`/review`): owner dashboard. Uses the site's existing Supabase
  session token (same storage the web app uses) as Bearer. On 401/403 → prompt to
  sign in / link to /auth. Renders newest-first cards: `<video controls>` per
  video (CloudFront URL), name, email (mailto), date, their notes, a status
  `<select>`, and a private review-notes `<textarea>` that autosaves (debounced
  PATCH). Optional status filter.

## Security / abuse (open link)
- Public endpoints rate-limited per IP; `video/*` + size cap enforced; S3 keys
  built server-side and prefix-validated on submit; stored URL derived from key.
- Admin data reachable ONLY through admin-gated endpoints (server-enforced) — the
  /review page is just a client; no data without the admin token.
- Submission video URLs are public-but-unguessable (uuid in key), same model as
  rendered videos. Acceptable.

## Testing
- `tests/submissions.test.js` (node --test): `isSubmissionAdmin` allowlist,
  video key-prefix validation, required-field + status-enum validation.
- `node --check server.js`; manual smoke of /submit upload + /review.

## Out of scope (YAGNI / per decisions)
Email alerts, creator accounts, in-system feedback delivery to creators,
per-creator links, CAPTCHA.
