# Export monetization — the client half (one-pager for the owner's final iOS build)

**Filed 2026-08-11 by Lane 4 (DELIVERY). The server half is BUILT and DARK.**

## What the server now has (all inert until flags flip)

- `POST /api/export` and the alias `POST /api/jobs/:id/export` — one gate:
  server-side entitlement (`assertProEntitled`, never a client flag), 1 free
  export then 402 (`FREE_EXPORT_LIMIT`), private clean master minted as a
  300s signed URL. Dark behind `EXPORT_GATE_ENABLED=1`.
- **Watermark-at-export v1** (dark behind `EXPORT_WATERMARK_ENABLED=1`): the
  free-quota export ships with the brand watermark (bottom-right, 22% width,
  60% opacity — the repo's existing `watermark.png`); Pro ships clean. Local
  ffmpeg pass on the Render container, cached at
  `exports/{job_id}/watermarked.mp4`, idempotent. Proven in-container at every
  build by `lib/__smoke_export_watermark.js` (decodable, duration-preserving,
  corner-pixels-changed). Response carries `watermarked: true|false`.
- `gate_probe: true` dry-run returns the entitlement decision (free→402,
  pro→200) independent of the flags — deploy-sanity can prove both directions.

## Why the server alone CANNOT gate exports — the load-bearing fact

**The shipped client falls back to the public save on ANY export failure.**
A 402, a 404, a timeout — the user still gets the un-watermarked public
rendered file via the OS share/save path the app has always used. The server
can decide whatever it wants; the shipped client routes around it. So flipping
`EXPORT_GATE_ENABLED=1` today would change NOTHING for existing installs —
no wall, no watermark, no revenue. **The wall becomes real only when the
client stops falling back.**

## What the owner's final iOS build must do

1. **Call the gate**: `POST /api/jobs/{id}/export` (or `/api/export` with
   `{job_id}`) with the Supabase auth token, and save the returned signed URL's
   file. Treat `watermarked` in the response as display metadata if desired.
2. **Kill the public-save fallback for gated jobs**: on 402 → show the
   upgrade paywall (the response carries `free_exports_used` /
   `free_export_limit`). On 404 `no_private_asset` → THIS is the only case
   where the legacy public save is correct (old jobs with no private master).
   On network error → retry UI, not silent public save.
3. **Stop embedding/deriving the public URL for the save path** on jobs that
   have a private asset — the public URL remains for in-app playback only
   (or moves private in a later phase; that's ERRORS' asset-privacy track).

## Flip order (each its own deploy, verified)

1. Server code deploys dark (this branch). Nothing changes.
2. Owner ships the iOS build with §1–3. Nothing changes (server still 501s).
3. `EXPORT_GATE_ENABLED=1` → the wall arms for new-build users only;
   old builds keep the fallback until they upgrade (known, accepted decay).
4. `EXPORT_WATERMARK_ENABLED=1` → free-quota exports watermark.
   (Policy variant deliberately NOT built: watermark-instead-of-402 beyond
   quota — a taste call for Zac; one env value away if wanted.)

## Verification lines

- `gate_probe` both directions on every deploy (already in deploy-sanity's reach).
- `analytics_events.export_watermark_failed` must stay at 0 — any row is a
  defect (the free export silently shipped clean).
- Usage counter rows (`feature=export`) vs 402s on the scoreboard once armed.
