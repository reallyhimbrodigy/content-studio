# SENTINEL PROOF — all three, fired on their known-bad windows

**JUDGE, 2026-08-11. Standing law: no green is believed until the probe fires
on the bad window. Every row below is [MEASURED], re-runnable, $0.**

## 1. route_collapse — PROVEN both directions

`node scripts/scoreboard.js --backtest 2026-08-05 2026-08-11`

| day | verdict |
|---|---|
| 08-05, 08-06, 08-07 | clean (no false positive) |
| 08-08 → 08-11 | 🚨 `route_collapse:moodreel` |

Fires on exactly the day the Vertex outage began (moodreel's last completion
08-08T11:18Z) and every day since. Silent on the three healthy days before it.

### A defect I found in my own instrument, fixed

The backtest output itself exposed it: the baseline printed **24% → 23% → 21%
→ 20%** across the four outage days. The baseline is a trailing 7-day window,
so a sustained outage erodes the very reference the alarm compares against —
and at the 5% flag threshold **the alarm goes silent while the outage is still
running** (certain by ~08-15, when the whole trailing window is outage days).
An alarm that forgets what healthy looked like reports green on the exact
failure it exists to catch.

**Fix:** compare against `max(trailing, FROZEN_HEALTHY_REFERENCE)`. The freeze
is [MEASURED] over 08-01 → 08-08T11:00Z (n=2,616 completions, the last
known-good week): std 44.8%, minimal_speech_uncut 24.6%, moodreel 24.5%,
minimal 4.1%, hype 2.0%. Post-fix backtest is unchanged on the clean days and
now holds moodreel's baseline at a stable **25% (frozen-healthy)**.

**Known limit, stated:** `hype` at 2.0% sits below the 5% threshold, so its
collapse is NOT independently flagged — moodreel carries the premium-route
signal. Raising sensitivity for a 2% route would trade real alerts for noise;
the honest reading of a `route_collapse:moodreel` alert is "the premium path
is down", which covers both.

## 2. chat liveness — PROVEN both directions

`scripts/chat-liveness-alert.js` — successful chats == 0 while successful
renders > 0 (the control that rules out a quiet night or a failed read).

| day | chat | render (control) | verdict |
|---|---:|---:|---|
| 2026-07-15 | 0 | 1 | 🚨 would fire |
| 2026-08-01 | 0 | 163 | 🚨 would fire |
| 2026-08-05 | 581 | 241 | healthy |
| 2026-08-09 | 0 | 282 | 🚨 would fire |
| 2026-08-10 | 0 | 271 | 🚨 would fire |
| 2026-07-01 | 0 | 0 | inconclusive — correctly no alarm |

Live run today: `chat=2 render=166 → HEALTHY`. Note 08-09/08-10 were dark too
(the second, Gemini-key outage), and chat recovered on 08-11 — the sentinel
would have caught that four-day window on day one.

## 3. volume_collapse + completion_rate_drop — armed, correctly silent

Both live in `computeSentinel` (thresholds: day volume <40% of trailing mean
with a ≥20/day floor; completion rate ≥15 points below trailing). Neither
fired across 08-05→08-11 — correct: volume held (170–280 jobs/day) and
completion rate never dropped 15 points. **Not yet proven on a bad window** —
there is no volume-collapse day in the available history to fire them against.
Stated as [UNPROVEN-DIRECTION] rather than counted as green; the first real
volume event is their test, and I will report it as the proof when it comes.

## Wiring status

All three run today from this branch. The `sentinel` / `outage` columns that
carry them onto the board are **still pending** the owner's
`20260811_daily_scoreboard_v2.sql`; until it lands the backtest command above
is the read.
