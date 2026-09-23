# Caption style profiles — the contract lives in the worker repo

`measured/CAPTION_STYLE_PROFILES.json` on **`lane/agentic-builder2`** in
`promptly-gpu-worker` is the single source for all seven live caption styles:
baseline preset, styleProfile overrides, the three things that are NOT
styleProfile fields (`sizePx`, layout/position, `paginationProfile.wordsPerPage`),
the one-line menu name, and every not-expressible note.

Build from that file and nothing else.

**Why a pointer and not a copy.** A second copy is a fixture outside the tree
that owns it: it drifts silently, and the drift shows up as a render that
disagrees with a document while both look authoritative. The values are read
from `src/remotion/src/captions/<Style>/<Style>.tsx`, which is in the worker
repo, so the file belongs beside them. This repo needs to know where it is, not
what it says.

Companion: `measured/MENU_LINES.json` on the same branch — the 32 menu lines.
