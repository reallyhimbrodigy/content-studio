# Progressive playback — cross-repo field contract

The authoritative contract between **content-studio** (iOS client + Node server) and
**promptly-gpu-worker** (Modal render worker) for the §5 progressive preview→final
swap. Written 2026-07-26 after a type mismatch (`preview` column) silently broke the
whole feature — the next cross-repo field starts here, not from a two-sided guess.

## The chain, seam by seam

| # | From → To | Field | Shape | When |
|---|---|---|---|---|
| a | 219 client → server | `supports_progressive` in `POST /api/video-jobs` body | `bool` (`true`; omitted for demos) | every real dispatch from a 1.3.3+ build |
| b | server → worker | `supports_progressive` in the Modal dispatch payload (a sibling of `premium_pipeline_enabled`, so it lands under the worker's `input`) | `bool` | dispatch, **AND-gated by the server kill switch** |
| c | worker gate | reads `input_data.get("supports_progressive")` in `_progressive_enabled()` | — | publishes a preview iff true AND worker kill switch not off |
| d | worker → DB | `video_jobs.preview` **(JSONB)** = `{preview_hls_url, segments_published, plan_summary, first_frame_url}`, and in the SAME update `video_jobs.hls_manifest_url` = `preview_hls_url` | JSONB + text | once ≥1 chunk group is playable, `final`/`superseded` false, status non-terminal (terminal fence) |
| e | server → client | relays `hls_manifest_url` as **`hlsManifestUrl`** (camelCase) in SSE progress/complete events, the SSE connect snapshot, and `GET /api/video-jobs/:id` | `string?` | on any progress event carrying it (mid-render) |
| f | client reads | `SSEEvent.hlsManifestUrl` → `ChatMessage.hlsManifestUrl` → inline preview player; swaps to `renderedVideoUrl` (final MP4) at completion | `String?` | mid-render (preview) → completion (final overwrites) |

## Kill switches (ALL must be permissive for a preview to appear)

| Switch | Where | Effect |
|---|---|---|
| `PROGRESSIVE_PLAYBACK_ENABLED` | Render (server) | gates client **consumption** (emitted in `/api/usage` as `progressive_playback_enabled`) AND the server's **forwarding** of `supports_progressive`. Accepts `1`/`true`/`yes`/`on`. |
| `PROMPTLY_PROGRESSIVE` | Modal (worker) | worker kill switch: `0/false/no/off` forces OFF for everyone; otherwise the per-job `supports_progressive` decides. |
| `PROMPTLY_PREVIEW_PERSIST` | Modal (worker) | `0` disables the `_persist_preview` write entirely. |

## Invariants (the safety fences)
- **Preview URLs are distinguishable**: a preview manifest contains `-preview-hls`; the
  final ladder does not. Any consumer treating a manifest as "final" must reject
  `-preview-hls` URLs. (See the preview-safety audit — every content-studio consumer is
  clear; the completion push carries no manifest.)
- **The final overwrites**: the worker's terminal write sets `hls_manifest_url` to the
  final ladder; `_persist_preview`'s terminal fence stops a preview write from landing
  after completion. The client also swaps to `renderedVideoUrl` at completion.
- **`preview` column is JSONB, worker-written.** content-studio's server never writes
  it. (The 2026-07-26 outage was this column created as BOOLEAN → worker write threw →
  `hls_manifest_url` never set → no preview.)

## Observability (worker v369)
Every job logs the gate decision — `[progressive] GATE job=<id> supports_progressive=<v>
-> enabled=<b>` — and records a queryable `progressive` / `progressive_gate` divergence.
Use it to pin the seam on a real job without a client trace: `enabled=false` with
`supports_progressive=true` means a worker kill switch is off; `supports_progressive`
absent means it never reached `input_data` (seam b). NB: `video_jobs.preview` defaulting
`false`/null is NOT evidence of a non-publish — it was a boolean-default artifact before
the JSONB correction.

## Consolidation (2026-07-26)
This is the **single canonical** contract, agreed by both sides. The worker repo's old
`PROGRESSIVE_CLIENT_CONTRACT.md` is now a pointer here — edit only this file, so the two
can't drift (the drift this doc exists to prevent).

## How to verify end-to-end (one job)
1. `video_jobs.preview` populates with the JSONB payload → seams a–d OK.
2. `hls_manifest_url` briefly holds a `*-preview-hls` URL mid-render → seam d OK.
3. Client shows the "LIVE PREVIEW" inline player, then swaps → seams e–f OK.
**Worker gate observability (promptly-gpu-worker v369+):** every job logs
`[progressive] GATE job=<id> supports_progressive=<value> -> enabled=<bool>` and records a
`progressive`/`progressive_gate` divergence (queryable in the S3 divergence ledger). This proves
seams (b)→(c) on a SINGLE job id: `supports_progressive=false/None` → the break is upstream
(client send or the server kill switch), not the worker; `supports_progressive=true, enabled=true`
with `preview` still empty → single-chunk render (publisher inert) or a `progressive_publish_fallback`.

If (1) is empty: the worker never published — check `supports_progressive` reached
`input_data` (seam b) and both worker kill switches. If (1) is populated but (3) never
shows: check `progressive_playback_enabled` in the device's `/api/usage` snapshot.
