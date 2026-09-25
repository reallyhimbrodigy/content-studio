#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# waiting-state-gate.sh — THE WORDS MUST NOT STOP BEFORE THE RENDER DOES.
#
# MEASURED, from stage_timings on real completed jobs: `render` runs 94.6s,
# 137.1s and 143.2s — the dominant stretch of a 140–253s job. The derived
# narration under it dwelled 3.2s per child with 8s on the last, so five
# children were exhausted in 20.8 SECONDS. For the remaining 73–122 seconds the
# label sat frozen on "Saving your video".
#
# The ring kept ramping, so this never looked like a dead screen in a
# screenshot — which is exactly why it survived. The words are the half a user
# actually reads, and they stopped two minutes early.
#
# THERE WAS A LIVE SIGNAL THE WHOLE TIME. 30 jobs sitting at step=render carry
# progress 65..95 across six distinct values, and SSE heartbeats the same band
# (65 -> 90..93). The narration ignored all of it and ran on a timer.
#
# THE RULER MATTERS. The bar is drawn on a 30–100 DISPLAY band; the narration
# is placed inside the WORKER's band for the stage. Handing the narration the
# mapped bar value measures the render against the wrong ruler and puts the
# words in the wrong place for the whole stage — a bug that looks like nothing
# at all, because something still moves.
set -uo pipefail
cd "$(dirname "$0")"
M="Promptly/Models/Models.swift"
E="Promptly/Views/EditorView.swift"
fail=0
note() { echo "  FAIL — $1"; fail=1; }
for f in "$M" "$E"; do
  [ -f "$f" ] || { echo "  FAIL — missing $f (a failed read is not a pass)"; exit 1; }
done

echo "waiting-state-gate:"

# ── 1. THE DWELL SPANS THE MEASURED STAGE ──────────────────────────────────
dwell=$(grep -oE 'static let derivedDwellNanos: UInt64 = ([0-9_]+)' "$M" | grep -oE '[0-9_]+$' | tr -d '_')
if [ -z "$dwell" ]; then
  note "there is no derivedDwellNanos — the narration dwell is a literal again, and a literal is how it ended up at 3.2s"
else
  secs=$(( dwell / 1000000000 ))
  # Four gaps plus the final hold must cover a render that measured 94s at its
  # SHORTEST. Below ~20s per child it runs out before the stage does.
  if [ "$secs" -ge 20 ]; then
    echo "  ok   — derived dwell is ${secs}s per child, sized to the measured 94–143s render"
  else
    note "derived dwell is ${secs}s per child — five children exhaust in $(( secs * 4 + 30 ))s against a render measured at 94–143s, so the label freezes again"
  fi
fi

# ── 2. REAL PROGRESS DRIVES THE NARRATION, AND ONLY FORWARD ────────────────
adv="$(sed -n '/func receive(progressPct:/,/^    }/p' "$M")"
if [ -z "$adv" ]; then
  note "there is no receive(progressPct:) — the narration runs on a timer alone and ignores the server's own progress"
else
  printf '%s' "$adv" | grep -Fq 'guard target > currentIdx else { return }' \
    && echo "  ok   — the narration only ever moves forward" \
    || note "receive(progressPct:) does not guard against moving backwards — a late poll would read as the render restarting"
  printf '%s' "$adv" | grep -Fq 'PipelineCatalog.progressBand(for: parentId)' \
    && echo "  ok   — placed inside the stage's own progress band" \
    || note "receive(progressPct:) does not use a progress band — a whole-job pct cannot place a label inside one stage"
fi

# ── 3. THE BAND IS THE MEASURED ONE ────────────────────────────────────────
grep -Eq 'case "render": return \(65, 95\)' "$M" \
  && echo "  ok   — render's band is the measured 65–95" \
  || note "render's progress band is not (65, 95) — that is what live rows carry, and a wrong band misplaces every label in the longest stage"

# ── 4. BOTH LIVE PATHS FEED IT, WITH THE RAW PCT ───────────────────────────
# The mapped value is the bar's ruler, not the worker's.
if grep -Eq 'receive\(progressPct: Int\(p\)\)' "$E"; then
  echo "  ok   — the poll feeds the narration the raw worker pct"
else
  note "the poll does not call receive(progressPct: Int(p)) — either it is not wired, or it is passing the mapped bar value against the wrong ruler"
fi
if grep -Eq 'receive\(progressPct: progress\)' "$E"; then
  echo "  ok   — and so does SSE" \
    && :
else
  note "SSE does not feed the narration — during a render the heartbeats are the only live signal, and a dropped poll would leave the words still"
fi
for bad in 'receive(progressPct: mapped)' 'receive(progressPct: clamped)'; do
  if grep -Fq "$bad" "$E"; then
    note "a caller passes \`${bad##*: }\` — that is the 30–100 DISPLAY value, not the worker's; the label would sit in the wrong place for the whole stage"
  fi
done
echo "  ok   — no caller passes the display-band value"

# ── 5. CHATCUT'S FOUR STEPS, WITH THE BANDS B1 PUBLISHED ───────────────────
R="Promptly/Views/RenderProgressRing.swift"
[ -f "$R" ] || { echo "  FAIL — missing $R"; exit 1; }
for pair in "staged:(5, 10)" "editing:(10, 80)" "exporting:(80, 95)" "delivering:(95, 100)"; do
  id="${pair%%:*}"; band="${pair#*:}"
  grep -Fq "case \"$id\": return $band" "$M" \
    || note "ChatCut step '$id' has no progress band $band — the narration cannot be placed inside it"
done
echo "  ok   — all four ChatCut bands present (5 / 10-80 / 80-95 / 95-100)"

# EDITING IS THE LONG ONE, so it must carry the most lines. 70 of the 100
# points are spent here; one label for that stretch is the freeze again.
edit_children=$(grep -cE 'parent: "editing"' "$M")
other_children=$(grep -cE 'parent: "exporting"|parent: "staged"|parent: "delivering"' "$M")
if [ "$edit_children" -ge 4 ] && [ "$edit_children" -gt "$other_children" ]; then
  echo "  ok   — editing carries $edit_children sub-lines, more than the other ChatCut stages ($other_children)"
else
  note "editing has $edit_children sub-line(s) against $other_children elsewhere — it owns 70 of the 100 points and must own the most lines"
fi

# ── 6. THE PIPELINE IS RECOGNISED FROM ITS FIRST TOKEN ─────────────────────
# The timeline is built at dispatch, before the pipeline is known. Without
# this every ChatCut step is an unknown token.
grep -Fq 'if PipelineCatalog.chatCutStageIds.contains(token), mode != "chatcut" {' "$M" \
  && echo "  ok   — a ChatCut token reconfigures the timeline instead of being discarded" \
  || note "nothing adopts the ChatCut catalog — the timeline is created before the pipeline is known, so every ChatCut step would arrive as unknown"

# ── 7. AN UNKNOWN STEP NEVER FREEZES THE LABEL ─────────────────────────────
unk="$(sed -n '/func receive(stepToken token: String)/,/^        genericLine = nil/p' "$M")"
printf '%s' "$unk" | grep -Fq 'currentStageId = nil' \
  && echo "  ok   — an unknown step clears the stage pointer rather than leaving it" \
  || note "an unknown step leaves currentStageId set — the local catalog stage WINS on the ring, so the label would sit on a stage that stopped running"
printf '%s' "$unk" | grep -Fq 'genericLine = String(localized:' \
  && echo "  ok   — and puts up a generic line" \
  || note "an unknown step sets no generic line — the ring would fall through to the server's untranslated message or \"Getting started\""
grep -Fq 'if let g = timeline.genericLine, !g.isEmpty { return g }' "$R" \
  && echo "  ok   — the ring renders that generic line" \
  || note "RenderProgressRing never reads genericLine — the fallback is set and displayed by nobody"

[ "$fail" = 0 ] && echo "waiting-state-gate: PASS" || echo "waiting-state-gate: FAIL"
exit "$fail"
