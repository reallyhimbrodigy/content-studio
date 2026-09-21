# The re-edit entry — one page, for Builder 1

**Same machinery, different entry.** A chat message on an existing job —
"make it shorter", "switch the caption style" — reopens the SAME ChatCut
project and runs the SAME two-call loop. Nothing here is a new pipeline.

**Why it matters:** 153 jobs in 30 days (4.0%) are surgical re-edits, and they
are the class where the pipeline is most likely to do the wrong thing — not by
missing the ask, but by doing more than it.

## 1. What the server sends

```
POST <harness>/reedit
{
  "job_id":        "<the original job>",
  "project_id":    "<the ChatCut project it produced>",   // reopened, not recreated
  "timeline_id":   "<...>",
  "brief":         "make it shorter",                     // the TWEAK, verbatim
  "original_brief":"<the first brief>",                   // context, never re-executed
  "request_class": "SURGICAL_REEDIT",                     // from the D1 classifier
  "has_constraint": true|false
}
```

`request_class` and `has_constraint` are the fields the judge needs to apply the
surgical rule. The server already computes them at dispatch for D4, so this is a
field to pass, not a thing to build.

## 2. What the harness opens

- **Reopen the project — do not prestage a new one.** The timeline the user is
  reacting to IS the subject. A fresh import loses every placement they liked
  and turns a tweak into a re-edit from scratch.
- **Read the CURRENT timeline state** and put it in the prefix, the same shape
  `timeline_sample` already has.
- **Compose a rewatch OF THE CURRENT EDIT**, not of the source. The agent is
  being asked to change something it can see; watching the raw source again
  answers the wrong question.
- **Then the same two-call loop, the same gate, the same export.**

## 3. What the judge checks

Two rules, and the second is the one that does not exist for first edits.

**(a) THE SURGICAL RULE — Zac's Sep-9 law, now implemented.**
`did_more_than_asked` counts every change in the ops and the timeline that no
ask in the tweak covers. On `SURGICAL_REEDIT` or any brief carrying an explicit
constraint, `scope_verdict` becomes `FAILED_DID_MORE_THAN_ASKED` on a count
above zero — **whatever the honor rate**. "Make the captions bigger" answered
with three zooms added fails, however good the zooms are.

RED-proven: three unasked zooms on a surgical brief → FAILED, did_more=3, and
the caption ask itself still reads HONORED — the failure is the EXTRA, not the
ask. The SAME three zooms under a `PRESET` brief → `EXTRA_WITHIN_PRESET_LICENCE`,
because a preset licenses the standard families and flagging them would make the
check noise.

**(b) NOTHING THE USER LIKED WAS TOUCHED.** This needs a before/after diff,
which a first edit has no equivalent of:

```
untouched = items present in the BEFORE timeline, unchanged in the AFTER,
            that no ask in the tweak refers to
```

Any before-item that is missing, moved, retimed or restyled and is NOT covered
by the tweak is a violation of the same law, reported separately from
`did_more_than_asked` because the remedy differs: one is an addition, the other
is damage to work the user had already accepted.

**What the harness must therefore record: the BEFORE timeline.** Without it the
judge cannot tell "left alone" from "never existed", and that is precisely the
distinction this rule turns on. One extra `timeline_sample` taken before turn 1.

### The exact shape — this is all the judge reads

Record it under `before_timeline`, in the same shape `timeline_sample` already
produces. Only four fields per item are compared; anything else you record is
carried and ignored.

```json
"before_timeline": {
  "items": [
    {"id": "d196b800", "from": 0,   "dur": 335, "track": "V1", "kind": "video"},
    {"id": "64648857", "from": 565, "dur": 46,  "track": "V2", "kind": "motion-graphic"},
    {"id": "z1",       "from": 150, "dur": 30,  "track": "V3", "kind": "effect"}
  ]
}
```

`fromFrame` / `durationInFrames` / `trackAlias` / `itemType` are accepted under
their ChatCut names too — the diff reads either spelling, so the existing
`timeline_sample` rows can be passed through unchanged.

**IDENTITY IS THE ITEM ID.** The diff is keyed on it; a re-created item with a
new id reads as REMOVED + unasked-addition, which is the correct reading —
replacing an item the user accepted is not leaving it alone.

**The judge's three states, never a bare number:**

| | |
|---|---|
| `untouched_state: MEASURED` | both timelines read; `untouched_kept` and `touched_without_an_ask` are real |
| `untouched_state: ABSENT` | no before-timeline — **nothing is claimed**, not a pass and not a fail |
| `scope_verdict: FAILED_TOUCHED_WHAT_WAS_LIKED` | a before-item changed or vanished with no ask covering it |

RED-proven, three legs: the tweak alone → IN_SCOPE, kept=3, touched=0; a zoom
the user already had silently removed → FAILED_TOUCHED_WHAT_WAS_LIKED naming the
item; no before-timeline → ABSENT with `touched_without_an_ask: null`.

The diff is MECHANICAL and calls no model — item identity, timing and track are
fields, and a diff over fields is not a judgement. The model is only asked which
asks cover which items.

## 4. What I am not specifying

The transport, the auth, and where the tweak arrives from — those are the
server's and yours. This is the contract the judge needs, not a design for the
rail.

## 5. Sequencing

The re-edit entry is worth wiring AFTER the port, as ruled. Nothing here blocks
it; the judge side is built and proven, and it reads whatever the harness
records.
