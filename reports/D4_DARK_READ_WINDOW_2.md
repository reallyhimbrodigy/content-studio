# The second dark read: the window does not exist yet, and looking for it found two things

**Builder 2, 2026-09-20 ~22:15Z.** Read-only against `negotiation_decisions`.

## The headline: I cannot deliver this tonight, and reporting it anyway would be the contaminated-window error

`5800071` was committed 2026-09-20 20:53:25Z and the ledger puts its deploy
between **20:46:07Z and 21:12:44Z** — derived from the data, not assumed (see
the boundary marker below). At 22:12Z the post-deploy cohort is **6 rows**.

| cohort | n | window |
|---|--:|---|
| A — before `5800071` | 101 | 2026-09-19 17:26Z → 2026-09-20 20:46Z |
| B — after `5800071` | **6** | 2026-09-20 21:12Z → 22:12Z (1h 00m) |

A 24-hour read from `5800071` opens **2026-09-21 ~21:00Z**. A false-positive
rate on six rows carrying one actioned verdict is not a rate, and a 24-hour
window that spans the deploy is the exact cohort contamination Rule 5 exists to
forbid. **The flip stays gated — not because FP is high, but because there is
no denominator yet.** Nothing about this is a reason to flip early.

## `decider='regex'`: 0 of 107 — and it is NOT decorative

Across the full life of the table, every one of 107 rows is `decider='model'`
and `flag_state='DARK'`. Two windows now agree: the regex has refused nothing,
ever. `degraded` is also **0 of 107**, and that second zero is what changes the
answer.

The regex is not a competing classifier. It is the **early refuse**, and the
code is explicit that when the adjudicator is unreachable dispatch PROCEEDS —
so during a model outage the regex is the only thing between an obviously
unsafe brief and the editor. Its zero means *the outage has not happened*, not
*it does nothing*. Deleting it would remove the whole safety floor from the one
case it was built for.

So it stays. But an unexercised fail-closed path is a promise, not a property —
0 production hits AND no test anywhere drove it — so it now has one.

**`scripts/fulfilment/smoke_regex_backstop.js`**, 7 legs, £0/$0 of API spend
(every leg passes `apiKey: ''`, which returns `REVIEW_UNAVAILABLE` before any
network call), and **no unsafe text in the fixture**: the probe is rebuilt from
the shipped pattern at runtime, verified to match, and never printed or stored.

RED-proved three ways, each biting only what it should:

| mutation | result |
|---|---|
| the early-refuse branch removed | unsafe brief now **PASSES**, `by=model unsafe=null` — 4 of 7 fail |
| the outage alert renamed | only the alert leg fails — 1 of 7, exit 1 |
| the probe extraction blinded | **HARNESS FAILURE, exit 2** — not a silent green |

The third matters most: a probe that quietly stopped matching would leave leg 1
vacuous while still reading green.

## What the deploy changed without saying so: the `language` vocabulary

This is the boundary marker, and it is mine.

| rows | `language` reads |
|---|---|
| 101 before the deploy | `English`, `Urdu`, `French`, `Bengali`, … — free-text NAMES |
| 6 after the deploy | `en`, `en`, `en`, `en`, `en`, `en` — ISO-style CODES |

The old safety schema declared `language: {type:'string', description:'the
language the request is written in'}` and the model answered in prose. The
single classifier wires `language: adj.typed_in` (three sites), and `typed_in`
is documented with a list of codes. **I caught that renaming the KEY would write
NULL to the field ruling 2 depends on, and fixed that. I did not notice that the
VALUE vocabulary changed underneath it.** Same class, one level down: the reader
still works, and every by-language cut across the boundary now splits one
language into two buckets. The dark read stratifies by language, so the
instrument I was asked to re-run is what this breaks.

**And the documented list does not match the traffic.** It names
`en, pt, id, ru, ja, ko, nl, hi, hi-Latn, ta-en, es, ar, zh, mixed`. Against 101
rows of real briefs:

* **not in the list, but seen:** French 2, Persian 2, Bengali 1, Hebrew 1,
  Polish 1, Turkish 1, Urdu 1 — **9 rows, 8.9% of traffic in three days**
* **in the list, never seen:** `id`, `ja`, `ko`, `nl`, `zh`, `ta-en` — six

The list was written from assumption rather than from this table. It carries six
languages nobody has typed and omits seven that people did, including the
Bengali brief the model refused in the first window — the single best piece of
evidence that the model beats an English pattern.

**Bounded honestly:** `typed_in` is `{type:'string'}`, NOT a hard enum, so the
model is not forced into a wrong bucket and can emit an unlisted code. The prose
list is a strong prior, not a gate. And there is **no post-deploy non-English row
yet**, so what the model actually emits for an unlisted language is PREDICTED,
not measured. It is the first thing the real 24-hour window should answer.

## Two more readings, one of which I nearly reported as a regression

**Verdicts, all 107:** PASS 76 · NEGOTIATE 26 · REFUSE 5.

`classes` and `sentence` are populated on 26 rows and empty on 81 — and all 26
are exactly the NEGOTIATE rows, which is correct: only a negotiation names what
it is negotiating. Post-deploy that count is 0 of 6, which looks like the single
classifier having stopped emitting them. **It is not.** NEGOTIATE last fired at
**17:01Z, four hours before the deploy**, so the drought starts in cohort A and
is not attributable to `5800071`. Had I cut only at the boundary I would have
filed a deploy regression that the data does not support. It is worth watching
in the real window, not reporting now.

**Every REFUSE carries no class and no sentence** — 5 of 5. A refusal is
therefore a verdict with no recorded reason. Storing the refusal CLASS is not
storing the unsafe text, and without it a refusal cannot be audited at all.
Raised, not changed.

## What is actually owed tomorrow

1. Re-run this read at **2026-09-21 ~21:00Z** on cohort B alone, stratified by
   class and by language, hand-check 20, report FP on actioned verdicts.
2. Answer what `typed_in` emits for a language outside the documented list —
   the first non-English post-deploy row settles it.
3. Decide the `language` vocabulary: the codes are the better choice, so the
   fix is to declare the boundary and normalise cohort A for any by-language
   read, not to revert.
