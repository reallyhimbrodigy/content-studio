'use strict';
// SMOKE — every worker endpoint call carries the shared secret.
//
// THE HOLE THIS CLOSES. run_job and warmup are modal.fastapi_endpoint POSTs with
// NO authentication: zero occurrences of requires_proxy_auth, and MODAL_RUN_SECRET
// existed nowhere in the worker. A plain unauthenticated curl from the open
// internet returned HTTP 200 {"spawned":true,...} and started a real job on a
// GPU worker. That is unauthenticated compute execution.
//
// CALLER FIRST. This smoke covers step 1 only: content-studio SENDS the secret
// everywhere. The worker still ignores it, so nothing can break — and step 3
// (worker enforces) must not ship until this is green in production for an hour.
const fs = require('fs');
const path = require('path');
const { workerAuthField } = require('./video-processor/dispatch-to-modal');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const DISP = fs.readFileSync(path.join(__dirname, 'video-processor', 'dispatch-to-modal.js'), 'utf8');
const fail = [];
const ok = (c, m) => { if (!c) fail.push(m); };

// ── the field itself ───────────────────────────────────────────────────────
{
  const saved = process.env.MODAL_RUN_SECRET;
  process.env.MODAL_RUN_SECRET = '';
  ok(Object.keys(workerAuthField()).length === 0,
     'an UNSET secret still emits a field — sending an empty secret would train '
     + 'the worker to accept one');
  process.env.MODAL_RUN_SECRET = 'test-secret';
  ok(workerAuthField()._worker_auth === 'test-secret',
     'the secret is not carried in _worker_auth');
  if (saved === undefined) delete process.env.MODAL_RUN_SECRET;
  else process.env.MODAL_RUN_SECRET = saved;
}

// ── EVERY call site, not the obvious two ───────────────────────────────────
// The warmup call posted a bare '{}' and was the one endpoint of three missing
// auth. It was found by auditing all three, not by checking the two that came
// to mind — so this asserts all three by construction.
ok(/fetch\(modalEndpointUrl[\s\S]{0,220}?workerAuthField\(\)/.test(DISP),
   'the run_job dispatch does not carry workerAuthField()');
ok(/fetch\(modalPrewarmUrl[\s\S]{0,220}?workerAuthField\(\)/.test(SRC),
   'the prewarm call does not carry workerAuthField()');
ok(/fetch\(warmUrl[\s\S]{0,220}?workerAuthField\(\)/.test(SRC),
   'the WARMUP call does not carry workerAuthField() — it posted a bare {} and '
   + 'would 403 the moment the worker enforces, silently disabling on-intent warm');
ok(!/fetch\(warmUrl[\s\S]{0,160}?body: '\{\}'/.test(SRC),
   "the warmup call still posts a literal '{}'");

if (fail.length) {
  console.error('worker dispatch auth smoke: FAIL');
  for (const f of fail) console.error(`   ✗ ${f}`);
  process.exit(1);
}
console.log('worker dispatch auth smoke: PASS (unset emits nothing, all THREE call '
  + 'sites carry _worker_auth — run_job, prewarm, warmup)');
