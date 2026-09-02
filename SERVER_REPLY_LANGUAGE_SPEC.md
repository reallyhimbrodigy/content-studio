# Server spec — `reply_language`, and the copy that never reaches the catalog

**Owner: BUILDER.** The client half shipped in 1.3.21 (build 239). This is the
half that makes it do anything.

---

## The state today

A user whose phone is in Hindi sees a Hindi app — the twelve `.lproj` are
compiled in and iOS selects among them correctly. Then they open a chat and the
assistant answers in English. They hit a failed render and the error is in
English. They watch the progress line and it is in English.

None of that is a translation gap in the iOS catalog. Those strings are not in
the catalog at all, and cannot be: they are produced on the server, per request.

**Measured, not assumed** (`content-studio-main`, `main`):

| class | where it comes from | state |
|---|---|---|
| A — model replies | `lib/chat-router.js`, `lib/chat-actions.js`, `lib/video-processor/generate-edit.js`, `analyze-video.js` | English-only; **no language signal is passed at all** |
| B — re-edit acks | `lib/failure-copy.js` (Path B, `needs_clarification`) | English-only |
| C — worker/server error copy | `lib/failure-copy.js` — 12 named codes (`NO_SPEECH`, `NO_SPEECH_FACE`, `NO_SPEECH_NONENGLISH`, `NO_AUDIO`, `NO_AUDIO_TRACK`, `RENDER_TOO_SHORT`, `TOO_SHORT`, `CLIP_TOO_LONG`, `TOO_LONG`, `NOT_TALKING_HEAD`, `NO_SPEECH_FACE_ONLY`, `CORE_ERROR`) plus the dispatch/worker-died sentences | English-only, ~19 user-facing strings |
| D — render status | `step:` / `message:` emitted to the client — `"Getting started..."`, `"Folding in your answer…"`, `"Your video is ready!"` | English-only |

Grep for `user_language`, `preferred_language` or `respond in` across `lib/` and
`server.js` returns **nothing**. `detected_language` appears once, in
`lib/video-processor/transcribe.js:39`, and it is the language of the **clip's
audio** — not the reader.

---

## What the client now sends

1.3.21 adds `reply_language` to three request bodies:

- `POST /api/chat`
- `POST /api/chat/actions`
- `POST /api/video-jobs/re-edit`

The value is a BCP-47-ish code from the app's twelve: one of
`en es pt-BR fr de ja hi bn ne ur ar id`. It is `AppLanguage.current` — the
user's device language, or their explicit override from Account → Language.

Nothing reads it yet. `grep -rn reply_language` in this repo returns zero hits,
so today the field is inert and no response changes.

---

## THE DISTINCTION THAT MATTERS

**The reply follows the USER. The captions follow the CONTENT.**

These must not be merged, and the temptation to merge them is real because both
are "language".

A Hindi speaker editing an English-language interview clip wants:

- the assistant to answer them **in Hindi** — it is talking *to them*
- the burned-in captions to stay **in English** — they transcribe *the audio*

Driving captions from `reply_language` would mistranslate every clip whose audio
is not in the reader's language, which is most of them. Driving the reply from
`detected_language` would answer a Hindi user in English whenever they upload an
English clip — the current behaviour, and the bug.

So: `reply_language` governs **class A and B only**. Classes C and D are app
chrome and should be localised through the catalog (see below), not by the model.

---

## Ask

### 1. Thread `reply_language` into the model calls (classes A + B)

Read it from the request body, validate it against the twelve, and default to
`en` on anything unrecognised — never pass an unvalidated string into a prompt.

Append one instruction to the system prompt, e.g.:

> Respond in {language}. The user reads {language}; this is independent of the
> language spoken in their video, which you should never translate or comment on
> unless asked.

The second clause matters. Without it the model tends to "helpfully" note that
the clip is in a different language, or to translate the transcript into the
reply language when quoting it back.

**Do not** translate transcript excerpts, caption text, or the `vibe_input`
echo. Those are content.

### 2. Decide where classes C and D get localised

Two options, and the choice is yours because it is a server-shape question:

- **(a) Server sends a code, the app renders the string.** `failure-copy.js`
  already emits `error_code`; the app already overrides the worker's message by
  code (`lib/failure-copy.js:74-76`). Extending that so the app owns the
  *sentence* for every code puts this copy in the String Catalog, where the
  localization gate already covers it, and it needs no model call. **This is the
  cheaper and more reliable path**, and it matches the existing override.
- **(b) Server localises.** Requires a server-side string table in twelve
  languages and keeps the copy outside every check the client has.

If (a): the client needs the full code list and the guarantee that
`error_code` is always populated — today unknown codes fall back to the worker's
free-text `user_message`, which is exactly the case that would render English.

### 3. Verification I cannot do from here

Run a re-edit end to end with `reply_language: "hi"` and again with `"ar"`, and
confirm the response **comes back in that language** — not merely that the
request was understood. The failure mode to watch for is a model that
acknowledges in Hindi and then produces its actual content in English.

Please report the two raw responses. I will not mark this verified from the
client side, because sending a field is not evidence that anything read it.

---

## Not in scope here

- The iOS catalog itself: 217 conversion-surface strings are covered and
  gate-enforced (`ios/Promptly/localization-gate.sh`); the remaining catalog
  backlog is being worked separately.
- Caption language. It is correct as-is: the worker transcribes with
  `language="multi"` and detects per clip.
