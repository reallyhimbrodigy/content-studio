# Promptly — standing rules for agents (frontend + backend)

These are hard rules for how we analyse, report, and ship during the surge. They
override default habits. Read them before reporting any metric or declaring any
failure.

## Rule 7 — Cut by USER before declaring a systemic failure. Count failures PER AFFECTED USER, not per job.

A user who fails five times and gives up is **one lost user, not five failures.**
Per-job counting inflates every error class by the retry multiplier — which is
exactly what made a one-user bug look like a 67% outage.

- **Always compute distinct affected users, and lead the report with that number.**
  Report both (jobs and users) but the user count is the headline.
- **Before escalating a class as "systemic," check the top-user share.** If one
  user is ≥50% of a class's occurrences, it is a per-user issue (their clip / their
  network / their retries), not an outage — investigate that user's input, do not
  revert infra.
- A "wave" of N job failures at shifting call-sites is usually **one user's clip on
  retry**, not a moving infrastructure bug.

**Precedent (one night):** RENDER_FFMPEG "wave" = 1 user (4 retries, call-site
shifted scdet→loudness across that one user's retries). RENDER_FATAL 4-of-5 = 1
user. UPLOAD_STALLED 5-of-6 = 1 user. Three classes, three single users — each read
as an outage under per-job counting.

## Companion rules (also standing)

- **Every fix ships with a check that makes its regression impossible** — a gate
  assertion, a fingerprint, a cert. Not a note, not a comment. If you cannot name
  the check, the fix is not finished. (e.g. `lib/__smoke_event_allowlist.js` makes a
  silently-dropped analytics event impossible at deploy.)
- **Nothing is "done" until observed working on real traffic with a stated
  denominator.** Built ≠ committed ≠ deployed ≠ working. Report a zero only with
  what it is zero *out of*.
- **A metric that reads 0/empty across a wide window is a failed read until proven
  otherwise** — verify the pipe (newest row, direct count, a raw 200) before
  concluding an outage or a recovery. (A Supabase REST 503 once made every class
  read 0 and looked like "editorial recovered.")
- **Route-cut every cost/latency read** — editorial (`route=None`) is the headline;
  light routes are a secondary line. Fit e2e ≈ FIXED + SLOPE·duration (two terms),
  never a single ratio.
- **A gate enumerates what is FORBIDDEN, and checks it everywhere. It never
  enumerates where to look.** A gate scoped to a list of known locations proves
  something only about the locations you remembered — it reports green about the
  part it happened to check, which is indistinguishable from a real pass. Derive
  the forbidden set from the source of truth, then apply it to the whole tree, so
  a surface written tomorrow is covered by a gate written today.
  *Paid for three times in one week, each time by a gate that was "passing":*
  `benefits-parity` governed four named paywall surfaces and passed while a fifth
  (`SecondPaywallView`) still spelled its own copy of a claim — found by a manual
  sweep, not the gate. `__smoke_event_allowlist` compared client emits against
  whichever `server.js` happened to be in the working tree. Its regexes were
  `[a-z_]+`, so every event name containing a digit was checked on *neither*
  side and `onboarding_v2_step` was never validated at all.
  Corollary: **a gate that cries wolf is worse than no gate** — it trains you to
  skim past it, and the real finding drowns in the noise. When a check cannot be
  made precise, delete it and ask a tool that can answer exactly (the compiler,
  the database) instead of shipping a heuristic that is wrong five times in six.

## A verdict path pins its temperature AND ledgers its verdict (2026-09-20)

**Any model call that produces a VERDICT runs at `temperature: 0`, and ledgers
the verdict beside a hash of its input.** Both halves, because they do different
jobs: the pin PREVENTS drift, the ledger MEASURES it. A pinned call with no
ledger is deterministic and unfalsifiable.

**How it was found.** Temperature was never set anywhere, so every classifier ran
at the default 1.0. The same brief returned `unsafe` true, true, false, false,
true across five runs. Every number quoted off that path — 99 dark decisions, a
hand-checked false-positive rate, a flip gate set at 5% — was **one sample of a
distribution rather than a measurement**, and the classifier's own run-to-run
variance was larger than the bar it was being judged against.

**The tell is the expensive part.** A fixture that passes, then fails, then
passes with no edit in between reads as flakiness in the HARNESS, so it is
re-run rather than investigated. On a ROUTING path it is worse: a verdict that
flips between `converse` and `act` fails nothing — the user gets a plausible
reply either way and the only trace is a support message saying "it ignored me".
There is no red leg to re-run because there is no red. That is why the ledger is
not optional.

**Write the leg, not just the fix.** A static leg over the verdict-producing
files found two more unpinned call sites the moment it existed — including the
fulfilment judge, which decides the HONORED / DROPPED_SILENTLY numbers the lane
reports. The symptom was found in one file; the class lived in four.

**N IDENTICAL VERDICTS IS NOT A SUFFICIENT ASSERTION.** Every early return is
deterministic by construction: a disabled flag, a missing key, a transport
failure, a cache hit. With no key an eight-run leg sees eight identical nulls
and prints PASS on a path that **never reached the model** — "deterministic" and
"never ran" are the same eight values. A determinism leg needs three assertions:
the run REACHED the model, the verdicts are IDENTICAL, and they are CORRECT, so
that stable-and-wrong fails too. (Found by FRONTEND, who hit it and said so; my
own leg had the identical hole.)

**A verdict without its input is not a measurement.** The only agentic record
ever scored was judged at temperature 1.0, and its run record no longer exists
anywhere — so it can never be re-scored or checked. It is excluded from the
scoreboard rather than counted, and the line reads ABSENT. A hash would not have
saved the input, but it would have said WHICH input, and that the verdict
predates the pin.
