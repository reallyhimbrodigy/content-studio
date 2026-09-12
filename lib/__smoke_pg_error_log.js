'use strict';
// ── THE RECORD YOU FIND MUST CARRY THE CAUSE ───────────────────────────────
//
// TWO defects, one line of code apart, and the first hid the second for four
// days.
//
// 1. `console.error('[ProfileSettings] update error', pgErr)` stores a record
//    that reads, in full, `[ProfileSettings] update error {`. util.inspect
//    wraps at ~80 columns and a log pipe stores one record per line, so the
//    code, the constraint and the details land in four further records with no
//    tag and no user on them — one of which is just `}`.
//
// 2. Behind it: `email: toPlainString(user.email || ... || '')`. profiles.email
//    is UNIQUE, Postgres exempts NULL from uniqueness but not '', so the first
//    email-less session to save a setting took the only '' slot and every one
//    after it got 23505. 29 failed saves, 99 profiles structurally blocked.
//
// This gate makes both impossible.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { errLine, MAX } = require('./log-error');
const { stripComments } = require('./__gate_strip');

const ROOT = path.join(__dirname, '..');
const strip = stripComments;

const ONE_LINE = (s) => !/[\r\n]/.test(s);

// ── 1. errLine is one line for every shape a failing call can hand back ────
{
  const pg = {
    code: '23505',
    details: 'Key (email)=() already exists.',
    hint: null,
    message: 'duplicate key value violates unique constraint "profiles_email_key"',
  };
  const line = errLine(pg, { user: 'e833de15', route: '/api/profile/settings' });
  assert.ok(ONE_LINE(line), 'a PostgREST error must render on ONE line');
  for (const must of ['user=e833de15', 'code=23505', 'constraint=profiles_email_key',
    'duplicate key value', 'Key (email)=()']) {
    assert.ok(line.includes(must), `the line must carry ${must} — it is the cause`);
  }

  // The constraint name is the diagnosis, and it is buried inside `message`.
  // Lifted out so it is greppable on its own.
  assert.ok(/constraint=profiles_email_key(\s|$)/.test(line),
    'the constraint must be its own field, not only a substring of the message');

  // Errors, strings, null, and an object carrying embedded newlines.
  assert.ok(ONE_LINE(errLine(new Error('boom'))));
  assert.ok(errLine(new Error('boom')).includes('err=Error: boom'));
  assert.ok(ONE_LINE(errLine('plain string')));
  assert.ok(ONE_LINE(errLine(null)), 'even a falsy error must not crash the logger');
  assert.ok(errLine(null).includes('<none>'), 'and must say the error was absent');
  assert.ok(ONE_LINE(errLine({ code: 'X', message: 'first\nsecond\r\nthird' })),
    'newlines INSIDE a field are the same defect one level down');
  assert.ok(ONE_LINE(errLine(new Error('multi\nline\nmessage'))));

  // A single trailing field must never be able to push the code out.
  const fat = errLine(
    { code: '22001', message: 'value too long', details: 'x'.repeat(5000) },
    { user: 'u1' },
  );
  assert.ok(ONE_LINE(fat), 'capping must not reintroduce a line break');
  assert.ok(fat.length <= MAX, `capped at ${MAX}`);
  for (const must of ['user=u1', 'code=22001', 'value too long']) {
    assert.ok(fat.includes(must),
      `identifying fields lead, so the cap costs the tail and never ${must}`);
  }
}

// ── 2. No log site hands a bare PostgREST object to console ────────────────
//
// The eight that did are listed so the allowlist is self-invalidating: fix one
// and this fails until its name is removed, which is what keeps the list honest.
{
  const src = strip(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'));
  const lines = src.split('\n');
  const ERRVAR = /^\s*console\.(?:error|warn)\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,\s*(error|updateError|insertError|upsertError|delError|selError|dbError)\s*\)/;

  const offenders = [];
  lines.forEach((line, i) => {
    const m = ERRVAR.exec(line);
    if (!m) return;
    const v = m[1];
    // Only the ones whose value came out of a supabase destructure truncate;
    // a caught Error prints its message on the FIRST line, which is readable.
    let fromSupabase = false;
    for (let j = i; j > Math.max(-1, i - 120); j -= 1) {
      if (new RegExp(`catch\\s*\\(\\s*${v}\\s*\\)`).test(lines[j])) break;
      if (new RegExp(`\\{[^}]*\\b${v}\\b[^}]*\\}\\s*=\\s*await`).test(lines[j])
        || new RegExp(`error\\s*:\\s*${v}\\b`).test(lines[j])) { fromSupabase = true; break; }
    }
    if (fromSupabase) offenders.push(`server.js:${i + 1} ${line.trim().slice(0, 80)}`);
  });

  assert.deepStrictEqual(offenders, [],
    'these hand a bare PostgREST object to console, so the stored record ends at '
    + '`{` and the cause is in untagged records after it. Wrap in errLine():\n  '
    + offenders.join('\n  '));
}

// ── 3. Nothing turns a MISSING email into the empty string ─────────────────
//
// A fallback that converts "unknown" into a real value is the ambiguous-NULL
// class pointed the other way: it makes an absence collide. This is the whole
// bug, and it is one `|| ''` wide.
{
  const files = ['server.js', ...fs.readdirSync(path.join(ROOT, 'lib'))
    .filter((f) => f.endsWith('.js') && !f.startsWith('__smoke'))
    .map((f) => `lib/${f}`)];
  const bad = [];
  for (const rel of files) {
    const src = strip(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    src.split('\n').forEach((line, i) => {
      if (/\bemail\s*:/.test(line) && /\|\|\s*(''|"")/.test(line)) {
        bad.push(`${rel}:${i + 1} ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepStrictEqual(bad, [],
    "an email column written as '' collides on a UNIQUE index that would have "
    + 'exempted NULL. Omit the key, or write null:\n  ' + bad.join('\n  '));
}

// ── 4. …and the settings upsert specifically OMITS it, proven by running the
//       real expression out of server.js rather than by matching its text. ──
{
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const m = /\.\.\.\((\w+)\s*\?\s*\{\s*email:\s*\1\s*\}\s*:\s*\{\}\)/.exec(src);
  assert.ok(m, 'the settings upsert must spread email conditionally, not assign it');
  const varName = m[1];

  const dv = new RegExp(`const ${varName}\\s*=\\s*([^;]+);`).exec(src);
  assert.ok(dv, `${varName} must be derived in one place`);
  const expr = dv[1];
  assert.ok(/\.trim\(\)/.test(expr),
    'a whitespace-only email is as unusable as an empty one and would take the '
    + 'next UNIQUE slot — trim before deciding');

  // Run the REAL derivation, then the REAL payload decision, for both sessions.
  const toPlainString = (v) => (v === null || v === undefined ? '' : String(v));
  const build = new Function('user', 'toPlainString',
    `const ${varName} = ${expr}; return { id: user.id, ...(${varName} ? { email: ${varName} } : {}) };`);

  const anon = build({ id: 'anon-1' }, toPlainString);
  assert.ok(!('email' in anon),
    'an email-less session must send NO email key — sending \'\' is what took the '
    + 'one UNIQUE empty-string slot and 23505\'d everyone after');
  assert.ok(!('email' in build({ id: 'u', email: '   ' }, toPlainString)),
    'nor may whitespace');
  assert.ok(!('email' in build({ id: 'u', user_metadata: {} }, toPlainString)));

  assert.strictEqual(build({ id: 'u', email: 'a@b.com' }, toPlainString).email, 'a@b.com',
    'a real email must still be written');
  assert.strictEqual(
    build({ id: 'u', user_metadata: { email: 'meta@b.com' } }, toPlainString).email,
    'meta@b.com', 'including the user_metadata fallback');
}

console.log('[smoke] pg error logging: PASS (errLine is one line for pg/Error/string/null/'
  + 'embedded-newline/over-cap and leads with the identifying fields; 0 bare PostgREST '
  + "objects reach console; no email column is written as ''; the settings upsert's real "
  + 'expression omits the key for an email-less or whitespace session and keeps a real one)');
