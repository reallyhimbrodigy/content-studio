# iOS handoff — chat that acts (one page, shippable)

Server half is live-deployable dark behind `PROMPTLY_CHAT_ACTIONS`
(`POST /api/chat/actions`, routes/chat-actions.js). This page is the entire
client change.

## 1. The one-router change — EditorView.swift:2443

Today `send()` routes free text **chat XOR render**, decided client-side by
whether a video/re-edit session is attached. Replace that decision with one
server call — the server decides converse-vs-act:

```
POST /api/chat/actions          (Authorization: same bearer as /api/chat)
{ "message": <text>,
  "video_url": <presigned URL if a video is attached, else omit>,
  "proxy_video_url": <if one exists, else omit> }
```

Handle by `action` in the JSON reply:

| action              | client behavior                                                       |
|---------------------|-----------------------------------------------------------------------|
| `converse`          | Fall through to `/api/chat/stream` exactly as today (streaming path unchanged). |
| `status`            | Render `message` as an assistant message. Done — no LLM call.         |
| `clarify`           | Render `message` as an assistant message (it is a question).          |
| `render_dispatched` | Render `message` as the assistant echo; attach the render card for `job_id` (same card the composer path shows). |
| `reedit_dispatched` | Same as above — the conversation IS the editing session record.       |
| HTTP 402 / 429 / 503| Body is the composer path's own refusal shape (paywall / rate / outage) — reuse the exact existing handling. |
| HTTP 404            | Flag is dark → use today's client-side router (this IS the fallback). |

**Fallback law:** the composer's direct render path stays compiled-in and is
used whenever the endpoint 404s (dark flag) or the call fails transport-level.
Ship the router change; the server flag decides who actually uses it.

## 2. The three UI items (owner-named)

1. **Full-width assistant text** — assistant messages render as full-width
   text blocks, not bubbles (MessageBubble.swift:77-87 keeps bubbles for the
   USER side only).
2. **Caret** — a blinking caret at the end of in-flight assistant text (the
   typewriter already paces reveal; add the caret glyph while streaming).
3. **Stop button** — visible while an assistant reply streams; cancels
   `activeChatTask` and keeps partial text (the long-press retry already
   exists; this is the affordance).

## 3. What NOT to change

- No client-side intent parsing — the server owns converse-vs-act.
- `/api/chat/stream` consumption, metering, and retry: untouched.
- The re-edit screen's explicit flow: untouched (chat re-edits arrive via
  `reedit_dispatched` with the same job cards).

Events land server-side (`chat_action_classified/dispatched/clarified/
refused`) — no client analytics work required for v1.
