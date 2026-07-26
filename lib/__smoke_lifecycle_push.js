'use strict';
// Real-path smoke for the render-lifecycle push chokepoint (lib/lifecycle-push.js)
// + the owner-alert mailman fix (services/push.js sendOwnerAlert).
//
// Pins, in order:
//   1. USER_LIFECYCLE_PUSHES defaults OFF; '1' turns it on.
//   2. Copy: exact completed title; failed body appends the credit note only
//      when the honest copy doesn't already say it (credit/refund/returned/
//      charged all count as said); 178-char cap.
//   3. Claim: atomic per-(job,kind) one-winner semantics against a mock DB
//      that enforces the jsonb-path IS NULL guard — the ACTIVE claim path,
//      including the losing racer.
//   4. Flag gating: non-owner + flag off → flag_off, DB never touched;
//      OWNER bypasses the flag (proof-before-flip); test mode skips the claim.
//   5. Owner-title law: every operator push title carries "[Promptly]"
//      (normalizeOwnerTitle) — and every literal sendOwnerAlert title in the
//      repo already complies at the source.
//   6. Consolidation: the legacy rider push blocks and the dead pushNotifier
//      transport are GONE from the live paths (no path can double-push).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// No real APNs / Supabase in the smoke process — sends must dead-end safely.
for (const k of ['APNS_AUTH_KEY_BASE64', 'APNS_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID']) delete process.env[k];
delete process.env.USER_LIFECYCLE_PUSHES;
delete process.env.OWNER_USER_ID;

const lp = require('./lifecycle-push');
const push = require('../services/push');

// --- mock supabaseAdmin for the claim path: enforces the IS NULL guard -------
// opts.staleRead: reads return this snapshot instead of live state — simulates
// the racer whose pre-read happened before the winner's write, so the ONLY
// thing between it and a double-push is the update's jsonb IS NULL guard.
function mockClaimDb(initialResult, opts = {}) {
  const state = { result: initialResult, reads: 0, updates: 0, isFilters: [] };
  function builder() {
    const b = {
      _mode: null, _payload: null, _isPath: null,
      select() { return b; },
      eq() { return b; },
      maybeSingle() {
        state.reads++;
        const seen = ('staleRead' in opts) ? opts.staleRead : state.result;
        return Promise.resolve({ data: { result: seen }, error: null });
      },
      update(payload) { b._mode = 'update'; b._payload = payload; return b; },
      is(col, val) { b._isPath = col; state.isFilters.push([col, val]); return b; },
      insert() { return Promise.resolve({ data: null, error: null }); },
      then(resolve) {
        // terminal await of update(...).select('id') — enforce the jsonb guard
        state.updates++;
        const m = /^result->([a-z0-9_]+)->([a-z0-9_]+)$/i.exec(b._isPath || '');
        assert.ok(m, `claim update must be guarded by a result-> jsonb IS NULL filter (got: ${b._isPath})`);
        const cur = (state.result && state.result[m[1]]) || {};
        if (cur[m[2]] != null) return resolve({ data: [], error: null }); // guard blocks — racer loses
        state.result = b._payload.result;
        return resolve({ data: [{ id: 'job-1' }], error: null });
      },
    };
    return b;
  }
  return { db: { from: () => builder() }, state };
}

(async () => {
  // 1. flag default OFF / '1' ON
  assert.strictEqual(lp.userLifecyclePushesEnabled(), false, 'flag must default OFF');
  process.env.USER_LIFECYCLE_PUSHES = '1';
  assert.strictEqual(lp.userLifecyclePushesEnabled(), true, "flag '1' must enable");
  delete process.env.USER_LIFECYCLE_PUSHES;

  // 2. copy pins
  assert.strictEqual(lp.buildCompletedAlert({}).title, '🎬 Your video is ready — tap to watch', 'completed title exact');
  assert.ok(lp.buildCompletedAlert({ vibe: 'make it cinematic' }).body.includes('make it cinematic'), 'vibe in body');
  const f1 = lp.buildFailedAlert({ errorMessage: 'The AI hit a rate limit.', refunded: true });
  assert.ok(f1.body.endsWith('Your credit was returned.'), 'credit note appended');
  assert.strictEqual(f1.title, 'Render failed — your credit was returned', 'failed title');
  const stalledCopy = 'This render stalled on our side — you weren’t charged. Tap to try again.';
  const f2 = lp.buildFailedAlert({ errorMessage: stalledCopy, refunded: true });
  assert.strictEqual(f2.body, stalledCopy, 'no duplicate credit note when copy already says charged');
  const f3 = lp.buildFailedAlert({ errorMessage: 'x'.repeat(400), refunded: true });
  assert.ok(f3.body.length <= 178, '178-char body cap');
  const f4 = lp.buildFailedAlert({ errorMessage: '', refunded: true });
  assert.ok(f4.body.includes('your credit was returned'), 'empty copy → honest generic fallback');

  // 3. claim: winner then loser (the ACTIVE path, both outcomes)
  {
    const { db, state } = mockClaimDb(null);
    const c1 = await lp.claimLifecyclePush(db, 'job-1', 'completed');
    assert.strictEqual(c1.won, true, 'first claim wins');
    const c2 = await lp.claimLifecyclePush(db, 'job-1', 'completed');
    assert.strictEqual(c2.won, false, 'second claim loses (pre-read short-circuit)');
    // racer whose pre-read happened BEFORE the winner wrote (stale read says
    // "unclaimed"): the update's jsonb IS NULL guard is the ONLY thing left,
    // and it must block — this is the exact double-settle double-push hazard.
    const marked = { lifecycle_push_v1: { failed: '2026-07-24T00:00:00Z' } };
    const { db: db2, state: s2 } = mockClaimDb(marked, { staleRead: null });
    const l = await lp.claimLifecyclePush(db2, 'job-1', 'failed');
    assert.strictEqual(l.won, false, 'stale-read racer loses on the guard, not the pre-read');
    assert.strictEqual(l.reason, 'lost_claim_race', 'guard loss surfaces as lost_claim_race');
    assert.ok(s2.updates >= 1, 'guard path actually attempted the update');
    assert.ok(state.isFilters.concat(s2.isFilters).every(([, v]) => v === null), 'guard filters check IS NULL');
    // per-kind independence: failed claim on a completed-claimed job still wins
    const k = await lp.claimLifecyclePush(db, 'job-1', 'failed');
    assert.strictEqual(k.won, true, 'claims are per terminal kind');
  }

  // 4. flag gating + owner bypass + test mode
  {
    const { db, state } = mockClaimDb(null);
    const r = await lp.sendLifecyclePush(db, { jobId: 'j', userId: 'someone-else', kind: 'completed' });
    assert.strictEqual(r.skipped, 'flag_off', 'non-owner + flag off → flag_off');
    assert.strictEqual(state.reads + state.updates, 0, 'flag_off must not touch the DB');

    const { db: dbO, state: stO } = mockClaimDb(null);
    const rO = await lp.sendLifecyclePush(dbO, { jobId: 'j', userId: lp.OWNER_USER_ID, kind: 'completed' });
    assert.ok(stO.updates >= 1, 'OWNER bypasses the flag (claim attempted)');
    assert.strictEqual(rO.skipped, 'not_configured', 'send dead-ends without APNs creds in smoke');

    const { db: dbT, state: stT } = mockClaimDb(null);
    const rT = await lp.sendLifecyclePush(dbT, { jobId: 'j', kind: 'failed', errorMessage: 'x', test: true });
    assert.strictEqual(stT.reads + stT.updates, 0, 'test mode skips the claim (repeatable proof)');
    assert.strictEqual(rT.skipped, 'not_configured', 'test mode still exercises the real send path');
  }

  // 5. owner-title law
  assert.strictEqual(push.normalizeOwnerTitle('render failed: X'), '[Promptly] render failed: X', 'bare title gets tag');
  assert.strictEqual(push.normalizeOwnerTitle('⚠️ render stalled'), '⚠️ [Promptly] render stalled', 'emoji kept ahead of tag');
  assert.strictEqual(push.normalizeOwnerTitle('⚠️ [Promptly] render stalled'), '⚠️ [Promptly] render stalled', 'compliant title untouched');
  assert.strictEqual(push.normalizeOwnerTitle(''), '[Promptly] alert', 'empty title → tagged default');

  // 6. source-level wiring pins (consolidation cannot silently regress)
  const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
  const dispatchSrc = read('video-processor/dispatch-to-modal.js');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const reaperSrc = read('job-reaper.js');
  const notifierSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'pushNotifier.js'), 'utf8');

  const count = (s, re) => (s.match(re) || []).length;
  assert.ok(count(dispatchSrc, /sendLifecyclePush\(/g) >= 4, 'dispatch: >=4 chokepoint call sites (modal-non-ok, worker-error, completion tail, dispatch-threw)');
  assert.ok(count(serverSrc, /sendLifecyclePush\(/g) >= 2, 'server: modal-progress + proof endpoint call the chokepoint');
  assert.ok(count(reaperSrc, /sendLifecyclePush\(/g) >= 1, 'reaper: user push wired');
  assert.ok(serverSrc.includes('/api/internal/lifecycle-push-proof'), 'proof endpoint present');
  assert.ok(!serverSrc.includes('sendRenderCompleteNotification'), 'dead pushNotifier completion path removed from server');
  assert.ok(!notifierSrc.includes('http2.connect') && !notifierSrc.includes('sandbox.push.apple.com'),
    'pushNotifier no longer carries its own (divergent, sandbox-default) transport — it must delegate to services/push');
  assert.ok(notifierSrc.includes("require('./push')"), 'pushNotifier delegates to the proven transport');
  assert.ok(!dispatchSrc.includes("title: 'Your video is ready 🎬'"), 'legacy rider completion push removed (no double-push path)');
  assert.ok(!dispatchSrc.includes('Failure push (classified)'), 'legacy rider failure push removed');
  assert.ok(dispatchSrc.includes("'content-available'") === false, 'silent prefetch push stays in services/push.js, not inlined');
  assert.ok(dispatchSrc.includes('push.sendToUser(userId, null, silentData, { silent: true })'), 'silent prefetch push preserved (untouched)');
  // Every literal owner-alert title in the repo carries the tag at the source.
  for (const [file, src] of [['dispatch', dispatchSrc], ['server', serverSrc], ['reaper', reaperSrc]]) {
    const titles = [...src.matchAll(/title:\s*(?:'([^']*)'|`([^`$]*)`)\s*,?\s*\n[^\n]*\n?[\s\S]{0,200}?threadId/g)];
    for (const m of titles) {
      const t = m[1] || m[2] || '';
      assert.ok(t.includes('[Promptly]'), `${file}: owner-alert title lacks [Promptly]: "${t}"`);
    }
  }
  for (const [file, src] of [['server', serverSrc], ['dispatch', dispatchSrc], ['reaper', reaperSrc]]) {
    assert.strictEqual(count(src, /process\.env\.USER_LIFECYCLE_PUSHES/g), 0,
      `${file}: the flag must be READ only inside lifecycle-push (one gate, no divergent parses)`);
  }
  assert.ok(read('lifecycle-push.js').includes("USER_LIFECYCLE_PUSHES || '').trim() === '1'"), 'flag parse pinned (default OFF)');

  console.log('SMOKE OK — lifecycle-push chokepoint: flag default OFF, claim one-winner, copy pinned, owner-title law, rider consolidated');
})().catch((e) => {
  console.error('SMOKE FAIL:', e && e.message);
  process.exit(1);
});
