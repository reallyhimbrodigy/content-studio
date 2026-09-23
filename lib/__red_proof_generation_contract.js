#!/usr/bin/env node
'use strict';
// RED PROOF — the generation contract's two RULED shapes (2026-09-23).
//
// Each mutation makes ONE property false and must turn EXACTLY ONE leg red,
// by name. Three guards, each earned:
//
//   ANCHOR COUNT   a refactor that moves the target leaves the mutation
//                  editing nothing; `count !== 1` is a HARNESS FAILURE, never
//                  a quiet pass.
//   PRECONDITION   a mutation that WEAKENS something must be shown to have
//                  something to weaken — removing an empty filter is a no-op
//                  that reads exactly like a blind check.
//   NAMED RED      a non-zero exit is not evidence: a mutant that crashes or
//                  stops parsing also exits non-zero and exercises no leg at
//                  all. The leg's own name must appear in the FAIL line.
//
// The backup is IN MEMORY — never a /tmp path shared by every branch on the
// machine — and the tree is checked for residue after every mutation, because
// an in-memory backup does not survive a kill either.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, 'generation-quotes.js');
const SMOKE = path.join(__dirname, '__smoke_generation_quotes.js');

const MUTATIONS = [
  {
    leg: 'L11 batch_returns_job_clip_pairs',
    why: 'the bare ordered array comes back, so the client has to INFER which '
       + 'clip each job belongs to — the inference nothing in the payload can '
       + 'contradict',
    old: `return {
    jobs: clip_ids.map((c) => ({ job_id: byClip.get(c), clip_id: c })),
    balance,
  };`,
    new: 'return { job_ids: jobs.map((j) => j.job_id), balance };',
    pre: (g) => {
      const r = g.batchResponse({
        clip_ids: ['a', 'b'],
        jobs: [{ clip_id: 'b', job_id: 'jb' }, { clip_id: 'a', job_id: 'ja' }],
        balance: 0 });
      // The pairing must actually do something on a shuffled input, or the
      // mutation is byte-different and behaviourally identical.
      return JSON.stringify(r.jobs)
        === JSON.stringify([{ job_id: 'ja', clip_id: 'a' }, { job_id: 'jb', clip_id: 'b' }]);
    },
  },
  {
    leg: 'L12 batch_missing_pair_refuses_rather_than_shortens',
    why: 'a partial batch quietly omits a clip the user was charged for',
    old: "if (missing.length) return { error: 'dispatch_incomplete', missing };",
    new: 'if (missing.length) return { jobs: clip_ids.filter((c) => byClip.has(c))'
       + '.map((c) => ({ job_id: byClip.get(c), clip_id: c })), balance };',
    pre: (g) => g.batchResponse({ clip_ids: ['a', 'b'],
      jobs: [{ clip_id: 'a', job_id: 'ja' }], balance: 0 }).error === 'dispatch_incomplete',
  },
  {
    leg: 'L13 idempotency_key_is_the_upload_key',
    why: 'the endpoint picks a winner when header and body disagree instead of '
       + 'refusing — both spellings are well-formed keys, and the wrong one '
       + 'just makes a second clip',
    old: "if (upload_key !== undefined && upload_key !== null && String(upload_key) !== h) {",
    new: 'if (false) {',
    pre: (g) => g.pickedKey({ header: 'u1', upload_key: 'u2' }).error === 'idempotency_key_mismatch',
  },
  {
    leg: 'L14 same_key_within_the_window_starts_no_second_import',
    why: 'the 30-minute window stops applying, so the second tap imports again',
    old: "if (age <= PICK_TTL_MS) return { status: 'reused', start_import: false, http: 200 };",
    new: "if (age <= 0) return { status: 'reused', start_import: false, http: 200 };",
    pre: (g) => g.pickedClipDecision({ inserted: false,
      created_at: new Date(1000).toISOString(), now: 1000 + 60000 }).start_import === false,
  },
  {
    leg: 'L15 every_outcome_is_200',
    why: 'a 201-for-new / 200-for-existing split, which makes a retry after a '
       + 'dropped response look different from the original',
    old: "if (inserted) return { status: 'created', start_import: true, http: 200 };",
    new: "if (inserted) return { status: 'created', start_import: true, http: 201 };",
    pre: null,   // INJECTS a defect; new material cannot be vacuous this way
  },
  {
    leg: 'L16 unreadable_created_at_fails_loudly',
    why: 'an unreadable created_at falls silently to one side — here, stale, '
       + 'which imports the same upload twice',
    old: "if (!(age >= 0)) return { error: 'unreadable_created_at', created_at };",
    new: 'if (false) { }',
    pre: (g) => g.pickedClipDecision({ inserted: false, created_at: undefined,
      now: 1000 }).error === 'unreadable_created_at',
  },
  // ── THE CRASH MATRIX ─────────────────────────────────────────────────
  {
    leg: 'L17 crash_a_claimed_uncharged_resumes_at_the_charge',
    why: '(a) a claimed, uncharged quote routes to replay — the retry waits '
       + 'on a first result that was never produced, which is the hang the '
       + 'case exists to prevent',
    old: "    if (!charged) return { action: 'charge', why: '(a) claimed, never charged — resume at the deduct' };",
    new: "    if (!charged) return { action: 'replay', why: '(a) claimed, never charged — resume at the deduct' };",
    pre: (g) => g.recoverQuote({ state: 'claimed', charged_at: null, job_id: null }).action === 'charge',
  },
  {
    leg: 'L18 crash_b_charged_without_a_job_is_detected_and_resumed',
    why: '(b) charged-with-no-job refunds instead of resuming, turning a '
       + 'delay into a cancellation the user did not choose',
    old: "    if (!hasJob) return { action: 'resume_job', why: '(b) charged with no job — build it, refund only if it cannot be built' };",
    new: "    if (!hasJob) return { action: 'replay_refund', why: '(b) charged with no job — build it, refund only if it cannot be built' };",
    pre: (g) => g.recoverQuote({ state: 'claimed', charged_at: 'x', job_id: null }).action === 'resume_job',
  },
  {
    leg: 'L19 crash_c_rc_422_releases_the_claim',
    why: '(c) a 422 leaves the claim in place: not charged so nothing to '
       + 'refund, not open so no confirm can ever succeed — a quote the user '
       + 'can neither spend nor recover, and nothing about it looks broken',
    old: "    return { charge: 'NOT_CHARGED', next: 'release', release_to: 'open' };",
    new: "    return { charge: 'NOT_CHARGED', next: 'hold' };",
    pre: (g) => g.chargeOutcome({ ok: false, status: 422 }).next === 'release',
  },
  {
    leg: 'L19b an_unknown_charge_holds_rather_than_guessing',
    why: 'UNKNOWN is folded into NOT_CHARGED, so a timeout after a successful '
       + 'deduct releases the claim and the next confirm charges again',
    old: "  if (status === 422) {",
    new: "  if (status !== 999) {",
    pre: (g) => g.chargeOutcome({ ok: false, status: 503 }).charge === 'UNKNOWN',
  },
  {
    leg: 'L20 crash_d_refunded_replays_and_never_recharges',
    why: '(d) a refunded quote routes back to a charge',
    old: "    return { action: 'replay_refund', why: '(d) refunded — say so, never re-charge' };",
    new: "    return { action: 'charge', why: '(d) refunded — say so, never re-charge' };",
    pre: (g) => g.recoverQuote({ state: 'refunded', charged_at: 'x', job_id: 'j' }).action
      === 'replay_refund',
  },
  {
    leg: 'L21 replay_reconstructs_from_state_job_and_charged_at',
    why: 'the replayed balance is presented as the original, so a number read '
       + 'minutes later is shown as the one the user was charged against',
    old: '    balance_is_current: true,',
    new: '    balance_is_current: false,',
    pre: null,   // INJECTS a defect
  },
  {
    leg: 'L23 kind_label_comes_from_the_kind_not_the_label',
    why: 'kind_label goes back to being derived from the label, which is the '
       + 'prose-splitting the field was added to replace',
    old: "  sfx: 'Sound effect',",
    new: "  sfx: null,",
    pre: (g) => g.kindLabel('sfx') === 'Sound effect',
  },
  {
    leg: 'L24 batch_replay_refuses_and_names_what_is_missing',
    why: 'the gap stops naming its own fix, which is the difference between a '
       + 'finding someone can act on and a complaint',
    old: "    fix: 'ALTER TABLE generation_batch_quotes ADD COLUMN jobs jsonb;',",
    new: "    fix: null,",
    pre: (g) => !!g.replayBatchConfirm().fix,
  },
];

function runSmoke() {
  const r = spawnSync(process.execPath, [SMOKE], { encoding: 'utf8' });
  return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// RESIDUE IS "DIFFERS FROM WHAT I READ", NOT "DIFFERS FROM HEAD". The first
// draft of this asked git, and went off on every run because the files under
// test were legitimately uncommitted work — a check that is always red is a
// check nobody reads, and it would have been switched off within the hour.
// The mutant is the only thing this can be about, so compare the bytes.
function residue() {
  return fs.readFileSync(SRC, 'utf8') === original ? '' : `${SRC} still differs from the source read at start`;
}

const original = fs.readFileSync(SRC, 'utf8');
let harnessFault = false;
let red = 0;

console.log('RED PROOF — generation contract, the two rulings of 2026-09-23\n');

// STEP 0 — the unmutated gate must be GREEN in this sandbox. A red produced by
// a broken sandbox rather than by a mutation has fired twice before.
{
  const base = runSmoke();
  if (base.rc !== 0) {
    console.log(`  HARNESS FAILURE — the unmutated smoke is not green (rc=${base.rc})`);
    console.log(base.out.split('\n').slice(-6).join('\n'));
    process.exit(2);
  }
  console.log('  baseline: the unmutated smoke is GREEN\n');
}

for (const m of MUTATIONS) {
  const occurrences = original.split(m.old).length - 1;
  if (occurrences !== 1) {
    console.log(`  HARNESS FAILURE  ${m.leg}\n      anchor ${occurrences}x — a refactor moved the target`);
    harnessFault = true;
    continue;
  }
  if (m.pre) {
    delete require.cache[require.resolve(SRC)];
    let ok = false;
    try { ok = !!m.pre(require(SRC)); } catch (e) { ok = false; }
    if (!ok) {
      console.log(`  VACUOUS  ${m.leg}\n      the precondition is false on the unmutated source — `
        + 'this mutation weakens something that already does nothing');
      harnessFault = true;
      continue;
    }
  }

  const mutant = original.replace(m.old, m.new);
  // A mutant that does not parse never ran at all, and exits non-zero anyway.
  fs.writeFileSync(SRC, mutant);
  const parsed = spawnSync(process.execPath, ['--check', SRC], { encoding: 'utf8' });
  if (parsed.status !== 0) {
    fs.writeFileSync(SRC, original);
    console.log(`  HARNESS FAILURE  ${m.leg}\n      the mutant does not parse: ${(parsed.stderr || '').split('\n')[0]}`);
    harnessFault = true;
    continue;
  }

  const r = runSmoke();
  fs.writeFileSync(SRC, original);

  const named = r.out.includes(`FAIL  ${m.leg}`);
  const fails = (r.out.match(/^ {3}FAIL {2}/gm) || []).length;
  const passes = (r.out.match(/^ {3}ok {2}/gm) || []).length;
  // NOT "exactly one leg". L14's mutation legitimately reddens L15 as well,
  // because L15's fixture contains a within-window case on purpose — demanding
  // one would reject a correct mutation, which is the floors-checker that
  // failed working harnesses, one level down. What must hold is that the
  // harness RAN (legs still passed, so this is not a crash or a parse failure)
  // and that the leg named beside the mutation is one of the red ones.
  const isRed = r.rc !== 0 && named && passes > 0;
  if (isRed) red += 1;
  console.log(`  ${isRed ? '[RED]' : '[NOT RED]'}  ${m.leg}`);
  console.log(`      defect: ${m.why}`);
  console.log(`      rc=${r.rc} named=${named} legs_failed=${fails} legs_passed=${passes}`);

  const left = residue();
  if (left) {
    console.log(`  HARNESS FAILURE — residue left after ${m.leg}:\n      ${left}`);
    harnessFault = true;
  }
}

fs.writeFileSync(SRC, original);
const floor = MUTATIONS.length > 0 && red === MUTATIONS.length && !harnessFault;
console.log(`\n${red}/${MUTATIONS.length} RED-proven${harnessFault ? ' (HARNESS FAULT)' : ''}`);
process.exit(floor ? 0 : 1);
