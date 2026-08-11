# IOS_FINAL_BUILD — every client item, one spec, one build

**Consolidated 2026-08-12 (Lane 4, on Zac's directive: the owner ships exactly
one build).** Sources folded in: SEAM's `IOS_HANDOFF_CHAT_ACTIONS.md`,
DELIVERY's `reports/EXPORT_CLIENT_HALF.md`, the true-pause filing, JUDGE's
identity finding, the paywall-order question. Each item says what changes,
where, and which SERVER FLIP waits on it. **Not in this build:** multi-clip
adapter #2 — server-side, continues as its own build item in the SEAM lane.

---

## 1. Chat router unification (SEAM's one-router change)

`EditorView.swift:2443` — `send()` currently decides chat-XOR-render
client-side. Replace with one server call; the server decides converse-vs-act:

```
POST /api/chat/actions        (same bearer as /api/chat)
{ "message": <text>, "video_url": <presigned, if attached>, "proxy_video_url": <if exists> }
```

Handle by `action`: `converse` → fall through to `/api/chat/stream` exactly as
today · `status`/`clarify` → render `message` as an assistant message ·
`render_dispatched`/`reedit_dispatched` → assistant echo + the SAME render card
the composer path shows for `job_id` · 402/429/503 → the composer path's
existing refusal handling verbatim · **404 → today's client-side router (the
dark-flag fallback — keep it compiled in).**

Do NOT: parse intent client-side, touch `/api/chat/stream` consumption/metering,
or change the explicit re-edit screen. Full table: `IOS_HANDOFF_CHAT_ACTIONS.md`.

**Unblocks server flip:** `PROMPTLY_CHAT_ACTIONS` (TRUTH flips only after this
ships — SEAM_FLIP_PACKAGE order).

## 2. The UI trio (owner-named, from SEAM's page)

1. **Full-width assistant text** — assistant messages are full-width text
   blocks, not bubbles (`MessageBubble.swift:77-87`; bubbles stay for the USER
   side only).
2. **Caret** — blinking caret at the end of in-flight assistant text (the
   typewriter already paces the reveal; add the glyph while streaming).
3. **Stop button** — visible while a reply streams; cancels `activeChatTask`,
   keeps partial text (long-press retry already exists; this is the affordance).

## 3. Export gate — the client half (DELIVERY's three requirements)

The server half is live-deployable dark (`/api/export` + alias
`/api/jobs/:id/export`; watermark v1 in-container-proven). **The load-bearing
fact: the shipped client falls back to PUBLIC SAVE on any export failure, so
the wall is inert until this build.**

1. **Call the gate**: `POST /api/jobs/{id}/export` with the Supabase bearer;
   save the file at the returned 300s signed URL. Response carries
   `watermarked: true|false` (display metadata).
2. **Kill the public-save fallback for gated jobs**: 402 → upgrade paywall
   (response has `free_exports_used`/`free_export_limit`) · 404
   `no_private_asset` → the ONLY case where legacy public save is correct
   (old jobs) · network error → retry UI, never a silent public save.
3. **Stop deriving the public URL for the save path** on jobs with a private
   asset — public URL remains for in-app playback only.

**Unblocks server flips:** `EXPORT_GATE_ENABLED=1`, then
`EXPORT_WATERMARK_ENABLED=1` (each its own deploy + watch; full order in
`reports/EXPORT_CLIENT_HALF.md`).

## 4. Stop calling warmup on editor-open

Remove `warmupRenderContainer()` at **editor-open and composer-focus** (and at
dispatch unless trivially kept — the server neutered it either way). Evidence:
the funnel A/B proved dispatch-latency warmup does not convert
[CODE modal_app.py warmup: `neutered_for_cost_ab`], the server `/api/prewarm`
is frozen, and every call still spins a Modal dispatcher container for
~scaledown_window — pure dark-period burn from the ~63% of editor-opens that
never render. No UX change: renders already start cold-tolerant.

**Unblocks:** nothing server-side — this is pure spend hygiene; the true-pause
"after" number (owner dashboard protocol in `LANE4_STUCKJOBS_AND_PAUSE.md`)
gets its cleanest read once these calls stop.

## 5. Post-cancel identity split (JUDGE's finding)

The identity contract is `Analytics.identify(userId:)` at auth resolve and
`reset()` on sign-out [CODE docs/analytics/freemium-funnels.md §Identity].
JUDGE observed one human splitting into two analytics identities around a
CANCEL flow — a `reset()` (or a never-re-identify) firing on a flow
cancellation that is not a true sign-out, so the device continues on a fresh
anonymous id and every later event orphans from the person's history (this is
the "ghosts" class that already polluted activation counts once).

Client rule to enforce: **`reset()` fires ONLY on explicit account sign-out.**
Cancelling Sign-in-with-Apple mid-onboarding, cancelling a purchase sheet, or
backing out of any flow must never reset or re-anon; on return, re-`identify`
with the same Supabase id. [The precise repro lives with JUDGE — confirm the
exact call site with them before changing; the rule above is the invariant
whatever the site turns out to be.]

## 6. Paywall order — only if it is hardcoded

`TrialWallView` / `PaywallView` are custom views; if the package/plan display
order is hardcoded in them, move the order to a server- or RC-driven source
(the RC offering's package sequence is the natural one — reorder in the RC
dashboard, no build). If the views already render the offering's order, this
item is a no-op — verify and say so. The INITIAL order is Zac's taste call at
ship time; the build item is only "order comes from config, not code."
Context for the call: every weekly subscriber to date cancelled inside week 1
[MEASURED 2026-08-10]; the one renewal we have is the one who never saw a
reason to cancel.

---

## Server flips gated on this build (TRUTH's queue, one at a time, post-ship)

| flip | waits on item |
|---|---|
| `PROMPTLY_CHAT_ACTIONS` | 1 (router) |
| `EXPORT_GATE_ENABLED=1` | 3 (fallback removal) |
| `EXPORT_WATERMARK_ENABLED=1` | 3, after the gate flip |

## Acceptance pass (one run through the app)

1. Send free text with no video → assistant converses (streamed, full-width,
   caret, stop works). With the flag dark: identical to today (404 fallback).
2. Attach a video, type an edit ask → render card appears in-chat.
3. Finish a render → Export: free account gets watermarked file + counter;
   second export → paywall; Pro → clean. Old job (no private asset) → legacy
   save still works.
4. Open the editor 5× without rendering → zero warmup calls on the wire.
5. Cancel Sign-in-with-Apple mid-flow, complete it after → PostHog shows ONE
   person, no new anon id.
6. Paywall order changes from the RC dashboard (or config) without a build —
   or the no-op is documented.
