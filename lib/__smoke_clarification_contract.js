'use strict';
// GATE — the parked-clarification contract: delivery, the reply that releases
// the lock, and the ORDER of the two.
//
// Lineage-on-insert is NOT checked here. __smoke_reedit_lineage.js already owns
// that and does it better (it asserts the assignment precedes `.insert(...)` in
// source order, and guards the -1 case where a deleted assignment would pass an
// ordering test). This file covers the half that gate does not.
//
// WHAT IS SILENT WHEN BROKEN, and each of these was live:
//
//  1. ORDER. A parked clarification holds its root, and answering it posts a
//     re-edit against that same root. Check the lock before clearing the park
//     and the answer 409s — naming the question as the thing blocking its own
//     answer, permanently, because a park never leaves needs_input on its own.
//     Both pieces can be individually correct and the feature still dead, purely
//     from their sequence. A pattern match cannot see an ordering bug.
//
//  2. THE ENVELOPE DISCRIMINATOR. Two unrelated mechanisms write `needs_input`:
//     the live plan-diff clarification (result.clarification_question) and the
//     dormant Phase D ask-back (result.ask + partial_state, 0 rows in 12,697
//     ever). Use the STATUS as the discriminator and the reply path cancels an
//     ask-back park the worker still intends to resume. Tested by running the
//     function, not by matching a name.
//
//  3. DELIVERY SCOPED TO THE RESPONSE BODY. The first version of this check
//     tested `/clarification_question:/` against the whole file and passed with
//     the response field deleted, because the local default object
//     `{ clarification_question: null, ... }` also matches. The gate was reading
//     the placeholder and calling it delivery. RED-proven since.
//
//  4. THE EXPIRY FLAG. Arming expiry before a client can render the question
//     cancels every park 24h after it was asked, having shown it to nobody, and
//     reports a clean "asked N / expired N" funnel for a feature nobody saw.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const fail = [];
const ok = [];
const check = (label, cond, detail) => {
  if (cond) ok.push(label);
  else fail.push(label + (detail ? `  :: ${detail}` : ''));
};

// ── 1. ORDER: clear the park, THEN check the lock ───────────────────────────
{
  const clearIdx = src.indexOf("current_step: 'clarification_answered'");
  const lockIdx = src.indexOf("error: 'reedit_in_flight'");
  check('the parked-clarification clear exists', clearIdx !== -1);
  check('the 409 in-flight check exists', lockIdx !== -1);
  // PRESENCE FIRST — indexOf returns -1 and -1 < anything is true, so an
  // ordering test alone passes when the clear is deleted outright.
  check('the park is CLEARED BEFORE the root lock is checked',
    clearIdx !== -1 && lockIdx !== -1 && clearIdx < lockIdx,
    'answering a question would 409 against the question itself, permanently');

  const casWindow = clearIdx === -1 ? '' : src.slice(clearIdx, clearIdx + 700);
  check('the clear is a CAS on status=needs_input',
    /\.eq\('status',\s*'needs_input'\)/.test(casWindow),
    'without the predicate a reply and the expiry sweep can both cancel the row');
}

// ── 2. the 409 carries the status the client types its copy off ─────────────
{
  const i = src.indexOf("error: 'reedit_in_flight'");
  const window = i === -1 ? '' : src.slice(i, i + 600);
  check('the 409 body carries `status`', /(^|[\s,{])status:/.test(window),
    'the client cannot tell a parked question from a running render; '
    + 'isParkedOnAQuestion keys on exactly "needs_input"');
  check('the 409 body carries the in-flight job_id', /job_id:/.test(window));
}

// ── 3. delivery, SCOPED TO THE RESPONSE BODY ────────────────────────────────
{
  const i = src.indexOf('ask: data.ask || null,');
  check('the job-status response block is locatable', i !== -1);
  const body = i === -1 ? '' : src.slice(i, i + 1200);
  check('the RESPONSE BODY returns clarification_question',
    /clarification_question:\s*_clar\./.test(body),
    'the worker writes the question and nothing returned it — 19 rows, 8 users, 63 days');
  check('the RESPONSE BODY returns the retry target',
    /clarification_retry_job_id:\s*_clar\./.test(body),
    'without it the client has no job to post the answer against');
}

// ── 4. /versions exists and signs on read ───────────────────────────────────
// ASSERT THE URL, NOT THE VARIABLE. The first version of this tested
// /versionsMatch/, which is a SUBSTRING of versionsMatchX — renaming the handler
// passed the gate while the route it guards could be gone. The contract a client
// depends on is the PATH, so that is what is asserted; the local name is free to
// change. (Same blind spot, independently, on the env flag below: a bare
// CLARIFICATION_EXPIRY_ENABLED matches CLARIFICATION_EXPIRY_ENABLED_V2.)
check('the /versions ROUTE PATH is declared',
  /\/api\\\/video-jobs\\\/\(\[\^\/\]\+\)\\\/versions\$/.test(src)
  || /pathname\.match\(\/\^\\\/api\\\/video-jobs[^)]*versions\$\/i\)/.test(src),
  'the route clients call is gone, whatever the handler variable is named');
{
  const i = src.indexOf('versionsMatch');
  const block = i === -1 ? '' : src.slice(i, i + 3500);
  check('the versions endpoint signs urls on read',
    /signReadFields\(/.test(block),
    'a stored grant may already be dead — 2,062 of 2,643 were when measured');
  check('the versions endpoint does not return the stored column directly',
    !/rendered_video_url:\s*row\.rendered_video_url/.test(block));
}

// ── 5. analytics allowlisted, or the SQL mirror drops them ──────────────────
check('clarification_answered is allowlisted', /'clarification_answered'/.test(src));
check('clarification_expired is allowlisted', /'clarification_expired'/.test(src));

// ── 6. BEHAVIOURAL: the discriminator actually discriminates ────────────────
{
  const C = require('./clarification');
  const V = require('./reedit-versions');
  const base = { id: 'j', status: 'needs_input', parent_job_id: 'p',
    created_at: new Date(Date.now() - 48 * 3600e3).toISOString() };
  const clar = { ...base, result: { clarification_question: 'Which part?' } };
  const askBack = { ...base, result: { ask: { ask_id: 'a1', prompt: 'Brighter clip?' } } };

  check('a clarification park is recognised', C.isClarificationPark(clar) === true);
  check('an ASK-BACK park is NOT treated as a clarification',
    C.isClarificationPark(askBack) === false,
    'cancelling one terminalizes a job the worker still intends to resume');
  check('a parentless park yields no retry target rather than retrying itself',
    C.retryTargetFor({ ...clar, parent_job_id: null }) === null);
  check('a parked question holds the root lock', V.holdsRootLock('needs_input') === true);
  check('a completed row does not hold the root lock', V.holdsRootLock('completed') === false);

  const rows = [
    { id: 'a', status: 'completed', created_at: '2026-09-01T00:00:00Z' },
    { id: 'b', status: 'completed', created_at: '2026-09-01T00:01:00Z' },
  ];
  check('a later failure does not renumber an earlier version',
    V.versionOf(rows, 'b') === 2
    && V.versionOf(rows.concat([{ id: 'c', status: 'failed', created_at: '2026-09-01T00:02:00Z' }]), 'b') === 2,
    'a version the user opened as v2 must not become v1');
}

// ── 7. expiry ships dark ────────────────────────────────────────────────────
// \b after ENABLED is load-bearing: without it this matches
// CLARIFICATION_EXPIRY_ENABLED_V2, so renaming the flag to something nothing
// sets would pass while the sweep ran unconditionally. `_` is a word character,
// so the boundary is what rejects the suffixed spelling.
check('the expiry sweep is behind CLARIFICATION_EXPIRY_ENABLED',
  /process\.env\.CLARIFICATION_EXPIRY_ENABLED\b/.test(src),
  'expiry must not run until a build can actually show the question');

if (fail.length) {
  console.error(`❌ clarification contract broken (${fail.length}):`);
  fail.forEach((f) => console.error('   - ' + f));
  process.exit(1);
}
console.log(`✅ clarification contract intact (${ok.length} checks) — cleared before checked, `
  + `delivery in the response body, ask-back parks left alone, expiry dark`);
