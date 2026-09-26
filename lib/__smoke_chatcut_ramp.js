'use strict';
// Gate for the ChatCut ramp and its kill switch — ONE ROW (Zac 2026-09-25).
//
//   "server_flags.chatcut_route exists now: allowlist = the 3 internal
//    accounts + Frontend's test account d14d30e7, percent 0, enabled_all
//    false. Wire the routing decision to it through the existing DB-first
//    resolver; don't create a second row or name. Kill switch = percent 0 AND
//    enabled_all false."
//
// AND THE THREE PROOFS THE DEMO NEEDS (Zac 2026-09-25, investor demo Sunday):
//   K1  an ALLOWLISTED account routes to ChatCut
//   K2  a STRANGER routes to the existing pipeline
//   K3  percent 0 kills, within the 30 s cache

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const strip = require('./__gate_strip').stripComments;
const { rampAllows, RAMP_FLAG, REASONS } = require('./chatcut-ramp');
const R = require('./chatcut-routing');
const flags = require('./upload-flags');
const FP = require('./chatcut-ramp');

const quiet = { warn() {}, error() {}, log() {} };

// ── THE STUB IS THE REAL RESOLVER'S SEMANTICS, NOT A BOOLEAN ─────────────
// A stub that just answers on/off would prove the ramp reads a flag and prove
// NOTHING about allowlist-before-percent, which is the property the demo
// depends on. So this reproduces resolve()'s row logic against a row shaped
// exactly like the one Zac describes, and K5 then drives the SHIPPED resolver
// to prove the two agree.
const rowResolver = (row) => async (flag, userId) => {
  if (flag !== RAMP_FLAG || !row) return { on: false, source: 'off', dbState: 'ok' };
  if (row.dbState === 'unreadable') {
    return { on: false, source: 'off', dbState: 'unreadable' };
  }
  if (row.enabled_all) return { on: true, source: 'all', dbState: 'ok' };
  if (Array.isArray(row.allowlist) && row.allowlist.includes(userId)) {
    return { on: true, source: 'allowlist', dbState: 'ok' };
  }
  const p = Number(row.percent || 0);
  if (p > 0 && flags._pct(flag, userId) < p) return { on: true, source: 'percent', dbState: 'ok' };
  return { on: false, source: 'off', dbState: 'ok' };
};

// The row as it stands in production right now.
const ZAC = 'ec702499-ca10-49e6-8850-df8f99840904';
const FE_TEST = 'd14d30e7-0000-0000-0000-000000000000';
const LIVE_ROW = { allowlist: [...flags.DEFAULT_ALLOWLIST, FE_TEST], percent: 0, enabled_all: false };
const STRANGER = '00000000-dead-beef-0000-000000000001';

(async () => {
  const route = (row, opts = {}) => R.routeForJob({
    userId: opts.userId || ZAC, log: quiet,
    rampAllows: (a) => rampAllows({ ...a, resolveFlag: rowResolver(row), log: quiet }),
    accountStatus: { state: 'OK', balance: opts.balance ?? 9999 },
    isChatcutReedit: opts.reedit === true,
  });

  // ── K1: AN ALLOWLISTED ACCOUNT ROUTES TO CHATCUT, at percent 0.
  // This is the demo. If it fails, Sunday runs on the existing pipeline.
  {
    for (const uid of [...flags.DEFAULT_ALLOWLIST, FE_TEST]) {
      const r = await route(LIVE_ROW, { userId: uid });
      assert.strictEqual(r.route, R.ROUTE_CHATCUT,
        `K1: allowlisted account ${uid.slice(0, 8)} must route to ChatCut at percent 0`);
      assert.strictEqual(r.rampSource, 'allowlist',
        'K1: and the row must say it was the ALLOWLIST, not a percentage — an internal '
        + 'e2e counted as a customer in the rollout is a rollout reading its own tester');
      assert.strictEqual(r.stage, 'guard',
        'K1: admitted at the ramp, decided at the guard');
    }
  }

  // ── K2: A STRANGER ROUTES TO THE EXISTING PIPELINE.
  {
    const r = await route(LIVE_ROW, { userId: STRANGER });
    assert.strictEqual(r.route, R.ROUTE_EXISTING,
      'K2: an account that is not on the allowlist must NOT reach ChatCut at percent 0');
    assert.strictEqual(r.reason, 'ramp_off', 'K2: and the row records WHY');
    assert.strictEqual(r.stage, 'ramp',
      'K2: refused at the ramp, so no account_status read is spent on it');
  }

  // ── K3: PERCENT 0 + enabled_all false IS THE KILL, and it is one SQL
  // update away. Proven as a TRANSITION, because "it is off" and "it turned
  // off" are different claims and only the second is a kill switch.
  {
    const live = { allowlist: [], percent: 100, enabled_all: true };
    const before = await route(live, { userId: STRANGER });
    assert.strictEqual(before.route, R.ROUTE_CHATCUT, 'K3: ramped up, a stranger routes to ChatCut');
    const killed = { allowlist: [], percent: 0, enabled_all: false };
    const after = await route(killed, { userId: STRANGER });
    assert.strictEqual(after.route, R.ROUTE_EXISTING, 'K3: percent 0 + enabled_all false kills');
    assert.strictEqual(after.reason, 'ramp_off');

    // ── K3b: THE RESIDUAL, ASSERTED SO IT CANNOT BE FORGOTTEN.
    // The kill as specified does NOT stop an allowlisted account — resolve()
    // checks the allowlist BEFORE the percent. That is deliberate (the
    // allowlist holds the people diagnosing the outage), and it means
    // "everything off" is THREE fields, not one. Asserted rather than
    // commented, because a residual in a comment is a residual nobody reads
    // at 2am.
    const stillOn = await route({ allowlist: [ZAC], percent: 0, enabled_all: false },
      { userId: ZAC });
    assert.strictEqual(stillOn.route, R.ROUTE_CHATCUT,
      'K3b: percent 0 + enabled_all false leaves ALLOWLISTED accounts routing. To stop '
      + "everything the allowlist must be emptied too: percent 0, enabled_all false, allowlist '{}'");
    const allOff = await route({ allowlist: [], percent: 0, enabled_all: false }, { userId: ZAC });
    assert.strictEqual(allOff.route, R.ROUTE_EXISTING,
      'K3b: and emptying the allowlist stops even an internal account');
  }

  // ── K4: A CHATCUT RE-EDIT STILL ROUTES WHILE CREDITS LAST, even with the
  // ramp fully off — it cannot run anywhere else, so the ramp must never
  // strand it. The hard floor is the guard's job, not the ramp's.
  {
    const off = { allowlist: [], percent: 0, enabled_all: false };
    const funded = await route(off, { reedit: true, balance: 400, userId: STRANGER });
    assert.strictEqual(funded.route, R.ROUTE_CHATCUT,
      'K4: a ChatCut re-edit runs with the ramp at 0 — handler cannot read its plan');
    assert.strictEqual(funded.rampReason, 'reedit_must_use_chatcut');
    const broke = await route(off, { reedit: true, balance: 40, userId: STRANGER });
    assert.strictEqual(broke.route, R.ROUTE_NONE,
      'K4: but below the hard floor it stops — "while credits last"');
    assert.strictEqual(broke.reason, 'chatcut_exhausted');
    const nw = await route(off, { balance: 400, userId: STRANGER });
    assert.strictEqual(nw.stage, 'ramp', 'K4: a NEW job never reaches the guard when the ramp is off');
  }

  // ── K5: AN UNREADABLE FLAG STORE FAILS CLOSED, and the default-allowlist
  // hole is why. With no DB client the SHIPPED resolver falls back to env and
  // answers ON from DEFAULT_ALLOWLIST — so deleting the row would turn routing
  // back on for three accounts off a read that failed. dbState is the only
  // thing that distinguishes it, which is why it was added.
  {
    flags._resetFlagCache();
    const live = await flags.resolve(RAMP_FLAG, flags.DEFAULT_ALLOWLIST[0], null);
    assert.strictEqual(live.on, true,
      'K5: this is the hole — an unreadable store resolves ON for the default allowlist');
    assert.strictEqual(live.dbState, 'unreadable',
      'K5: and only dbState says the answer came from a failed read');
    const r = await R.routeForJob({
      userId: flags.DEFAULT_ALLOWLIST[0], log: quiet,
      accountStatus: { state: 'OK', balance: 9999 },
      rampAllows: (a) => rampAllows({ ...a, log: quiet,
        resolveFlag: (f, u) => flags.resolve(f, u, null) }),
    });
    assert.strictEqual(r.route, R.ROUTE_EXISTING,
      'K5: the ramp closes it — a switch you can defeat by deleting a row is not a switch');
    assert.strictEqual(r.reason, 'flags_unreadable',
      'K5: and it is NOT reported as ramp_off — "we were told no" and "we could not ask" '
      + 'are different, and only one of them is an outage');
  }

  // ── K6: THE ACCOUNT_STATUS READ IS NOT SPENT WHEN THE RAMP SAYS NO.
  // The module's own docblock claimed this ordering property while taking the
  // status as an already-resolved VALUE — so the caller had to fetch it
  // before calling and the read happened on every job anyway. The property was
  // true of the function and false of the system. A thunk makes it real, and
  // this leg is what proves the thunk is actually deferred.
  {
    let calls = 0;
    const thunk = async () => { calls++; return { state: 'OK', balance: 9999 }; };
    await R.routeForJob({ userId: STRANGER, log: quiet, accountStatus: thunk,
      rampAllows: (a) => rampAllows({ ...a, resolveFlag: rowResolver(LIVE_ROW), log: quiet }) });
    assert.strictEqual(calls, 0,
      'K6: a job the ramp refuses must not pay for an account_status round trip');
    await R.routeForJob({ userId: ZAC, log: quiet, accountStatus: thunk,
      rampAllows: (a) => rampAllows({ ...a, resolveFlag: rowResolver(LIVE_ROW), log: quiet }) });
    assert.strictEqual(calls, 1,
      'K6: and a job the ramp admits must actually read the account state — deferring it '
      + 'to never would be the guard silently skipped');
  }

  // ── K7: THE DECISION IS WIRED, PER USER, AND NOT FROM ENV ALONE.
  // routeForNewJob() answers from AGENTIC_ENABLED + AGENTIC_BASE_URL, two env
  // vars — and an env var on Render is not live until a REDEPLOY. A kill
  // switch whose latency is a deploy is not a kill switch. The row is.
  {
    const sv = strip(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));
    // 2026-09-26: the await was HOISTED one statement out of the insert's argument
    // list so the route's latency is its own [job-timing] phase. THE PROPERTY K7
    // protects is which FUNCTION decides — the per-user async resolver, never the
    // env-only routeForNewJob() whose kill switch costs a redeploy. That is
    // unaffected by where the await sits, so the check names the function and the
    // storage, and stops naming the syntax.
    //
    // The two REFUSALS below carry the teeth: the env-only form must not be what
    // the row records, and the route must be stored rather than computed and
    // dropped. __smoke_agentic_wire.js additionally pins the stored identifier to
    // this call's own binding.
    // ── SCOPED TO THE INSERT, BECAUSE THERE ARE TWO CALLERS ─────────────────
    //
    // A file-wide `/await routeForNewJobAsync\(/` passes on this file's own worst
    // case and I proved it: /api/profile/settings also calls the async resolver
    // (record:false, for upload.proxy), so reverting the INSERT to the env-only
    // routeForNewJob() left that regex satisfied by a different call site. The
    // mutation ran and the guard said nothing.
    //
    // So K7 reads the value the insert actually stores, and follows it to its
    // binding. `await createQueuedVideoJob({` — not the bare name, whose first
    // match is the function definition.
    const _bal = (str, from) => {
      let d = 0;
      for (let i = from; i < str.length; i += 1) {
        if (str[i] === '{') d += 1;
        else if (str[i] === '}') { d -= 1; if (d === 0) return str.slice(from, i + 1); }
      }
      return null;
    };
    const _iAt = sv.indexOf('await createQueuedVideoJob({');
    assert.ok(_iAt > 0, 'K7: the job insert is gone');
    const _iArgs = _bal(sv, sv.indexOf('{', _iAt));
    assert.ok(_iArgs, 'K7: could not bound the insert arguments');
    const _st = /pipeline:\s*(await\s+routeForNewJobAsync\(|([A-Za-z_$][\w$]*))/.exec(_iArgs);
    assert.ok(_st,
      'K7: the job insert must store the PER-USER decision, not the env-only one');
    if (!_st[1].startsWith('await')) {
      const _n = _st[2];
      const _pre = sv.slice(0, _iAt);
      assert.ok(new RegExp(`(const|let)\\s+${_n}\\s*=\\s*await\\s+routeForNewJobAsync\\(`)
        .test(_pre),
        `K7: the insert stores ${_n}, which is not bound to await routeForNewJobAsync() `
        + '— the PER-USER decision is not what the row records. The env-only '
        + 'routeForNewJob() answers from AGENTIC_ENABLED + AGENTIC_BASE_URL, and an env '
        + 'var on Render is not live until a redeploy, so a kill switch behind it is a '
        + 'deploy, not a switch');
      assert.ok(!new RegExp(`(const|let)\\s+${_n}\\s*=\\s*routeForNewJob\\(`).test(_pre),
        `K7: ${_n} is bound to the env-only routeForNewJob() — see above`);
    }
    assert.ok(/routeForJob\(\{/.test(sv) && /rampAllows/.test(sv) && /uploadFlags\.resolve/.test(sv),
      'K7: and it must go through the ramp and the EXISTING DB-first resolver — not a '
      + 'second mechanism, and not a second row');
    assert.ok(/agenticRouteArmed\(\)/.test(sv.slice(sv.indexOf('async function routeForNewJobAsync'))),
      'K7: the env pair stays the OUTER arm — an armed row pointing at no base URL would '
      + '500 every render');
    assert.ok(/orig\.pipeline === 'handler' \|\| orig\.pipeline === 'agentic'/.test(sv),
      'K7: and a re-edit INHERITS the route from the parent rather than re-resolving — '
      + 're-resolving would let a job created under one route be re-edited under another '
      + 'the moment the flag flipped');
  }

  // ── K8: EVERY REASON IS NAMED, and the set is exhaustive. `killed` is gone
  // with the second flag; a reason string nobody declared cannot be counted.
  assert.deepStrictEqual([...REASONS].sort(),
    ['all', 'allowlist', 'flags_unreadable', 'percent', 'ramp_off',
      'reedit_must_use_chatcut'].sort(), 'K8: the ramp reasons, exhaustively');

  // ── K9: THE 30-SECOND WINDOW IS REAL. A kill that takes ten minutes to land
  // is not "effective within the 30 s cache".
  {
    const s = strip(fs.readFileSync(path.join(__dirname, 'upload-flags.js'), 'utf8'));
    const m = s.match(/const CACHE_MS = ([^;]+);/);
    assert.ok(m, 'K9: the positive cache window must be findable');
    // eslint-disable-next-line no-eval
    assert.ok(eval(m[1]) <= 30 * 1000,
      `K9: the positive cache must be <= 30s for a flip to land in 30s; found ${m[1]}`);
    assert.ok(!/select\([^)]*\bvalue\b/.test(s),
      'K9: the resolver must NOT select a `value` column — it is not on the table, and '
      + 'naming it fails the whole flag read, which falls back to env and turns routing '
      + 'ON for the default allowlist off a failed query');
  }

  // ── K10: first_party IS THE ALLOWLIST RUNG, NOT "THE RAMP SAID YES".
  //
  // B1's worker refuses customer traffic while Zac's written-permission record
  // is absent, and only `first_party: true` exempts a request. rampAllows()
  // returns allowed for THREE rungs and two of them are CUSTOMERS — a job that
  // reached ChatCut through the percentage and then marked itself first-party
  // would be spending Zac's exemption on somebody else's video, which is the
  // one thing the gate exists to stop.
  {
    const fp = (row, uid) => FP.firstPartyFor({ userId: uid || ZAC,
      resolveFlag: rowResolver(row), log: quiet });
    const onList = await fp(LIVE_ROW, ZAC);
    assert.strictEqual(onList.firstParty, true,
      'K10: an internal account on the allowlist is first-party');
    assert.strictEqual(onList.source, 'allowlist');

    const byPercent = await fp({ allowlist: [], percent: 100, enabled_all: false }, STRANGER);
    assert.strictEqual(byPercent.firstParty, false,
      'K10: a CUSTOMER admitted by the percentage is NOT first-party — the rung that '
      + 'let them in is the whole question');
    const byAll = await fp({ allowlist: [], percent: 0, enabled_all: true }, STRANGER);
    assert.strictEqual(byAll.firstParty, false,
      'K10: and enabled_all is the MOST customer-facing rung of the three');
    const off = await fp({ allowlist: [], percent: 0, enabled_all: false }, STRANGER);
    assert.strictEqual(off.firstParty, false, 'K10: off is not first-party');

    // FAILS CLOSED — AND THE FIXTURE HAS TO BE THE REAL HAZARD.
    //
    // My first writing passed {dbState:'unreadable'} through the row stub,
    // which answers on:false — so the later `f.on === true` check rejected it
    // anyway and DELETING THE GUARD LEFT THE LEG GREEN. A vacuous test of a
    // fail-closed path, which is the shape of every false green in this repo.
    //
    // The hazard K5 already proved is the opposite shape: with the store
    // unreadable the SHIPPED resolver falls back to env and answers
    // on:true, source:'allowlist' from DEFAULT_ALLOWLIST. That is an exemption
    // manufactured by a failed query, and it is what this must refuse.
    const blind = await FP.firstPartyFor({ userId: ZAC, log: quiet,
      resolveFlag: async () => ({ on: true, source: 'allowlist', dbState: 'unreadable' }) });
    assert.strictEqual(blind.firstParty, false,
      'K10: an allowlist hit that came from an UNREADABLE store must not hand out the '
      + 'permission-gate exemption — that is a right granted by a failed query');
    assert.strictEqual(blind.dbState, 'unreadable');
    const noUser = await FP.firstPartyFor({ resolveFlag: rowResolver(LIVE_ROW), log: quiet });
    assert.strictEqual(noUser.firstParty, false, 'K10: no user is not first-party');
  }

  // ── K11: THE FIELD IS ABSENT, NOT false, FOR EVERYONE ELSE — and it is
  // wired to the dispatch. B1's gate refuses on ABSENCE, so a field we forget
  // to send fails closed; a field we send as `false` is the same answer said
  // louder, but the two must not be confused in the payload shape he parses.
  {
    const dsv = strip(fs.readFileSync(path.join(__dirname, 'agentic-dispatch.js'), 'utf8'));
    assert.ok(/if \(isFirstParty\) body\.first_party = true;/.test(dsv),
      'K11: first_party is set only when true, never written as false');
    assert.ok(/isFirstParty = false,/.test(dsv),
      'K11: and the parameter defaults to NOT first-party');
    const sv2 = strip(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));
    assert.ok(/firstPartyFor\(\{/.test(sv2) && /isFirstParty: _fp\.firstParty/.test(sv2),
      'K11: and the dispatch site actually resolves it — a permission exemption with no '
      + 'producer is the consumer-with-no-producer shape, on the gate that decides spend');
  }

  console.log('[smoke] chatcut ramp: ALL PASS (an allowlisted account routes to ChatCut at '
    + 'percent 0; a stranger does not; percent 0 + enabled_all false kills and the residual '
    + 'allowlist is asserted; ChatCut re-edits run with the ramp off but stop at the hard '
    + 'floor; an unreadable store fails closed and says so; the guard read is not spent on a '
    + 'refused job; the decision is wired per user through the one row; reasons exhaustive; '
    + '30s window pinned)');
  process.exit(0);
})().catch((e) => {
  console.error('chatcut-ramp smoke FAILED:', e && e.message);
  process.exit(1);
});
