# PRE-REGISTRATION — the hang test

**JUDGE, 2026-08-15. WRITTEN AND COMMITTED BEFORE THE QUERY IS RUN.** Thresholds
are fixed here so no post-hoc reading can move one.

## Honest starting position — this is NOT a blind pre-registration

I already know three things, and pretending otherwise would be the dishonest
version of this exercise:

- envelope loss runs ~39–46% of completions [MEASURED];
- the `repair` class clusters tightly at **901–907s**, with one at 1172s;
- envelope-LOST jobs carry a **148.9s queue p50** against FULL's 10.0s, and the
  queue/envelope relation is a near-step at 15–30s.

So this test is not "is something wrong" — it is **"is ONE mechanism producing
the cost, telemetry and latency damage simultaneously, or are these three
separate diseases that merely co-occur?"** That is the discriminating question,
and it is worth pre-registering because the re-ranking that follows a
confirmation is large.

## THE HYPOTHESIS

**A single hang** — a blocking call that holds the orchestrator — causes all
three at once:

| axis | mechanism if the hang is real |
|---|---|
| **cost** | the orchestrator container is held, billing at cpu=16 for the hang's full duration |
| **telemetry** | the envelope write never lands (or lands and is lost), producing envelope-absent rows |
| **latency** | delivery waits out a timeout instead of completing, producing the ~900s band |

## PREDICTION 1 — the shape of the lifetime distribution

Measured over affected jobs (envelope-absent completions + repair-class):

- **A ~900s MODE ⇒ CONFIRMS a timeout-bounded single mechanism.** A hang that
  runs until something kills it produces a *spike* at the killer's value, not a
  spread. **Threshold: ≥30% of affected jobs inside 870–930s.** For scale, a
  uniform spread over 0–1800s would put ~3% there, so 30% is ~10x uniform.
- **A FLAT distribution ⇒ REFUTES the single-mechanism reading.** If no 60s band
  holds >15% of the mass, there is no common killer, and the class is several
  different failures that happen to share an outcome. In that case the correct
  action is to **decompose before ranking**, not to file one lever.
- **Between 15% and 30% in-band ⇒ AMBIGUOUS** — a partial mode. Report as
  "mixed population, at least one timeout-bounded component," and do not
  re-rank on it.

## PREDICTION 2 — the completions-to-envelope-write ratio, at n ≥ 100

Among completions in the window, the fraction whose envelope actually landed
(`result.stage_timings.total` present):

- **≤50% ⇒ CONFIRMS** the write is being prevented at scale.
- **≥90% ⇒ REFUTES** — if nearly every completion writes its envelope, no write
  is hanging and the envelope-absent rows have some other origin.
- **50–90% ⇒ the honest middle**: a real but partial effect. Report the rate and
  the trend; do not call it a single mechanism.

**Denominator floor: n ≥ 100 completions.** Below that the test does not run and
the answer is NOT-YET-READABLE, never a verdict.

## PREDICTION 3 — the three axes must co-occur *in the same jobs*

The weakest link in a "one lever" claim is that three problems co-occurring in a
*window* is not the same as co-occurring in a *job*. **Registered requirement:
the affected set must be one set, not three overlapping ones.** Specifically the
jobs in the ~900s mode must be substantially the same jobs that are
envelope-absent — **≥70% overlap**. Below that, these are separate diseases
sharing a window and the single-lever framing is wrong regardless of what
predictions 1 and 2 say.

## IF IT HOLDS — the re-ranked board

If 1, 2 and 3 all confirm, the hang becomes **the single largest lever on the
board across three axes simultaneously**, and the board is re-ranked to say so:

- **cost** — it burns orchestration, the 72.3% slice, which is where L1/L2 also
  act. The two levers then compete for the same seconds and must be sequenced,
  not summed.
- **telemetry** — it is the cause of envelope-absent, which currently corrupts
  ~39–46% of completions and is why `result`-derived cost figures had to be
  abandoned for in-run measurement.
- **latency** — it is the ~900s band, i.e. the entire remaining p99 tail.

**And the honest qualifier that must ride with it: the `repair` path has already
banked the user-facing half.** Users on the affected path do get their video —
repair reconstructs the completion from the S3 artifact. So the outstanding
damage is **cost + telemetry + tail-latency**, not lost deliveries. A re-ranked
board that implies users are currently losing renders would be overstating a
class that is, from the user's seat, already mitigated.

## IF IT DOES NOT HOLD

Publish the refutation with the same prominence. A flat distribution or a ≥90%
write ratio means I have been treating three separate problems as one, and the
correct next step is decomposition — not a lever.
