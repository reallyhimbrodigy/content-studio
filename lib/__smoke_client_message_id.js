'use strict';
// GATE (2026-09-06): client_message_id must travel the WHOLE chain — parsed off
// the request, PASSED at the call site, and written ON THE INSERT.
//
// Why a gate and not a comment. Frontend's job recovery was temporal: a +/-180s
// window with a single-candidate rule, because nothing linked a job to the
// message that created it. The column closes that. But a column nothing writes
// is the most common way work here ships green and does nothing — the standing
// list already names nine, and a BOOLEAN preview column is on it. The two live
// ways to break this are both silent:
//
//   1. parsed but never PASSED at the call site — the value dies in the handler
//      and every row stores NULL, exactly as if the feature were absent;
//   2. written in the fire-and-forget provenance patch instead of the INSERT —
//      the row lands without it, so the partial unique index (user_id,
//      client_message_id) cannot make create idempotent, and the duplicate-job
//      window this column exists to close stays open.
//
// Neither throws. Neither shows up in a log. Only a gate catches them.

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const fail = [];
const ok = [];
const check = (label, cond, detail) => {
  if (cond) { ok.push(label); }
  else { fail.push(label + (detail ? `  :: ${detail}` : '')); }
};

// 1. parsed off the request body
check('client_message_id is read off the request body',
  /body\?\.client_message_id/.test(src));

// 2. NOT uuid-pinned — tested as a BEHAVIOUR, not as a spelling.
//    The previous version of this check looked for one literal UUID regex
//    (`[0-9a-f]{8}-[0-9a-f]{4}`). A mutation that pinned the id with a
//    different spelling — /^[0-9a-f-]{36}$/ — sailed straight through it. A
//    gate that matches a pattern only catches the author who writes that
//    pattern. So: lift the REAL parse expression out of server.js, run it, and
//    assert on what it accepts and rejects.
//
//    A message id belongs to the client's own chat store and may be a nanoid, a
//    ULID or a prefixed string. The last invented client-id charset rejected
//    55.6% of real devices; do not repeat it on a key we do not mint.
{
  const m = src.match(/const clientMessageId =\s*([\s\S]*?);\n/);
  check('the client_message_id parse expression is extractable', !!m);
  if (m) {
    let parse = null;
    try { parse = new Function('rawClientMsgId', 'return (' + m[1] + ');'); } catch (e) { /* reported below */ }
    check('the parse expression evaluates', !!parse);
    if (parse) {
      const MUST_ACCEPT = [
        ['uuid',     '550e8400-e29b-41d4-a716-446655440000'],
        ['ULID',     '01J8Z5K3QV9XWQ2R7YT4B6N8CD'],
        ['nanoid',   'V1StGXR8_Z5jdHi6B-myT'],
        ['prefixed', 'msg_2f9aB7'],
        ['our own',  'umsg:9b1d-77'],
        ['short',    'a'],
        ['at cap',   'x'.repeat(200)],
      ];
      for (const [label, id] of MUST_ACCEPT) {
        check(`the parse accepts a ${label} message id`, parse(id) === id,
          `a real device sending ${label} would store NULL and lose recovery`);
      }
      const MUST_REJECT = [
        ['over the length cap', 'x'.repeat(201)],
        ['a control character', 'bad\u0001id'],
        ['empty',              ''],
      ];
      for (const [label, id] of MUST_REJECT) {
        check(`the parse rejects ${label}`, !parse(id),
          'an unbounded or control-bearing id reaches the index and the log');
      }
    }
  }
}

// 3. PASSED at the createQueuedVideoJob call site — the failure that makes the
//    whole column inert while every other check still passes.
const callIdx = src.indexOf('await createQueuedVideoJob({');
check('createQueuedVideoJob is called', callIdx !== -1);
if (callIdx !== -1) {
  const callArgs = src.slice(callIdx, src.indexOf('});', callIdx));
  check('clientMessageId is PASSED at the call site',
    /(^|[\s,{])clientMessageId\s*[,:]/.test(callArgs),
    'parsed but never passed — every row would store NULL');
}

// 4. accepted by the function signature
check('createQueuedVideoJob accepts clientMessageId',
  /async function createQueuedVideoJob\(\{[^}]*clientMessageId/.test(src));

// 5. written ON THE INSERT ROW, not in the unawaited provenance patch
check('client_message_id is set on insertRow (not the fire-and-forget patch)',
  /insertRow\.client_message_id\s*=/.test(src),
  'must be present when the row is written or the unique index cannot dedupe');

// 6. and NOT in the best-effort patch block, which would reintroduce the window
const patchIdx = src.indexOf('const patch = {};');
if (patchIdx !== -1) {
  const patchBlock = src.slice(patchIdx, patchIdx + 900);
  check('client_message_id is NOT deferred to the provenance patch',
    !/patch\.client_message_id/.test(patchBlock),
    'deferring it leaves a duplicate-submit window open');
}

// 7. the second unique index is handled as a replay, not a 500
check('a (user_id, client_message_id) conflict resolves to the existing job',
  /\.eq\('client_message_id',\s*clientMessageId\)/.test(src) &&
  /__replayed:\s*true/.test(src),
  'a repeated message id under a new job uuid must return one job, not error');

// 8. the replay lookup is SCOPED TO THE USER. A message id is minted by the
// client's own chat store, so two users can independently produce the same
// string. An unscoped recovery would hand one user another user's job row —
// the partial index is on (user_id, client_message_id) precisely because the
// id alone is not unique, and the query that resolves the conflict has to
// carry the same pair or it resolves to the wrong row.
{
  const m = src.match(/if \(clientMessageId && \(error\.code === '23505'[\s\S]{0,600}?__replayed/);
  check('the by-message replay lookup is scoped by user_id',
    !!m && /\.eq\('user_id',\s*userId\)/.test(m[0]),
    'without the user_id filter a shared message id returns another user\'s job');
}

if (fail.length) {
  console.error(`❌ client_message_id chain broken (${fail.length}):`);
  fail.forEach((f) => console.error('   - ' + f));
  process.exit(1);
}
console.log(`✅ client_message_id chain intact (${ok.length} checks)`);
