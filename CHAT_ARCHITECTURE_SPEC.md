# CHAT ARCHITECTURE — multimodal boundary, tool calling, image pacing

**SPEC ONLY. Nothing here is built.** Written 2026-08-18 from four code reads,
each cited. This is the shape of the product; it is worth getting right rather
than fast.

---

## §0 — WHAT IS TRUE TODAY (read from code, not assumed)

| question | answer | evidence |
|---|---|---|
| does an attached image reach the model? | **no — never looked for** | `server.js`: `const message = String(body?.message \|\| '').trim()`, then `parts: [{ text: message }]` |
| can a non-text reply be returned? | **no — it 502s** | `const reply = …parts?.[0]?.text \|\| ''; if (!reply.trim()) return sendJson(res, 502, {error:'empty_ai_reply'})` |
| is the action set a tool contract? | **no — three regexes** | `lib/chat-actions.js`: `EDIT_VERB_RE`, `COMPONENT_NOUN_RE`, `PRIOR_REF_RE` |
| would chat images share Lumen's quota? | **no — different surface** | worker `_get_genai_client()` → **Vertex** (`aiplatform`, project `promptly-479218`); chat → `generativelanguage` + `GEMINI_API_KEY` |

**Not verified, deliberately unasserted:** the specific `2/min` and `60/min`
figures. The code proves the surfaces are *distinct*; the numeric limits live in
the quota console, which is the owner's to read. The spec below is correct
either way, because it does not depend on the numbers — only on the fact that
two independent buckets exist.

---

## §1 — THE MULTIMODAL BOUNDARY

### 1.1 Input: a media field that survives the boundary

The body contract gains one optional field. It is an ARRAY because the first
photo is never the last, and a scalar would be re-specced within a month.

```jsonc
POST /api/chat
{
  "message": "make the captions look like this",
  "media": [                       // optional, absent === today's behaviour
    { "kind": "image",
      "mime": "image/jpeg",        // allowlist, see 1.3
      "data": "<base64>",          // OR
      "url":  "https://…" }        // one of data|url, never both
  ]
}
```

**Assembly.** Media parts precede the text part, because a model reads the
attachment as context for the sentence, not the other way round:

```js
const parts = [];
for (const m of media) parts.push({ inline_data: { mime_type: m.mime, data: m.data } });
parts.push({ text: message });
contents.push({ role: 'user', parts });
```

**The `message`-required rule relaxes but does not vanish.** Today a blank
message is a 400. With media present, a blank message is legal — "here's a
photo" is a complete turn — but a request with NEITHER message NOR media stays
a 400. State it as: at least one of the two must be non-empty.

### 1.2 Output: parts, not `parts[0].text`

The reply parser becomes a walk, and the response gains a typed shape. The
current single-field `{ reply }` stays populated for every existing client —
**no client change is required to keep working**, which is what makes this
shippable independently of the app.

```js
const partsOut = data?.candidates?.[0]?.content?.parts || [];
const text   = partsOut.filter(p => p.text).map(p => p.text).join('');
const images = partsOut.filter(p => p.inline_data || p.inlineData)
                       .map(p => p.inline_data || p.inlineData);
```

```jsonc
200 {
  "reply": "<text, unchanged contract>",
  "attachments": [ { "kind":"image", "mime":"image/png", "url":"https://…" } ]
}
```

**Images are persisted, never returned inline.** A base64 image in a JSON chat
response is a payload that will be logged, cached and re-sent; it goes to the
private export bucket and the reply carries a short-TTL signed URL. Same
discipline as `clean_export_key` — the artifact is private by default and the
URL is the grant.

### 1.3 The rules that keep this from becoming an incident

- **Allowlist mime types** (`image/jpeg|png|webp`). Never echo a caller-supplied
  mime into the upstream request unchecked.
- **Cap size and count** — a per-image byte ceiling and a per-turn count. The
  chat surface is the cheapest place in the product to send 40 MB by accident.
- **`empty_ai_reply` must be re-scoped.** Today an image-only reply would trip
  it, because the check is `!reply.trim()`. It becomes: **empty iff there is
  neither text nor an attachment.** This is a one-line change and it is the
  single most likely way a correct implementation still ships broken.
- **The 502 stays for genuinely empty.** A blank turn is still an error, not a
  200 with nothing in it — that rule was earned.

### 1.4 What a returned image attaches to

A chat message becomes `{ role, text, attachments[] }`. The attachment is a
sibling of the text, not a replacement: a model that returns "here's the palette
I'd use" plus an image must render both. The iOS side renders an attachment as a
tappable thumbnail in the message bubble; that is spec for
`IOS_FINAL_BUILD.md`, not for this repo, and it is **one build** — the server
contract above is what unblocks it.

---

## §2 — TOOL CALLING, REPLACING THE THREE REGEXES

### 2.1 Why this and not a better classifier

`lib/chat-actions.js` decides intent by matching a hand-written verb list
against a hand-written noun list. Every phrasing outside those lists is a
misclassification **by construction**, and the vocabulary can only grow by
someone remembering to add a word. "Tighten the front half" contains no
`COMPONENT_NOUN_RE` noun. "Get rid of the silence at the start" contains no
`EDIT_VERB_RE` verb in the sense meant.

A closed enum of intents has the same defect one level up: it forces every
utterance into a fixed set, and the residue is misfiled rather than answered.

**Tool calling inverts it.** The video actions become callable functions the
model may invoke; everything else is simply the model's own reply. There is no
"unclassified" bucket, because not-a-tool-call is the normal case rather than
an error.

### 2.2 The tools

```jsonc
tools: [{ function_declarations: [
  { "name": "create_edit",
    "description": "Start a new edit from the user's most recently uploaded video.",
    "parameters": { "type":"object", "required":["vibe"], "properties":{
      "vibe": {"type":"string","description":"What the user asked for, verbatim."}}}},

  { "name": "revise_edit",
    "description": "Change an edit that already exists. Use when the user refers to a previous result.",
    "parameters": { "type":"object", "required":["change_request"], "properties":{
      "change_request": {"type":"string"},
      "job_id": {"type":"string","description":"Omit to use their most recent job."}}}},

  { "name": "get_job_status",
    "description": "Report progress of an in-flight edit.",
    "parameters": {"type":"object","properties":{"job_id":{"type":"string"}}}}
]}]
```

Three tools, matching the three things the server can actually do. **A tool that
does not map to an existing endpoint must not be declared** — a callable the
server cannot honour is a promise the product breaks.

### 2.3 What is preserved VERBATIM

These two properties are the good parts of the current design and the conversion
must not touch them:

1. **The dark flag.** `PROMPTLY_CHAT_ACTIONS` unset → the route 404s, "the route
   does not exist as far as any client can tell". Tool calling ships dark behind
   the SAME flag, so the rollback is the existing one.
2. **The loopback self-forward.** A tool call does **not** create a job inline.
   It self-forwards over 127.0.0.1 to `/api/video-jobs` (or `/re-edit`) carrying
   the caller's own `Authorization` header, exactly as today — so auth, the
   maintenance gate, rate limits, quotas/entitlements, paywall and dispatch hit
   **identically** whether the job came from the composer or the chat. A refused
   downstream (402/429/503) passes through verbatim.

   *That no-parallel-logic property is the single most valuable thing in the
   current file. A tool handler that calls the job-creation code directly would
   be a second implementation of the paywall, which is how a free user gets a
   render.*

### 2.4 The loop, and the one non-obvious rule

```
user turn → model → (a) text        → return it
                  → (b) tool_call   → self-forward → tool_response back to the model
                                    → model composes the user-facing sentence → return
```

**The model writes the confirmation, not the server.** Today's copy is
templated; with tool calling, the second model turn already knows what happened
and says so in the user's own register. The server still owns the *outcome* —
whether the job was created — and the model owns only how it is described.

### 2.5 Instrumentation, kept

`chat_action_classified / dispatched / clarified / refused` already exist and
already carry structured `[chat-action]` console markers that work with no
PostHog key. Map them: `classified` → a tool call was returned;
`dispatched` → the self-forward succeeded; `refused` → downstream non-2xx;
`clarified` → the model asked a question instead of calling. **Add
`chat_tool_unknown`** for a tool name the server does not implement — that
number is the health of the contract, and it should be zero.

---

## §3 — THE IMAGE PACER (shared admission control)

### 3.1 The gap

`_IMAGE_MODEL = "gemini-3-pro-image"` is called from `_generate_image` with **no
semaphore, no pacing, no queue** anywhere on the path. Lumen issues scene
generations as fast as the plan asks for them. Nothing prevents a burst today;
it has simply not been provoked, because scenes fire at 0/779.

The moment either (a) scenes start emitting, or (b) chat gains image generation,
that becomes a real burst against a per-minute bucket.

### 3.2 One admission controller, not two

**The pacer is per (surface, model), not global.** §0 establishes that chat and
Lumen sit on *different* API surfaces — AI Studio vs Vertex — so a single global
limiter would throttle one for the other's sake and silently halve a bucket that
was never shared.

```
admit(surface, model) -> token
   surface ∈ {vertex, aistudio}
   model   ∈ {gemini-3-pro-image, …}
```

- **Token bucket, not a sleep.** Capacity and refill per (surface, model), read
  from config so the numbers can be corrected when the console is checked
  without a code change.
- **Bounded wait, then a typed refusal.** A caller that cannot be admitted
  within its budget gets `IMAGE_CAPACITY` — never an unbounded block, and never
  a silent drop. Lumen degrades to a code-only scene; chat says "I can't
  generate that right now."
- **It must be LOUD.** Every refusal is ledgered with the surface, the model and
  the wait. A pacer that quietly delays is indistinguishable from a slow model,
  which is how a capacity problem gets diagnosed as latency for a week.

### 3.3 Where it lives

The worker path (`handler.py`) and any future chat path are **different
processes**, so an in-process semaphore cannot span them. In-process is correct
and sufficient *per surface* today, because each surface is served by one
process family. Say so explicitly in the implementation, and make the
cross-process case an explicit non-goal rather than an accidental omission — if
chat image generation ever moves to the worker, the two collapse onto one
surface and the pacer must then be shared for real.

### 3.4 The check (Rule 1), named before the work

A test that issues N concurrent requests against a capacity-M bucket and asserts
**at most M are admitted per window**, plus that the (M+1)th receives a typed
refusal rather than blocking forever. RED-proven by removing the limiter and
watching the assertion fail.

---

## §4 — ORDER, AND WHAT EACH ONE UNBLOCKS

1. **§1.3's `empty_ai_reply` re-scope** — one line, and without it every other
   part of §1 ships broken.
2. **§1 input** — media in. Independently useful: the model can *read* a photo
   long before it can return one.
3. **§3 pacer** — before anything can generate images, not after.
4. **§1 output** — non-text out, persisted to the private bucket.
5. **§2 tool calling** — the largest change, and the one that removes a whole
   class of misclassification. Ships dark behind the existing flag.

**Deliberately not in this spec:** the iOS rendering of an attachment. That is
`IOS_FINAL_BUILD.md`, it is one build, and the server contract in §1.2 is what
unblocks it.
