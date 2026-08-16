# PRE-REGISTRATION — the first Lumen edit run (pending at write time)

**JUDGE, 2026-08-16. Written while the run is PENDING (started 13:11:46Z,
ceiling $1.20), so the read cannot be fitted to the result.**

## There is no video artifact, and my scorecard cannot grade this

`lumen_first_edit_app.py` is **plan-only**: zero calls to `render_multi_clip`,
`_run_remotion` or `render-full` [MEASURED — grep count 0]. It returns
`scene_count`, `scene_kinds`, `plan_keys`, `has_design_system`, `accent`,
`brand_specs`, `clips`, `captions`. **No file is produced.**

My component scorecard measures VIDEO — canvas, audio master, motion/stillness,
palette — all ffmpeg reads on an artifact. **It cannot score a plan, and saying
so is the correct answer rather than manufacturing a number from the wrong
instrument.** The plan-side dimension (`rhythm_dimension.py`) is the right tool
for a plan; the video battery is the right tool for a render. Scoring the first
with the second is the category error my applicability map exists to prevent.

**What would produce a scoreable artifact:** a render leg. Until one exists,
`full_edit` scoring has no input.

## What the pending run WILL answer — registered now

It targets the exact question the liveness counter raised
(`no_copy_in_plan`, 11/11):

| field | what it settles |
|---|---|
| `scene_count` > 0 | the planner CAN emit scenes when `premium=True` |
| `scene_count` == 0 | scenes are unreachable even with the premium gate open — a planner/prompt gap, not a flag gap |
| `brand_specs.name_plate` | whether a premium plan carries the copy that 11/11 production plans lacked |
| `has_design_system` | whether the palette builds in the build lane as it does in production (11/11 there) |

**Pre-registered readings, fixed before the result:**

1. **`scene_count` > 0 with `brand_specs` populated** → the components are
   reachable and the gap is production-side (the live flag), not planner-side.
   The [BUILT-NOT-WIRED] entries stay OPEN regardless — a build-lane plan is not
   production reach.
2. **`scene_count` == 0** → the planner does not emit scenes even premium-gated.
   That is the stronger and more useful finding, and it relocates the whole
   Phase-1 scene question from "flip a flag" to "the planner never asks."
3. **`ok: false`** → the sixth consecutive attempt to die before answering. Not
   a finding about scenes; a finding about the harness.

**Whatever it returns, it is QUALITY/CAPABILITY evidence only.** A build-lane
plan cannot close a built-not-wired entry, which needs a production counter.

## Spend

Ceiling **$1.20** stated in advance; realistic band $0.10–$0.60. Actual goes in
`MODAL_SPEND_LEDGER.md` against that ceiling. My own lane spend this round: $0.
