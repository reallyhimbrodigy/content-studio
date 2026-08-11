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

## 5. `rc_identify` retry — a swallowed logIn strands the purchase identity

> **Replaces the former item 5 (post-cancel identity split), WITHDRAWN
> 2026-08-11 on JUDGE's retraction of the two-identities finding.** Numbering is
> contiguous: this is item 5, paywall order stays item 6. Nothing else moved.

`SubscriptionService.identify(userId:)` aliases the anonymous install to the
Supabase user. On failure it does exactly one thing — `print` [CODE
ios/Promptly/Promptly/Services/SubscriptionService.swift:125-133]:

```swift
do {
    _ = try await Purchases.shared.logIn(userId)
    await refreshCustomerInfo()
} catch {
    print("[Subscription] logIn failed: \(error.localizedDescription)")   // <- ends here
}
```

One transient network blip at sign-in therefore leaves RevenueCat on
`$RCAnonymousID` **permanently** — nothing ever retries. The server already
knows this shape: it handles purchases arriving under `$RCAnonymousID`
"because logIn() hadn't aliased yet" [CODE server.js:4173], and treats a truly
orphaned purchase as a real class. That is this bug seen from the other end.

**And it is currently invisible.** `rc_identify_failed`, `rc_identify_mismatch`
and `purchase_blocked_unidentified` are allowlisted server-side
[CODE server.js:3202] and **emitted by nothing in the iOS tree** — grep returns
zero call sites. The allowlist has been carrying three events no client sends,
which is the same "shipped but inert" class as the BOOLEAN preview column.

**The change** (one retry + one event):

```swift
func identify(userId: String) async {
    guard initialized else { return }
    for attempt in 1...3 {
        do {
            _ = try await Purchases.shared.logIn(userId)
            await refreshCustomerInfo()
            return
        } catch {
            if attempt == 3 {
                Analytics.capture("rc_identify_failed",
                                  ["error": error.localizedDescription,
                                   "attempts": attempt])
                return
            }
            try? await Task.sleep(nanoseconds: UInt64(attempt) * 1_000_000_000)
        }
    }
}
```

Retry is correct HERE and is not a violation of the no-retries law: that law
forbids retrying a *render* instead of root-causing it. This is an idempotent
identity alias against a third party, where the only alternative to retrying is
staying anonymous forever.

**Acceptance:** with the network disabled at sign-in, `rc_identify_failed`
appears in `analytics_events` (it cannot today — no emitter exists); with the
network restored on a later launch, `profiles.rc_app_user_id` is the Supabase
id, not `$RCAnonymousID`.

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

## 7. Upload leg — resumable, or the front door stays broken

Full evidence: `reports/UNS_MECHANISM.md`. The headline [MEASURED 2026-08-12,
since 08-06]: **`upload_failed` hit 720 USERS**; only **24.1%** of started
uploads complete (1,161/4,825); **79% of failures died with under 1% of the
file transferred**, after hanging p90 **30.4 minutes**. `cancelled` is the
single biggest mechanism (704 events / 395 users), and
`upload_url_requested` is **13,310 `single` vs 7 `multipart`** — multipart is
dead in practice.

One PUT of the whole file, no resumability. Background the app or wobble the
network and it dies at byte ~zero, the presigned key is dead, and the retry
starts from scratch. **82% of affected users never complete anything, ever.**

1. **Use multipart/resumable for anything but a trivially small file.** Chunked
   parts survive a suspension and a wobble; a single PUT does not. The server
   half can ship dark ahead of this build.
2. **Use a background URLSession with a proper transfer task**, so an upload in
   progress is not killed the moment the app leaves the foreground — that is
   what `background_orphan` (347 failures vs 109 completions) is counting.
3. **Emit `upload_attempt`** with `{size_mb, path, src_key}` at upload START.
   It is allowlisted server-side [CODE server.js:3178] and has fired **0 times**
   — so nobody can currently band this class by file size. Without it, "big
   files or slow networks?" stays [UNKNOWN].
4. **Fix the remedy copy.** "Pick it again to start a fresh upload" is honest
   about the dead key and still tells a user on a slow connection to repeat,
   from zero, a 30-minute action that just failed. If a resumable transfer
   exists, offer RESUME; if not, say the connection is too slow for the file's
   size and name that.

**Acceptance:** start an upload on a throttled connection, background the app
for 60s, return → the transfer continues rather than restarting; and
`upload_attempt` rows appear in `analytics_events` with a real `size_mb` (they
cannot today — the event has never fired).

**Unblocks:** nothing server-side; this is the front door. A great editor
behind a broken front door is not a great product.

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
5. Disable the network at sign-in → `rc_identify_failed` lands in
   `analytics_events` (impossible today — no emitter). Restore the network,
   relaunch → `profiles.rc_app_user_id` is the Supabase id, not `$RCAnonymousID`.
6. Paywall order changes from the RC dashboard (or config) without a build —
   or the no-op is documented.
