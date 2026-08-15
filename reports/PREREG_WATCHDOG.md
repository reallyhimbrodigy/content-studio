# PRE-REGISTRATION — how the watchdog's own output will be read

**JUDGE, 2026-08-15. Written BEFORE the watchdog ships, so its first numbers
cannot be interpreted to suit whatever they turn out to be.**

The watchdog is a progress-aware killer: it terminates a job whose frames stop
advancing, rather than waiting for the platform timeout. It is being built to
act on the class decomposed in `HANG_TEST_RESULT.md`.

## THE BASELINE IT MUST BE READ AGAINST — fixed now

From the frozen window (n=464 completions, 08-11T23:00Z →):

| quantity | value |
|---|---|
| affected (envelope-absent or repair) | **182 = 39.2%** |
| 180–240s cluster (`reconciler`) | **40 = 22%** of affected |
| 870–930s cluster (`repair`) | **25 = 14%** of affected |
| repair jobs | **25 over ~3 days ≈ 8/day** |

## PREDICTION — the firing rate that CONFIRMS the class

The watchdog should fire on jobs that genuinely stall. If the ~900s cluster is
a stall bounded by the platform timeout, a progress-aware killer must catch it
*earlier* and *at a comparable rate*.

| firing rate (per 100 completions) | reading |
|---|---|
| **5–15%** | **CONFIRMS.** Matches the affected class's stall-shaped subset (the repair cluster alone is ~5.4% of completions; both clusters ~14%). The watchdog is finding the thing it was built for. |
| **>25%** | **OVER-FIRING.** It is killing healthy long jobs. Premium/6-scene renders legitimately run long; a watchdog that cannot tell a slow render from a stalled one converts a latency problem into a *failure* problem, which is strictly worse. **Revert, do not tune in place.** |
| **1–5%** | **PARTIAL.** Catching some stalls, missing most. Report as partial; do not claim the class. |
| **~0%** | **See below — this is the dangerous one.** |

## A SILENT WATCHDOG — pre-registered meaning, because this is the read most likely to be misused

**A watchdog that never fires does NOT mean "no stalls." It has three parents
and they are not distinguishable from the firing rate alone:**

1. **The class genuinely stopped** — some other fix (CAS, the predicate) removed
   the stalls before the watchdog shipped.
2. **The watchdog is mis-armed** — wrong threshold, wrong signal, never actually
   reached the code path. It is a new instrument and has never fired *once*.
3. **The watchdog is dead** — deployed but inert, the "shipped but never ran"
   class this project has hit repeatedly (the BOOLEAN preview column, the
   unmounted editor, the reader with no writer).

**Binding rule: silence is NOT a result until the same-run known-bad has fired.**
Per the standing guard, a zero is only believed when a control proves the
detector was live in the same window. For this instrument that means:

> **Before any silent period is reported as "no stalls", a deliberately stalled
> job must be shown to be KILLED and COUNTED by the watchdog.** Until that probe
> fires, a silent watchdog is reported as **[UNVERIFIED-ZERO — the watchdog may
> simply be dead]**, never as evidence the class is gone.

Corroborating checks that must accompany any silence claim, because they are
independent of the watchdog's own health:
- the **repair count** (if repairs continue while the watchdog is silent, the
  watchdog is missing them — that is mis-armed, not healed);
- the **870–930s band population** (independent of any stamp);
- the **envelope-absent rate** (39.2% baseline).

**If repairs continue and the watchdog is silent, the verdict is MIS-ARMED, and
that is the single most likely failure mode for a new instrument.**

## WHAT THE WATCHDOG CANNOT SETTLE

It acts on the ~900s cluster. **It says nothing about the 180–240s cluster**,
which is the *larger* mode (22% of affected vs 14%) and settles via `reconciler`
without ever reaching a platform timeout. A watchdog that works perfectly still
leaves the bigger half of this class untouched. **Do not read watchdog success
as resolution of the envelope-loss class.**

## THE QUALIFIER, attached here as everywhere

**Users receive their video on both paths today.** The watchdog's prize is cost,
telemetry and tail latency — not recovered deliveries. If it ships and works,
the correct claim is "the tail shortened and orchestration seconds were
returned," never "users stopped losing renders." They were not losing them.
