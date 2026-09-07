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

// 2. NOT uuid-pinned. A message id belongs to the client's chat store and may be
//    a nanoid/ULID/prefixed string. The last invented client-id charset rejected
//    55.6% of real devices; do not repeat it on a key we do not mint.
const parseWindow = src.slice(
  Math.max(0, src.indexOf('rawClientMsgId') - 200),
  src.indexOf('rawClientMsgId') + 700);
check('the message id is NOT constrained to a UUID shape',
  src.includes('rawClientMsgId') &&
  !/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}[\s\S]{0,120}rawClientMsgId/.test(parseWindow) &&
  !/rawClientMsgId[\s\S]{0,200}\[0-9a-f\]\{8\}-/.test(parseWindow),
  'a UUID regex was applied to the client message id');

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

if (fail.length) {
  console.error(`❌ client_message_id chain broken (${fail.length}):`);
  fail.forEach((f) => console.error('   - ' + f));
  process.exit(1);
}
console.log(`✅ client_message_id chain intact (${ok.length} checks)`);
