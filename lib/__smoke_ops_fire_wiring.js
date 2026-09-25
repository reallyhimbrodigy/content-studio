'use strict';
// Gate for the origin guard's WIRING (Zac 2026-09-24, item 3).
//
// The guard itself was already complete and already gated
// (__smoke_origin_latency, 9 legs). It was also INERT: nothing called
// observe(), nothing called configure(). A gated, correct, unwired instrument
// is the consumer-with-no-producer shape — it reports healthy forever because
// it is watching an empty stream, and it is why the 2026-09-24 slowdown had no
// alarm attached to it.
//
// So this file gates the three things the guard cannot gate about itself:
// that something PRODUCES samples, that something CONSUMES pages, and that a
// page which reaches nobody is still recorded as having fired.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const strip = require('./__gate_strip').stripComments;
const fires = require('./ops-fire-log');
const guard = require('./origin-latency-guard');

const root = (f) => path.join(__dirname, '..', f);
const srcOf = (f) => strip(fs.readFileSync(root(f), 'utf8'));

// ── L1: SOMETHING PRODUCES SAMPLES. Without this the guard watches nothing.
{
  const sa = srcOf('services/supabase-admin.js');
  assert.ok(/require\(['"]\.\.\/lib\/origin-latency-guard['"]\)/.test(sa),
    'L1: the supabase admin client must feed the guard, or it watches an empty stream');
  assert.ok(/global:\s*\{\s*fetch:/.test(sa),
    'L1: the timing must be installed as the CLIENT\'S FETCH — per-call-site '
    + 'wrapping leaves a permanent gap the day someone adds the next call');
  assert.ok(/_guard\.observe\(/.test(sa), 'L1: and it must actually call observe()');
}

// ── L2: A REJECTED FETCH COUNTS AS BAD. During the outage Supabase was
// unreachable and calls never completed — no status at all. Dropping those
// leaves them out of BOTH sides of the rate, so the instrument goes quietest
// exactly when the origin is most broken.
{
  const sa = srcOf('services/supabase-admin.js');
  const rejectArm = sa.slice(sa.indexOf('(e) =>'), sa.indexOf('(e) =>') + 200);
  assert.ok(/status:\s*5\d\d/.test(rejectArm),
    'L2: a rejected fetch must be recorded with a 5xx-class status, not dropped');
  // And the bar it has to clear is the guard's own, not a number retyped here.
  const m = rejectArm.match(/status:\s*(\d+)/);
  assert.ok(m && Number(m[1]) >= 500,
    `L2: the rejection status must be >= 500 to count as bad; found ${m && m[1]}`);
}

// ── L3: SOMETHING CONSUMES PAGES. configure({sink}) must be called, and the
// sink must reach ops-alert rather than a console line.
{
  const sv = srcOf('server.js');
  assert.ok(/_guard\.configure\(\{/.test(sv) || /configure\(\{\s*\n?\s*sink:/.test(sv),
    'L3: configure({sink}) must be called at boot, or every page logs '
    + '"NO SINK CONFIGURED" and goes nowhere');
  assert.ok(/\/api\/internal\/ops-alert/.test(sv.slice(sv.indexOf('sink:'), sv.indexOf('sink:') + 1600)),
    'L3: the sink must post to ops-alert — that is the contract that reports '
    + 'UNDELIVERED / no_recipients instead of succeeding into the void');
}

// ── L4: THE FIRE IS RECORDED EVEN WHEN NOBODY RECEIVES IT.
// device_tokens is 0 for the owner today, so EVERY fire right now is
// UNDELIVERED. If that were indistinguishable from "nothing fired", wiring the
// guard would buy nothing until a device exists.
{
  fires._reset();
  const lines = [];
  const quiet = { error: (...a) => lines.push(a.join(' ')) };
  return (async () => {
    await fires.record({ at: Date.UTC(2026, 8, 24, 5, 0, 0), why: 'latency',
      p95_ms: 3100, samples: 44, delivery: 'UNDELIVERED', reason: 'no_recipients',
      delivered: 0, recipients: 0, title: 'x' }, { log: quiet });

    const r = fires.recent(5);
    assert.strictEqual(r.length, 1, 'L4: an UNDELIVERED fire is still a fire');
    assert.strictEqual(r[0].delivery, 'UNDELIVERED');
    assert.strictEqual(r[0].reason, 'no_recipients',
      'L4: and the machine-readable miss is kept, not flattened to a boolean');
    assert.ok(lines.some((l) => l.includes('[ops-fire]')),
      'L4: every fire writes one greppable line — it must survive a DB outage, '
      + 'which is exactly when this fires');
    assert.ok(lines.some((l) => /delivery=UNDELIVERED/.test(l) && /reason=no_recipients/.test(l)),
      'L4: and the line carries the delivery and the reason');

    // ── L5: UNKNOWN IS NOT DELIVERED AND NOT FAILED.
    await fires.record({ why: 'errors', delivery: 'UNKNOWN', reason: 'deadline' }, { log: quiet });
    assert.strictEqual(fires.recent(1)[0].delivery, 'UNKNOWN',
      'L5: UNKNOWN must survive as itself — read as delivered it hides an outage, '
      + 'read as failed it retries an alert that already landed');

    // ── L6: NEWEST FIRST AND BOUNDED. A ring that grows without limit is a
    // memory leak in the process the guard exists to keep alive.
    fires._reset();
    for (let i = 0; i < fires.RING_MAX + 10; i++) {
      await fires.record({ why: 'latency', p95_ms: i, delivery: 'UNDELIVERED' }, { log: quiet });
    }
    assert.strictEqual(fires.recent(1000).length, fires.RING_MAX,
      `L6: the ring is capped at ${fires.RING_MAX}`);
    assert.strictEqual(fires.recent(1)[0].p95_ms, fires.RING_MAX + 9, 'L6: newest first');

    // ── L7: A FAILING SINK NEVER BREAKS THE FIRE. record() is called from a
    // page, during an origin incident, with a DB that may be the problem.
    fires._reset();
    const boom = { from: () => { throw new Error('db is the outage'); } };
    let rec = null;
    try {
      rec = await fires.record({ why: 'latency', delivery: 'UNDELIVERED' },
        { supabaseAdmin: boom, log: quiet });
    } catch (e) {
      // CAUGHT AND RENAMED. Letting it escape to the outer catch prints
      // "smoke FAILED: db is the outage" and names no leg — and a failure that
      // cannot say which property broke makes the next run the debugger.
      assert.fail(`L7: record() THREW instead of absorbing the DB error (${e && e.message}). `
        + 'This runs during an origin incident where the database may BE the outage.');
    }
    assert.ok(rec && rec.why === 'latency', 'L7: the fire is still recorded and returned');
    assert.strictEqual(fires.recent(1).length, 1, 'L7: and still reaches the ring');

    // ── L8: THE PAGE'S OWN FACTS REACH THE SINK. A sink that re-derives p95
    // from _state() reads the bucket AFTER the roll that produced the page —
    // a different minute — and records a number that is not the one that fired.
    guard._reset();
    const seen = [];
    guard.configure({ sink: (t, b, facts) => { seen.push(facts); } });
    const t0 = 1_700_000_000_000;
    for (let m = 0; m < guard.BREACH_MINUTES + 1; m++) {
      for (let i = 0; i < guard.MIN_SAMPLES + 2; i++) {
        guard.observe(guard.P95_BAR_MS + 500, t0 + m * guard.WINDOW_MS + i);
      }
    }
    guard.configure({ sink: null });
    assert.ok(seen.length >= 1, 'L8: three over-bar minutes must page');
    assert.ok(seen[0] && Number.isFinite(seen[0].p95),
      'L8: the sink receives the p95 THAT FIRED, as a third argument');
    assert.ok(seen[0].p95 > guard.P95_BAR_MS,
      `L8: and it is the over-bar number (${seen[0] && seen[0].p95})`);
    assert.strictEqual(seen[0].why, 'latency', 'L8: and which arm fired');
    guard._reset();

    // ── L9: THE FIRES ARE QUERYABLE WITH NO MIGRATION APPLIED.
    const sv = srcOf('server.js');
    assert.ok(/ops_fires/.test(sv),
      'L9: /healthz must be able to render the ring — "log it to a table" that '
      + 'needs a migration nobody has applied is not visible today');
    // BOUNDED BY STRUCTURE, NOT BY A BYTE COUNT. This was `+ 1200`, and adding
    // a second query-parameter branch to the same handler pushed `end('OK')`
    // past the window: the leg went red for a handler whose behaviour was
    // untouched. This repo has already paid for the identical defect once —
    // "the step-token gate read a fixed 2200-byte window, so a comment failed a
    // deploy whose behaviour was untouched". A window measured in characters
    // encodes today's line count as a property of the code.
    const _hzAt = sv.indexOf("parsed.pathname === '/healthz'");
    assert.ok(_hzAt >= 0, 'L9: the /healthz handler must be findable');
    const _next = sv.indexOf("parsed.pathname === '", _hzAt + 30);
    const hz = sv.slice(_hzAt, _next > _hzAt ? _next : sv.length);
    assert.ok(hz.length > 200,
      'L9: the /healthz handler text came back too short to assert anything about — '
      + 'a leg that reads an empty window passes by asserting nothing');
    assert.ok(/if\s*\(\s*parsed\.query[^)]*ops_fires\s*\)/.test(hz),
      'L9: the ring must be rendered ONLY when explicitly asked for — the first '
      + 'version of this leg merely looked for `parsed.query` NEAR the branch and '
      + 'passed a mutant that changed the condition to `if (true)`');
    assert.ok(/end\('OK'\)/.test(hz),
      'L9: and the bare probe must still be the constant-time OK — Render calls '
      + 'it every few seconds and it must never do work');
    assert.ok(fs.existsSync(root('supabase/migrations/20260924_ops_alert_fires.sql')),
      'L9: the durable sink names a migration that must be in the tree');

    console.log('[smoke] ops fire wiring: ALL PASS (samples produced at the client fetch, '
      + 'a rejected fetch counts as bad, pages consumed by ops-alert, an UNDELIVERED fire '
      + 'is still a fire with its reason kept, UNKNOWN stays itself, ring bounded and '
      + 'newest-first, a failing DB never breaks a fire, the firing p95 reaches the sink, '
      + 'queryable on /healthz with no migration)');
    process.exit(0);
  })().catch((e) => {
    console.error('ops-fire-wiring smoke FAILED:', e && e.message);
    process.exit(1);
  });
}
