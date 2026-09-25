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

# ── 8. THE STEP CLOCK IS WIRED ON BOTH RAILS, AND FIRES ONCE ───────────────
# "How long from dispatch to the first `editing` step" had no answer anywhere
# before this: upload_timing ends at dispatch and the job row carries no
# client clock. An instrument wired to one rail would read whichever arrived
# first; one with no once-guard would report how often we polled.
T="Promptly/Services/RenderStepTiming.swift"
[ -f "$T" ] || { echo "  FAIL — missing $T (a failed read is not a pass)"; exit 1; }
grep -Fq 'RenderStepTiming.begin(jobId: jobId, dispatchedAt: dispatchStamp)' "$E" \
  && echo "  ok   — the step clock starts in startSSE, which every watch path goes through" \
  || note "nothing starts the step clock in startSSE — a dispatch instrumented on one call site and not another measures nothing reliable"
sse_n=$(grep -c 'RenderStepTiming.step(jobId: jid, token: step)' "$E")
poll_n=$(grep -c 'RenderStepTiming.step(jobId: jobId, token: step)' "$E")
if [ "$sse_n" -ge 1 ] && [ "$poll_n" -ge 1 ]; then
  echo "  ok   — both rails report steps (SSE and the reconcile poll)"
else
  note "steps are reported on only one rail (sse=$sse_n poll=$poll_n) — whichever arrives first would be the only one ever timed"
fi
grep -Fq 'guard var r = records[jobId], !r.seen.contains(token) else { return }' "$T" \
  && echo "  ok   — once per (job, step), so a poll cannot inflate the count" \
  || note "RenderStepTiming.step has no once-per-(job,step) guard — a step current for two minutes emits on every poll tick"
grep -Fq 'dispatchedAt ?? Date()' "$E" \
  && echo "  ok   — timed from the message's own dispatch stamp, set before the request left" \
  || note "the clock does not prefer the message's dispatchedAt — timing from the reply measures our round trip, not the user's wait"

# ── 9. THE WAITING SCREEN CANNOT STORM THE SERVER ──────────────────────────
# Server log, 2026-09-25: one job took 67/142/151/118 GET /api/video-jobs per
# MINUTE across four minutes, every one a 429. That is ~2.5 requests/second for
# a single render. A demo freezes on exactly this.
#
# Two independent ways this screen talks to the server, and both are bounded
# here because fixing one while the other can storm proves nothing.

# (a) THE RECONCILE POLL floor. 3s while the user is watching, backing off
# after a minute. Anything under ~2s per job is the storm rate.
fast=$(sed -n '/POLL CADENCE: fast while the user is watching/,/interval = .seconds(3)/p' "$E" | grep -oE 'interval = \.seconds\(([0-9]+)\)' | grep -oE '[0-9]+' | head -1)
if [ -n "$fast" ] && [ "$fast" -ge 3 ]; then
  echo "  ok   — the reconcile poll floor is ${fast}s per job"
else
  note "the reconcile poll floor is '${fast:-unreadable}'s — at or under 2s this is the storm rate seen in the server log"
fi

# (b) SSE RE-ENTRY must not orphan a live client. `sseClients[jobId] = client`
# alone drops the dictionary's handle without closing the socket; URLSession
# retains its delegate, so the orphan reconnects forever with nothing able to
# stop it. Six call sites reach startSSE and only one guarded against re-entry,
# so every extra watch of a job left another one running.
# NON-COMMENT LINES ONLY. The comment above the fix quotes the broken line
# verbatim to explain what it was, and a check that cannot tell an explanation
# from a call reads that quote as the code — which is how a useful comment gets
# deleted to make a gate green. Third time this pattern has bitten in this file.
start_body="$(sed -n '/private func startSSE(jobId: String, messageId: UUID) {/,/client.onEvent = { event in/p' "$E" | grep -v '^[[:space:]]*//')"
dis_line=$(printf '%s\n' "$start_body" | grep -n 'sseClients\[jobId\]?\.disconnect()' | head -1 | cut -d: -f1)
set_line=$(printf '%s\n' "$start_body" | grep -n 'sseClients\[jobId\] = client' | head -1 | cut -d: -f1)
if [ -z "$dis_line" ]; then
  note "startSSE does not disconnect the existing client before replacing it — the orphan keeps reconnecting against /api/video-jobs/<id>/stream and nothing holds a handle to stop it"
elif [ -z "$set_line" ] || [ "$dis_line" -gt "$set_line" ]; then
  note "startSSE disconnects AFTER assigning — by then the handle to the old client is gone and the disconnect hits the new one"
else
  echo "  ok   — startSSE closes any existing watcher before replacing it"
fi

[ "$fail" = 0 ] && echo "waiting-state-gate: PASS" || echo "waiting-state-gate: FAIL"
exit "$fail"
