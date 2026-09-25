'use strict';
// THE SWEEP'S STATUS LIST, THE INDEX'S PREDICATE, AND THE TABLE'S CHECK
// CONSTRAINT MUST NAME THE SAME SET.
//
// sweepAgentic selects `status IN ('queued','processing')` — a POSITIVE list —
// and it is only correct because video_jobs.valid_status closes the domain:
//
//   CHECK (status = ANY (ARRAY['queued','processing','completed','failed',
//                              'canceled','needs_input']))
//
// Four of those six are terminal, so "not terminal" and "queued or processing"
// are the same set. That equivalence is what lets the query use the partial
// index idx_video_jobs_agentic_inflight, which took one sweep from 39 shared
// buffers to 2.
//
// ── WHY THIS LEG EXISTS ──────────────────────────────────────────────────
// Add a SEVENTH status to the constraint without adding it here and the sweep
// silently stops collecting those jobs. They never get terminalized, never
// reach the customer, and nothing errors — the row simply sits in-flight
// forever while the sweep walks past it. That is the failure this repo keeps
// paying for: a narrowing that is correct today and becomes a silent hole the
// day the domain moves.
//
// ── WHAT IT CAN AND CANNOT CHECK ─────────────────────────────────────────
// It CANNOT read the live constraint: the deploy gate runs on Render at build
// time with no database, and a leg that needs one would fail the DEPLOY rather
// than catch a defect. So the constraint is recorded here as a MEASURED
// fixture — read from pg_constraint on 2026-09-25 — and the leg asserts the
// three lists agree with it. If someone changes the constraint, this stays
// green until they update the fixture; the honest claim is that it pins the
// ASSUMPTION where a reader will see it, not that it observes the database.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const strip = require('./__gate_strip').stripComments;

// MEASURED: pg_constraint on video_jobs, valid_status, 2026-09-25.
const DOMAIN = ['queued', 'processing', 'completed', 'failed', 'canceled', 'needs_input'];
const TERMINAL = ['completed', 'failed', 'canceled', 'needs_input'];
const INFLIGHT = ['queued', 'processing'];

// S1: the fixture is internally consistent — in-flight and terminal partition
// the domain. A leg whose own constants disagree proves nothing about the code.
assert.deepStrictEqual([...INFLIGHT, ...TERMINAL].sort(), [...DOMAIN].sort(),
  'S1: INFLIGHT + TERMINAL must partition the recorded domain exactly');
assert.strictEqual(INFLIGHT.filter((s) => TERMINAL.includes(s)).length, 0,
  'S1: a status cannot be both in-flight and terminal');

// ── SCOPE: THE SWEEP'S QUERY, NOT THE FILE ───────────────────────────────
// The first writing of S3 scanned the whole module and fired on _terminalize,
// which uses the denylist CORRECTLY: it is a guarded UPDATE on a single row by
// primary key — a compare-and-set that must not overwrite a terminal state,
// whatever "terminal" means — and it does no scanning, so no index is
// involved. A pattern tight enough to reject a correct implementation is not a
// check; it is a style rule that gets someone to "fix" working code. So every
// leg below reads the sweep's own function body.
const src = strip(fs.readFileSync(path.join(__dirname, 'agentic-dispatch.js'), 'utf8'));
const _from = src.indexOf('async function sweepAgentic');
assert.ok(_from >= 0, 'S0: sweepAgentic must exist — this leg is aimed at its query');
const _to = src.indexOf('\nasync function', _from + 10);
const sweep = src.slice(_from, _to > _from ? _to : src.length);
assert.ok(sweep.includes(".from('video_jobs')"),
  'S0: the sweep body must contain its video_jobs read, or this leg is reading the '
  + 'wrong region and asserts nothing');

// S2: the sweep selects the in-flight list, positively.
const m = sweep.match(/\.in\('status',\s*\[([^\]]*)\]\)/);
assert.ok(m, 'S2: sweepAgentic must select status with a positive .in([...]) list — '
  + 'a .not(...in...) form CANNOT use idx_video_jobs_agentic_inflight (measured: '
  + '39 buffers vs 2), because Postgres cannot prove the implication without the '
  + 'CHECK constraint');
const selected = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
assert.deepStrictEqual(selected, [...INFLIGHT].sort(),
  `S2: the sweep selects [${selected}] but the in-flight set is [${[...INFLIGHT].sort()}] — `
  + 'a status the sweep does not select is a job that is never collected and never '
  + 'terminalizes, silently');

// S3: the OLD denylist form must not come back. It is not merely slower — it
// reads identically and quietly stops using the index.
assert.ok(!/\.not\('status',\s*'in'/.test(sweep),
  'S3: the denylist form is back IN THE SWEEP. It returns the same rows and drops '
  + 'the index, which is the kind of regression nothing else here would notice. '
  + '(_terminalize uses the denylist correctly — a CAS on one row by id — and is '
  + 'deliberately outside this leg.)');

// S4: the migration's index predicate names the SAME statuses. Two places that
// must agree, and only one of them is code.
const mig = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '20260925_agentic_sweep_partial_index.sql'), 'utf8');
const idx = mig.slice(mig.indexOf('CREATE INDEX'));
const inIdx = [...idx.matchAll(/'([a-z_]+)'::text/g)].map((x) => x[1]);
for (const s of INFLIGHT) {
  assert.ok(inIdx.includes(s),
    `S4: '${s}' is in the sweep's list but not in the index predicate in `
    + 'migrations/20260925_agentic_sweep_partial_index.sql — the index would not '
    + 'cover a row the sweep asks for');
}

console.log('[smoke] agentic sweep statuses: PASS (the sweep selects the positive in-flight '
  + `list [${INFLIGHT}], it partitions the recorded valid_status domain with the four `
  + 'terminal values, the denylist form is refused, and the migration\'s index predicate '
  + 'names the same statuses)');
process.exit(0);
