'use strict';
// Gate for the ChatCut ramp and its kill switch (Zac 2026-09-25).
//
// "A chatcut_route flag in server_flags: allowlist → percent → all, resolved
// per job, on top of the account guard. Kill switch = percent 0 and
// enabled_all false, effective within the 30 s cache."
//
// THE THREE PROOFS HE ASKED FOR ARE K1, K2 AND K3.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const strip = require('./__gate_strip').stripComments;
const { rampAllows, KILL_FLAG, RAMP_FLAG, REASONS } = require('./chatcut-ramp');
const R = require('./chatcut-routing');
const flags = require('./upload-flags');

const quiet = { warn() {}, error() {}, log() {} };
const mk = (o) => async (f) => o[f] || { on: false, source: 'off', dbState: 'ok' };
const ramp = (o) => (a) => rampAllows({ ...a, resolveFlag: mk(o), log: quiet });
const ON = { on: true, source: 'all', dbState: 'ok' };
const ALLOW = { on: true, source: 'allowlist', dbState: 'ok' };

(async () => {
  const route = (flagSet, opts = {}) => R.routeForJob({
    userId: 'u1', rampAllows: ramp(flagSet), log: quiet,
    accountStatus: { state: 'OK', balance: opts.balance ?? 9999 },
    isChatcutReedit: opts.reedit === true,
  });

  // ── K1: A FLIP TO 0 ROUTES THE NEXT JOB TO THE EXISTING PIPELINE.
  {
    const on = await route({ [RAMP_FLAG]: ON });
    assert.strictEqual(on.route, R.ROUTE_CHATCUT, 'K1: ramp on routes to ChatCut');
    const off = await route({});
    assert.strictEqual(off.route, R.ROUTE_EXISTING, 'K1: with the ramp at 0 the next job goes to the existing pipeline');
    assert.strictEqual(off.reason, 'ramp_off', 'K1: and the row records WHY');
    assert.strictEqual(off.stage, 'ramp', 'K1: refused at the ramp, not the guard');
  }

  // ── K2: THE KILL BEATS THE ALLOWLIST — the hole in "percent 0 and
  // enabled_all false". resolve() checks the allowlist BEFORE the percent, so
  // zeroing the percent leaves every allowlisted account still spending. The
  // kill is its own flag precisely so killing is ONE field, not three.
  {
    const killed = await route({ [RAMP_FLAG]: ALLOW, [KILL_FLAG]: ON });
    assert.strictEqual(killed.route, R.ROUTE_EXISTING,
      'K2: the kill must stop an ALLOWLISTED user, or it is not a kill switch');
    assert.strictEqual(killed.reason, 'killed');
    for (const src of ['all', 'allowlist', 'percent']) {
      const r = await route({ [RAMP_FLAG]: { on: true, source: src, dbState: 'ok' }, [KILL_FLAG]: ON });
      assert.strictEqual(r.route, R.ROUTE_EXISTING, `K2: kill beats ramp source=${src}`);
    }
  }

  // ── K3: RE-EDITS OF CHATCUT-MADE VIDEOS STILL GO TO CHATCUT, EVEN KILLED —
  // they cannot run anywhere else, so the ramp must never strand them.
  // WHILE CREDITS LAST: the hard floor still bites, and that is the guard's
  // job, not the ramp's.
  {
    const funded = await route({ [KILL_FLAG]: ON }, { reedit: true, balance: 400 });
    assert.strictEqual(funded.route, R.ROUTE_CHATCUT,
      'K3: a ChatCut re-edit runs even with the kill on — handler cannot read its plan');
    const broke = await route({ [KILL_FLAG]: ON }, { reedit: true, balance: 40 });
    assert.strictEqual(broke.route, R.ROUTE_NONE,
      'K3: but below the hard floor it stops — "while credits last"');
    assert.strictEqual(broke.reason, 'chatcut_exhausted');
    // And a NEW job in the same state is refused by the ramp, not the floor.
    const nw = await route({ [KILL_FLAG]: ON }, { balance: 400 });
    assert.strictEqual(nw.stage, 'ramp', 'K3: a new job never reaches the guard when killed');
  }

  // ── K4: AN UNREADABLE FLAG STORE FAILS CLOSED. This path SPENDS. If we
  // cannot read the switch, we do not know whether we have been told to stop,
  // and the existing pipeline always works.
  {
    const r = await route({ [RAMP_FLAG]: { on: true, source: 'allowlist', dbState: 'unreadable' },
                            [KILL_FLAG]: { on: false, source: 'off', dbState: 'unreadable' } });
    assert.strictEqual(r.route, R.ROUTE_EXISTING,
      'K4: an unreadable flag store must not route to the thing that costs money');
    assert.strictEqual(r.reason, 'flags_unreadable',
      'K4: and it is NOT reported as ramp_off — "we were told no" and "we could not ask" '
      + 'are different, and only one of them is an outage');

    // ── K4a / K4b: EACH GUARD INDEPENDENTLY NECESSARY.
    //
    // The first writing had BOTH flags unreadable, so the kill-side guard and
    // the ramp-side guard each caught it alone and the red proof could not
    // remove either one: deleting one left the other passing the test, twice,
    // and the suite reported green on a mutant. A check satisfied by two
    // redundant paths proves neither of them.
    //
    // So: one readable, one not — the only shape in which exactly one guard
    // can fire.
    const onlyRampBlind = await route({
      [KILL_FLAG]: { on: false, source: 'off', dbState: 'ok' },
      [RAMP_FLAG]: { on: true, source: 'allowlist', dbState: 'unreadable' } });
    assert.strictEqual(onlyRampBlind.reason, 'flags_unreadable',
      'K4a: the RAMP-side unreadable guard must fire on its own');
    assert.strictEqual(onlyRampBlind.route, R.ROUTE_EXISTING);

    const onlyKillBlind = await route({
      [KILL_FLAG]: { on: false, source: 'off', dbState: 'unreadable' },
      [RAMP_FLAG]: { on: true, source: 'all', dbState: 'ok' } });
    assert.strictEqual(onlyKillBlind.reason, 'flags_unreadable',
      'K4b: and the KILL-side guard must fire on its own — a kill we could not '
      + 'read is a kill we might not have heard');
    assert.strictEqual(onlyKillBlind.route, R.ROUTE_EXISTING);
  }

  // ── K5: THE DEFAULT-ALLOWLIST LOOPHOLE IS REAL AND IS WHY K4 EXISTS.
  // With no DB client at all, the env path falls back to DEFAULT_ALLOWLIST, so
  // deleting the chatcut_route row turns routing back ON for three accounts.
  {
    flags._resetFlagCache();
    const live = await flags.resolve(RAMP_FLAG, flags.DEFAULT_ALLOWLIST[0], null);
    assert.strictEqual(live.on, true,
      'K5: this is the hole — an absent row resolves ON for the default allowlist');
    assert.strictEqual(live.dbState, 'unreadable',
      'K5: and the only thing that distinguishes it is dbState, which is why it was added');
    const r = await R.routeForJob({
      userId: flags.DEFAULT_ALLOWLIST[0], log: quiet,
      accountStatus: { state: 'OK', balance: 9999 },
      rampAllows: (a) => rampAllows({ ...a, log: quiet,
        resolveFlag: (f, u) => flags.resolve(f, u, null) }),
    });
    assert.strictEqual(r.route, R.ROUTE_EXISTING,
      'K5: and the ramp closes it — a kill you can defeat by deleting a row is not a kill');
  }

  // ── K6: THE ROUTE IS DECIDED ONCE, AT INSERT, SO IN-FLIGHT JOBS FINISH.
  // Nothing re-resolves it later: a re-edit reads `pipeline` FROM THE ROW, and
  // that is the same property that makes a flip mid-render harmless.
  {
    const sv = strip(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));
    assert.ok(/pipeline: routeForNewJob\(\)/.test(sv),
      'K6: the route is stored on the row at creation');
    assert.ok(/orig\.pipeline === 'handler' \|\| orig\.pipeline === 'agentic'/.test(sv),
      'K6: and a re-edit INHERITS it from the parent rather than re-resolving — '
      + 're-resolving would let a job created under one route be re-edited under '
      + 'another the moment the flag flipped');
  }

  // ── K7: EVERY REASON IS NAMED, and the set is exhaustive. A row whose
  // routed_by carries a string nobody declared cannot be counted.
  assert.deepStrictEqual([...REASONS].sort(),
    ['all', 'allowlist', 'flags_unreadable', 'killed', 'percent', 'ramp_off',
      'reedit_must_use_chatcut'].sort(), 'K7: the ramp reasons, exhaustively');

  // ── K8: THE 30-SECOND WINDOW IS REAL. A kill that takes ten minutes to land
  // is not "effective within the 30 s cache".
  {
    const src = strip(fs.readFileSync(path.join(__dirname, 'upload-flags.js'), 'utf8'));
    const m = src.match(/const CACHE_MS = ([^;]+);/);
    assert.ok(m, 'K8: the positive cache window must be findable');
    // eslint-disable-next-line no-eval
    assert.ok(eval(m[1]) <= 30 * 1000,
      `K8: the positive cache must be <= 30s for a flip to land in 30s; found ${m[1]}`);
  }

  console.log('[smoke] chatcut ramp: ALL PASS (a flip to 0 routes the next job to the existing '
    + 'pipeline, the kill beats an allowlist and is ONE field, ChatCut re-edits run even killed '
    + 'but stop at the hard floor, an unreadable store fails closed and says so, the '
    + 'default-allowlist hole is closed, the route is decided once at insert so in-flight jobs '
    + 'finish, reasons exhaustive, 30s window pinned)');
  process.exit(0);
})().catch((e) => {
  console.error('chatcut-ramp smoke FAILED:', e && e.message);
  process.exit(1);
});
