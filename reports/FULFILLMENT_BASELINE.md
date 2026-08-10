# FULFILLMENT BASELINE — the first in the product's history

**Lane 1 / JUDGE, 2026-08-10. Judge: `scripts/fulfillment-judge.js`, claude-haiku-4-5, judge_version 2. Corpus: 1,607 completed recipe-bearing jobs → 3,766 decomposed asks `[MEASURED]`. Total LLM spend: $8.91 ($0.10 calibration + $4.56 v1 back-catalog + $3.10 v2 correction pass + $1.15 recent slice) — under the $10 pre-approval.**

## THE HEADLINE
| metric | all asks | custom-request asks (n=3,045) |
|---|---|---|
| HONORED | 53.0% | 49.5% |
| DROPPED_WITH_NOTE | 1.8% | 2.2% |
| **DROPPED_SILENTLY** | **35.1%** | **35.8%** |
| UNSUPPORTED | 10.1% | 12.4% |

**One in three things users ask for is dropped with no acknowledgment.** And the honesty channel barely fires: `capability_notes` covers only **1.8%** of asks (67 of ~1,768 dropped/unsupported) — the mechanism built to kill silent drops is itself nearly silent. `[MEASURED]`

**Recent traffic is worse than the average:** the 2026-08-09 day-slice (n=282 judged jobs, all v2 evidence) shows honor **31.8%** and dropped-silently **52.3%** — vs 53.0%/35.1% over the whole corpus. `[MEASURED]` `[INFERRED]` cause: route mix — zero-reject routing sends more traffic to lean routes, whose recipes render no captions/sfx/broll/text by construction, so custom asks on that traffic drop wholesale. The daily scoreboard will show whether this holds or was one day's mix.

## Per ask-class (full corpus, sorted by silent drops)
```
class                    n    honored  d-note  D-SILENT  unsup
style_preset            1254     914       0      339      1
motion_graphics          359     133       1      224      1
other (mostly 4k/HD)     193      26       0      163      4
sound_effects            321     199       9      112      1
text_overlay             126      34       3       89      0
zoom                     325     249       0       75      0
transitions               74      18       1       54      1
broll                     84      27       7       50      0
specific_moment_edit      76      26       1       49      0
pacing_speed             123      77       2       44      0
cut_content               90      53       2       34      1
captions                 235     185      20       30      0
captions_language         50      19       8       23      0
audio_cleanup             45      20       3       22      0
end_card                  13       1       0       12      0
color_grade              118       2       1        2    113
generative_ai             99       1       1        0     97
voiceover                 42       0       0        0     42
music                     82       0       8        0     74
aspect_ratio              55      13       0        0     42
logo_watermark             2       0       0        0      2
```

**Reads:**
- **motion_graphics is the #1 concrete silent drop (224/359 = 62%)** — and 309 preset taps *literally name* motion graphics in their text. Consistent with the recon's MG-density finding (63% of jobs carry zero MGs). This is the largest single fulfillment lever that is pure quality work (the family exists and renders).
- **zoom is fine (77% honored)** — the v1 run said 88% dropped; that was an evidence-extraction defect (see CORRECTION below). The corrected number moves zoom from "top problem" to "working".
- **sound_effects (35% dropped) and text_overlay (71% dropped)** are the next concrete levers.
- The **unsupported block** (color_grade 118, generative_ai 99, music 82, voiceover 42, aspect 55) = 396 asks = 10.5% of all demand, almost never covered by a note (d-note column ≈ 0–8).
- `captions` is the best-fulfilled specific class (79% honored) — the one place notes actually fire (20).

## Top 20 most-dropped asks (silent + unsupported) — the capability lane's input
123× "viral engaging video" (style, lean-route drops) · 88× + 39× motion graphics · 39× add zooms · 36× + 27× sound effects · 32× "make this a smooth video" · 24× "professional corporate style" · 19× "clean and engaging edit" · 4× cinematic lighting · 4× background music · 3× captions in hindi · 3× smooth/elegant transitions · 3× "highlight the strongest hook in the first 3 seconds" · 3× 4k resolution.

## Calibration `[MEASURED]`
30-judgment stratified hand-check (custom-heavy 2:1) before the full run: **93.3% verdict-level agreement** (28/30; gate ≥90%). Both misses were conservative-direction (one content-description wrongly credited as honored; one "8k" classed UNSUPPORTED instead of DROPPED_SILENTLY — both rubric lines tightened before the full run). Class-level agreement 90%.

## CORRECTION LOG (the measurement discipline, on the record)
- **v1→v2:** v1 read zoom evidence from `emphasis_moments[].zoom`; the real key on full-editorial recipes is `cuts[]._zoom_effect` (`[MEASURED]` 17/18 recent full recipes carry it; 0 carry the emphasis key). v1's zoom drop rate (88%) was an artifact; 823 affected jobs re-judged ($3.10); headline moved 39.2% → 35.1%. Surfaced by the report's own impossible number against the recon's zoom-usage data.
- **Recipe location moved 2026-08-04** `[MEASURED]`: recipes ≤08-03 live in the `edit_recipe` column; ≥08-04 in `result.edit_recipe`. The brief's "1,286 rows carry a recipe" was computed on the stale column — the true back-catalog is ~3,700. The judge coalesces both locations now.

## Coverage + known limits (stated plainly)
- Judged: all 1,282 column-era recipe jobs + the 325 jobs since 2026-08-09. **NOT yet judged: ~2,130 jobs from 08-04→08-08** (the relocation-era gap) — ≈ **$8 additional LLM spend, needs approval** (would exceed the $10 cap). The daily cron judges everything new from here.
- This reads **recipe JSON, not pixels** — an honored plan that renders badly still counts as honored; a defect harness (Lane 2) owns that half.
- "Unsupported" ground truth is the known 6-item list; novel unsupported asks land in DROPPED_SILENTLY.
- Preset-style asks (40% of traffic) are near-always honored by construction; that is why the CUSTOM cut (35.8% silent) is the honest headline.

## Where it lives
Per-job judgments: `out/fulfillment_scores.jsonl` (1,607 rows, job_id-deduped, version-stamped) → `fulfillment_scores` table via `scripts/load-scores-to-table.js` once TRUTH applies the migration. Daily: the `daily-scoreboard` cron judges yesterday's completions and writes honor + dropped-silently into `daily_scoreboard`.
