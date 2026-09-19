# D4 — the negotiation spec, and the classifier built dark

**Status: SPEC + COPY DRAFT. Nothing wired, nothing flipped. The flag does not
exist yet.**

## Where it sits, and why that is a new parking point

`needs_input` is a real, live terminal status (18 jobs in the last 30 days) with
a complete answer rail in `lib/ask.js`: `validateAnswer`, `canAcceptAnswer`, and
four answer kinds — `text`, `image`, `clip`, **`choice`**. `choice` is the shape
this needs.

But **nothing in the server routes parks a job at `needs_input` today.** The
only producer is the worker, via callback — `lib/__smoke_completion_delivery.js`
records the rule as "ask-back stays callback-owned", and the poller is asserted
NOT to settle a `needs_input` row. So D4 is not a reuse of an existing hook; it
is a genuinely new parking point, at dispatch, before a container is spent.

That is the whole point: today the ask is discovered (if ever) after the render
is paid for. The negotiation has to happen before.

```
POST /api/jobs  ->  classify(vibe_input)        [rules first, Haiku fallback]
                      |
                      +-- IN SCOPE ------------> dispatch unchanged. No new path.
                      |
                      +-- OUT OF SCOPE --------> park: needs_input + choice ask
                      +-- UNSAFE --------------> refuse: no render, no charge
                      +-- UNCLEAR -------------> park: needs_input + text ask
```

**No job row, no charge, no container** on the three parked branches. A parked
request costs nothing to produce and can be answered through the rail that
already exists.

## Router conservatism (ruled Jul 21 and Aug 9) — the binding constraint

The classifier **may act only on asks that TODAY would be silently dropped or
unsafely rendered.** It never restricts what the editor may do with an in-scope
brief. The user's prompt is the source of truth.

Concretely, and this is the line that must not be crossed: a brief that asks for
captions and zooms goes to the editor **untouched**, whatever else the
classifier thinks about it. The dark flag governs only the three parked
branches. A measured way to state the bar: with the flag ON, the count of jobs
reaching the editor must fall by exactly the parked count and by nothing else.

## The flag

`PROMPTLY_NEGOTIATE_OUT_OF_SCOPE` — default OFF. Dark means: classify, **record
the decision and the sentence that would have been shown**, and dispatch anyway.
That gives a measurable shadow rate before anything changes for a user, and it
is the only way to know the false-positive cost in advance.

## The copy — approved, held, and withdrawn

Counts are post-precedence 30-day demand. **Zac signs this copy.**

### Approved (edits applied: "imagery"→"visuals", colour→color, b-roll line reworded)

| # | tag | jobs/mo | the sentence |
|---|---|---|---|
| 1 | generative_vfx | **427** | "I edit the footage you uploaded — I can't generate new visuals or replace what's in the shot. I can cut it, add captions, zooms, sound effects and motion graphics. Want me to go ahead with that?" |
| 2 | music | **378** | "I don't add music to edits. Everything else you asked for I can do. You can add a track when you post it. Want me to go ahead without music?" |
| 4 | stock_broll | **224** | "I only use footage from your own upload, so I can't pull in stock or outside clips. I can show other moments from your video instead. Want me to go ahead that way?" |
| 5 | upscale_quality | **180** | "I can't raise the resolution — the edit comes out at the quality you uploaded. Everything else you asked for I can do. Want me to go ahead?" |
| 7 | voiceover_tts | **97** | "I can't generate a voiceover — I work with the audio already in your video. Want me to go ahead using your own audio?" |

### 3 — HELD, and the tag splits. The single tag was about to tell 246 users a month "no" to the thing the product does.

| split tag | jobs/mo | behaviour |
|---|---|---|
| **aspect_to_vertical** | **246** | **IN SCOPE. NEVER NEGOTIATES.** The product exports 9:16. A user asking for 9:16 / vertical / portrait / 縦型 is asking for the default. |
| **aspect_to_other** | **13** | negotiates: "Promptly edits in vertical (9:16) — I can't export in another shape. Want me to go ahead in vertical?" |
| (unresolved) | 13 | tagged `aspect_ratio` with no ratio word surviving the split — needs a look before either bucket claims them |

272 → **13 that genuinely negotiate**. Aspect drops from #3 in the backlog to
near the bottom.

**The landscape answer, from Builder-1, read out of the code: NOBODY HAS RUN
ONE, and the code does not choose either.**

- the canvas is always 1080x1920@30 — `prestage(..., w=1080, h=1920, fps=30)`
  calls `create_project` with those dimensions and **nothing reads the source's
  ratio**;
- the video stream is uploaded untouched: the only ffmpeg pass is an audio-lead
  shift (`-map 0:v:0 -c:v copy`). No scale, pad or crop by the lane;
- **the base item carries no geometry field at all** — the add is
  `{type, assetId, trackId, fromFrame, durationInFrames}` with no fit/fill/
  position. So a landscape item on a 9:16 canvas gets **ChatCut's default for a
  mismatched item, which has never been set and never been measured**;
- **no fixture is landscape.** All four are portrait 9:16.

So the sentence ships as written, because it is honest about the OUTPUT and
claims nothing about the source:

> "Promptly edits in vertical (9:16) — I can't export in another shape. Want me
> to go ahead in vertical?"

**And the gap is recorded rather than papered over: for a LANDSCAPE upload this
sentence does not tell the user whether they lose the edges.** Cropped, the
sides are gone; letterboxed, they are not. Until one run measures it, a
landscape user gets a true sentence that is not the whole truth, and that is a
known debt, not a finished answer.

Closing it needs a landscape fixture — constructible from the existing media by
the same method as the other two, no new capture — plus one run. Offered, not
built: it is outside the current rulings.

### 6 — WITHDRAWN AND REMOVED FROM THE TABLE. Color grading is a capability, not a negotiation.

Checked before telling 164 users a month no, and the capability exists.
**ChatCut's own tool schema**, verbatim:

- `submit_shader` → `type`: *"per-clip effect (**color**, blur, mask, **LUT-style
  grade**, distortion)"*, and the `prompt` field's own worked example is
  *"Cinematic teal-orange color grade"*.
- the `shader-gen` skill: *"color grading (LUT / 调色 / 电影感 / film look)… try
  the **built-in effects (zoom, builtin LUTs)** before generating a new shader"*
  — so there is a built-in LUT set AND a generator.
- `edit_item` already accepts `type: "effect"`, so applying one is an ordinary
  timeline operation, not a new path.

**The lane withholds it.** `NEEDED_TOOLS` is eight — edit_item, edit_captions,
preview_timeline, read_captions, inspect_item, inspect_asset, edit_asset,
read_project — and `MCP_SHIM_ALLOW` is built from that list, so the withholding
is enforced at the shim rather than advised in a prompt. `submit_shader` appears
**zero** times in the lane.

One thing to fix alongside the wiring: the lane maps `kind == "effect"` to the
family **"zoom"**. A color grade placed today would be counted as a zoom, so the
measurement would be wrong in a new way the moment the capability is wired.

**Reported and stopped there, per the ruling.** No sentence is drafted, and
`color_grade_lut` is REMOVED from the negotiation set entirely — it is not a
tag awaiting copy. It is a WIRING ITEM for Builder-1, pending Zac.

Once wired, its 164 jobs/month move into the honored / dropped columns like any
other supported family — which also means the negotiation backlog and the
fulfilment score will both move, in opposite directions, on the same day. Worth
expecting rather than explaining afterwards.

## Composition — one message, not one per ask

A brief with N out-of-scope asks produces **ONE** message: all N named, one
"can do" list **that is actually true for that brief**, one question.

"Everything else you asked for I can do" is a GENERATED line, emitted only when
the brief's remaining asks are all in scope. A brief asking for music, an
upscale and a colour grade cannot carry it — the sentence becomes a list of what
survives, and if nothing survives there is no "can do" clause at all, only the
refusal and the question.

## Language — served in the brief's language

The classifier already carries `typed_in` (15.2% of briefs are not English: pt
106, hi-Latn 95, ar 55, hi 52, mixed 51, id 39, es 33, ru 30, fr 21, ja 20, fa
17, de 14, pl 6). The sentence is served in that language.

**If a translation is not available for a language, that is REPORTED as a gap —
English is never served to a Portuguese brief.** A negotiation the user cannot
read is a silent drop with extra steps.

## What I would want measured before it is flipped

1. The shadow rate with the flag dark: how many jobs WOULD have been parked, and
   the classifier's false-positive rate against a hand-checked sample.
2. The answer rate on parked jobs. A negotiation nobody answers is a new way to
   lose a user, not a fix — the honest comparison is parked-and-answered against
   today's silent-drop, not against zero.
3. Whether parked-then-answered jobs convert better or worse than the 86.1% that
   currently come back `completed` with the ask ignored.

## The known false positive, named

The recall-favouring union mis-files **negated** asks as requests. "Do NOT apply
any beauty filter, skin smooth, skin whitening, or face retouch. Keep my natural
skin texture" ranked #10 in the backlog on the word "filter" — 10 jobs, all
completed. It is a CONSTRAINT, the opposite of a request, and showing that user
"I don't apply colour grades" would be answering a question they did not ask.

Fixed by a precedence rule — a negated ask is a constraint, never out of scope —
and the backlog re-run with it. The classifier must carry the same rule or it
will negotiate against instructions users already gave.

## The shadow table (ruling 1) — SQL for the advisor to apply on Zac's go

Additive only: creates one table, alters nothing, drops nothing, and no existing
read or write path touches it. Safe to apply while the server runs.

**The brief text is never stored — only a sha256 of it.** A decision can be
traced back to a request without this table becoming a second copy of user
content, and without an unsafe brief ever being persisted here.

Applied or not, decisions also go to `console.log`, so the record survives the
migration not having landed.

```sql
-- migrations/20260919_negotiation_decisions.sql
CREATE TABLE IF NOT EXISTS public.negotiation_decisions (
  id            bigserial PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  request_hash  text        NOT NULL,     -- sha256 hex. NOT the brief.
  client_job_id text,
  verdict       text        NOT NULL CHECK (verdict IN ('PASS','NEGOTIATE','REFUSE')),
  classes       text[]      NOT NULL DEFAULT '{}',
  sentence      text,                     -- what the user WOULD have seen
  safety_state  text        NOT NULL CHECK (safety_state IN ('MEASURED','REVIEW_UNAVAILABLE')),
  decider       text        CHECK (decider IN ('regex','model')),
  uncertain     boolean     NOT NULL DEFAULT false,
  degraded      boolean     NOT NULL DEFAULT false,
  language      text,
  flag_state    text        NOT NULL CHECK (flag_state IN ('DARK','ON'))
);

CREATE INDEX IF NOT EXISTS negotiation_decisions_created_idx  ON public.negotiation_decisions (created_at DESC);
CREATE INDEX IF NOT EXISTS negotiation_decisions_verdict_idx  ON public.negotiation_decisions (verdict, created_at DESC);
CREATE INDEX IF NOT EXISTS negotiation_decisions_language_idx ON public.negotiation_decisions (language);

ALTER TABLE public.negotiation_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.negotiation_decisions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.negotiation_decisions FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.negotiation_decisions_id_seq FROM anon, authenticated;
```

**RLS on with no permissive policy** means anon and authenticated can neither
read nor write; the service role bypasses RLS and is the only writer. Stated
explicitly rather than left to the default, because a table created without RLS
is readable by every signed-in user.

## REVIEW_UNAVAILABLE when the flag is live (ruling 3)

**A classifier outage must not become a product outage.**

| the model leg | what happens |
|---|---|
| says unsafe | REFUSE |
| says safe | the negotiation decision stands |
| **unavailable** | **dispatch PROCEEDS, exactly as today, and an owner alert fires** |
| — and a **regex** refusal | **holds regardless.** It never waits on the model and the model cannot overturn it. |

An out-of-scope brief dispatches un-negotiated during an outage rather than
parking. Parking on a degraded read would change product behaviour during an
outage, which is the failure the rule exists to prevent.

**The cost is real and is not hidden:** while the adjudicator is down, unsafe
briefs the regex cannot see reach the editor. That is exactly today's behaviour,
so it is not a regression — and it is why the alert fires. The alert is
throttled to one per 10 minutes, because a Haiku outage is one event and 90
pages for it is the same as none.
