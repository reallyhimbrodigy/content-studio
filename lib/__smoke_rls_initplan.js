'use strict';
// ── A POLICY THAT CALLS auth.uid() PER ROW, AND A ROLLBACK THAT MISSES ONE ──
//
// Every RLS policy called auth.uid() unwrapped. Postgres evaluates that once per
// ROW wherever the policy lands as a Filter rather than an Index Cond — on
// video_jobs that was 12,002 evaluations for one count, 36.5 ms. Wrapped as
// (select auth.uid()) it is an InitPlan: once per query, 6.4 ms.
//
// This gate guards the MIGRATION FILE, which is the only artifact in this repo.
// The database itself is checked by the AUDIT query the file carries — there is
// no `pg` dependency here and adding one to a production service for an audit
// script is not worth it, so the audit is documented and run against the DB
// rather than asserted from Node. Said plainly rather than implied.
//
// THE REAL HAZARD IS THE ROLLBACK. A forward migration that touches sixteen
// policies and twenty indexes, with a rollback that restores fifteen and
// nineteen, leaves production in a state nobody wrote down. So the two halves
// are asserted against each other by NAME, not by count.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'migrations',
  '20260913_rls_initplan_and_index_prune.sql');
assert.ok(fs.existsSync(FILE), 'the RLS migration file is gone');
const src = fs.readFileSync(FILE, 'utf8');

// The rollback is appended as SQL comments; split the two halves on the marker.
const cut = src.indexOf('-- ── ROLLBACK');
assert.ok(cut > 0, 'the migration carries no rollback section');
const forward = src.slice(0, cut);
const rollback = src.slice(cut).replace(/^-- ?/gm, '');

// ── 1. EVERY auth call in the FORWARD half is wrapped ──────────────────────
{
  const code = forward.split('\n')
    .filter((l) => /^\s*(ALTER|CREATE)\s+POLICY/i.test(l)).join('\n');
  assert.ok(code.length > 0, 'no policy statements found — the scan is empty, not clean');
  const bare = code.split('\n').filter((l) =>
    /auth\.(uid|role)\(\)/.test(l) && !/\(\s*select\s+auth\.(uid|role)\(\)\s*\)/i.test(l));
  assert.deepStrictEqual(bare, [],
    'these call auth.uid()/auth.role() unwrapped, which Postgres evaluates once per '
    + 'ROW:\n  ' + bare.join('\n  '));
}

// ── 2. THE ROLLBACK RESTORES EVERY POLICY THE FORWARD HALF TOUCHES ────────
{
  const names = (half) => new Set(
    [...half.matchAll(/(?:ALTER|CREATE|DROP)\s+POLICY\s+(?:IF EXISTS\s+)?"([^"]+)"/gi)]
      .map((m) => m[1]));
  const f = names(forward);
  const r = names(rollback);
  assert.ok(f.size >= 16, `expected >=16 policies forward, found ${f.size}`);
  const missing = [...f].filter((n) => !r.has(n));
  assert.deepStrictEqual(missing, [],
    'the rollback does not restore these policies, so reverting would leave them '
    + 'in the migrated state with nothing recording it:\n  ' + missing.join('\n  '));
}

// ── 3. THE ROLLBACK RECREATES EVERY INDEX THE FORWARD HALF DROPS ─────────
{
  const dropped = [...forward.matchAll(/DROP\s+INDEX\s+IF\s+EXISTS\s+public\.(\w+)/gi)]
    .map((m) => m[1]);
  const recreated = new Set(
    [...rollback.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)/gi)].map((m) => m[1]));
  assert.ok(dropped.length >= 20, `expected >=20 index drops, found ${dropped.length}`);
  const missing = dropped.filter((n) => !recreated.has(n));
  assert.deepStrictEqual(missing, [],
    'dropped with no way back — the rollback must carry the exact CREATE INDEX for '
    + 'each:\n  ' + missing.join('\n  '));
}

// ── 4. THE IDEMPOTENCY CONSTRAINT IS NOT IN THE DROP LIST ────────────────
// It reads as "unused" (idx_scan=0) and is not: a UNIQUE index is doing its job
// every time an insert does NOT duplicate. Zero scans is not evidence against a
// constraint, and this is the one most likely to be swept up by a future prune.
{
  assert.ok(!/DROP\s+INDEX[^\n]*video_jobs_user_client_message_id_key/i.test(forward),
    'video_jobs_user_client_message_id_key enforces render idempotency on '
    + '(user_id, client_message_id). Dropping it lets a retried dispatch create a '
    + 'second job — and a second charge.');
}

// ── 5. THE AUDIT QUERY IS PRESENT AND STILL SEPARATES THE TWO FORMS ──────
{
  const m = /AND\s*\(\s*\(qual[\s\S]{0,400}?\);/.exec(src);
  assert.ok(m, 'the audit query is gone — the DB-side check is the only thing that '
    + 'can see the live policies, and this file is where it lives');
  // BOTH branches. The audit tests `qual` and `with_check` separately, and an
  // exclusion on only one of them reports every wrapped INSERT policy as a
  // violation — an audit that cries wolf is an audit nobody runs. The first
  // version of this assertion accepted either, and stayed green when the qual
  // branch lost its exclusion.
  const exclusions = (src.match(/!~\s*'SELECT auth\\\./g) || []).length;
  assert.strictEqual(exclusions, 2,
    `the audit must exclude the wrapped form on BOTH the qual and with_check `
    + `branches; found ${exclusions}`);
}

console.log('[smoke] rls initplan migration: PASS (every forward policy wrapped; rollback '
  + 'restores all 16 policies and all 20 indexes by name; the idempotency UNIQUE is not in '
  + 'the drop list; the audit query is present and discriminating)');
