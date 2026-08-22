'use strict';

// REFERRAL LEG — fires exactly once per completed render, and COUNTS.
//
// WHAT THIS GUARDS. The leg grants Pro days. Two failure shapes matter and
// neither is caught by "it doesn't throw":
//
//   1. FIRING MORE THAN ONCE PER JOB. It is hung on the non-terminal ->
//      'completed' CAS transition, which is consumed once. If someone later
//      re-hangs it on the `step === 'complete'` label or on a bare status
//      check, a job that emits two pct>=100 events pays twice. The RPCs are
//      stated to be idempotent, but "the caller fires once" and "the callee
//      tolerates repeats" are different guarantees and only the first is ours.
//   2. GRANTING WITHOUT COUNTING. A reward nobody can measure is unreportable,
//      and a NON-idempotent grant would then be invisible. Every grant must
//      leave a `referral_reward_granted` row carrying the payout shape.
//
// Also asserts the honest-zero case, which is TODAY'S expected state: with no
// claim surface and 0 rows in `referrals`, the leg must fire, report
// qualified=false / granted=false, and still write the ATTEMPTED counter — the
// denominator that makes the zero legible instead of silent.

const assert = require('assert');
const { qualifyAndRewardReferral } = require('../lib/referral-leg');

function makeClient({ qualify = null, grant = null, qualifyErr = null, grantErr = null } = {}) {
  const calls = { rpc: [], inserts: [] };
  return {
    calls,
    async rpc(fn, args) {
      calls.rpc.push({ fn, args });
      if (fn === 'qualify_referral') {
        return qualifyErr ? { data: null, error: { message: qualifyErr } } : { data: qualify, error: null };
      }
      if (fn === 'grant_referral_reward') {
        return grantErr ? { data: null, error: { message: grantErr } } : { data: grant, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
    from(table) {
      return {
        async insert(rows) {
          calls.inserts.push({ table, rows });
          return { data: null, error: null };
        },
      };
    },
  };
}

(async () => {
  // ── 1: both RPCs called, with the RPC's OWN parameter names ──────────────
  {
    const c = makeClient({ qualify: true, grant: { days_granted: 7 } });
    const r = await qualifyAndRewardReferral(c, { userId: 'u1', jobId: 'j1' });
    const names = c.calls.rpc.map((x) => x.fn);
    assert.deepStrictEqual(names, ['qualify_referral', 'grant_referral_reward'],
      'both RPCs must be called, qualify first');
    assert.deepStrictEqual(c.calls.rpc[0].args, { p_referred: 'u1', p_job: 'j1' },
      'qualify_referral takes p_referred/p_job — wrong names silently no-op via PostgREST');
    assert.deepStrictEqual(c.calls.rpc[1].args, { p_user: 'u1' },
      'grant_referral_reward takes p_user');
    assert.strictEqual(r.qualified, true);
    assert.strictEqual(r.granted, true);
  }

  // ── 2: a grant MUST leave a counter row carrying the payout shape ────────
  {
    const c = makeClient({ qualify: true, grant: { days_granted: 7, pro_until_after: 'x' } });
    await qualifyAndRewardReferral(c, { userId: 'u2', jobId: 'j2' });
    const rows = c.calls.inserts.flatMap((i) => i.rows);
    const events = rows.map((r) => r.event);
    assert.ok(events.includes('referral_qualify_attempted'),
      'the denominator event is missing — a zero would be unreadable');
    assert.ok(events.includes('referral_reward_granted'),
      'a granted reward left NO counter — the payout is unreportable, and a '
      + 'non-idempotent grant would be invisible');
    const g = rows.find((r) => r.event === 'referral_reward_granted');
    assert.ok(g.props && g.props.grant_result,
      'the granted counter must carry the payout shape for reconciliation');
    assert.strictEqual(g.props.user_id, 'u2');
    assert.strictEqual(g.props.job_id, 'j2');
  }

  // ── 3: HONEST ZERO — today's real state (no claim surface, 0 referrals) ──
  {
    const c = makeClient({ qualify: false, grant: false });
    const r = await qualifyAndRewardReferral(c, { userId: 'u3', jobId: 'j3' });
    assert.strictEqual(r.attempted, true, 'the leg must still report it FIRED');
    assert.strictEqual(r.qualified, false);
    assert.strictEqual(r.granted, false);
    const rows = c.calls.inserts.flatMap((i) => i.rows);
    assert.ok(rows.some((x) => x.event === 'referral_qualify_attempted'),
      'a no-op run must STILL write the attempted counter — otherwise "0 rewards" '
      + 'is indistinguishable from "the leg never ran", which is the exact '
      + 'ambiguity that hid nine dead features');
    assert.ok(!rows.some((x) => x.event === 'referral_reward_granted'),
      'nothing was granted, so nothing may be counted as granted');
  }

  // ── 4: a qualify FAILURE must not skip the grant ─────────────────────────
  // An earlier referral may already be qualified and owed. Skipping the grant
  // on a transient qualify error would turn a blip into a permanently missed
  // payout.
  {
    const c = makeClient({ qualifyErr: 'boom', grant: { days_granted: 7 } });
    const r = await qualifyAndRewardReferral(c, { userId: 'u4', jobId: 'j4' });
    assert.ok(c.calls.rpc.some((x) => x.fn === 'grant_referral_reward'),
      'a qualify error skipped the grant — a transient blip must not cost a payout');
    assert.strictEqual(r.granted, true);
    assert.ok(r.error && r.error.includes('boom'));
  }

  // ── 5: NEVER THROWS — the render path must not care ──────────────────────
  {
    const c = makeClient({ qualifyErr: 'down', grantErr: 'down' });
    const r = await qualifyAndRewardReferral(c, { userId: 'u5', jobId: 'j5' });
    assert.strictEqual(r.granted, false);
    assert.ok(r.error, 'errors must be reported on the result, not swallowed silently');
  }
  {
    const r = await qualifyAndRewardReferral(null, { userId: 'u6', jobId: 'j6' });
    assert.strictEqual(r.attempted, false);
    assert.ok(r.error);
  }

  // ── 6: THE CALL SITE fires once per job, on the CAS transition ───────────
  // Source-level, because the once-ness lives in server.js, not in this module.
  {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const idx = src.indexOf('qualifyAndRewardReferral(supabaseAdmin');
    assert.ok(idx > 0, 'the leg is not wired into server.js at all');
    const before = src.slice(Math.max(0, idx - 1400), idx);
    assert.ok(/wonCompletedTransition\s*&&\s*prevState\?\.user_id/.test(before),
      'the leg is NOT inside the wonCompletedTransition guard — it would fire on '
      + 'every progress event and pay a user once per event');
    assert.ok(/require\('\.\/lib\/referral-leg'\)/.test(src),
      'referral-leg is never required — the call site would ReferenceError at '
      + 'the moment a render completes');
  }

  console.log('referral-leg: 6/6 OK');
})().catch((e) => {
  console.error('referral-leg FAILED:', e.message);
  process.exit(1);
});
