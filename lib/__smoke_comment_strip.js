'use strict';
// ── A GATE CANNOT FIND A DEFECT IN SOURCE IT WAS NEVER GIVEN ───────────────
//
// Fifteen gates stripped comments with `src.replace(/\/\*[\s\S]*?\*\//g, '')`.
// server.js line 2098 sets a CSP header containing
// `https://*.contentsquare.net`. The `//*` in that URL contains `/*`, so the
// regex opened a comment inside a string literal and closed it at the next real
// `*/` — deleting 552 lines of LIVE CODE from the text every one of those gates
// scanned, including both /api/profile/settings handlers and
// /api/user/subscription. No error, no warning: the gates simply had less to
// find and passed.
//
// This is the shrunken-input class already on record here (a truncated sample
// reads clean because the defect is in the part that was cut), and it had
// already been diagnosed TWICE in this repo — __smoke_chat_model_pinned.js and
// __smoke_chat_media.js both carry a comment about a path glob whose `/*`
// opened a phantom block comment — and patched locally both times while
// thirteen other files kept the same regex.
//
// So the check is not "the stripper works". It is: no gate may use a stripper
// that can delete code, and the shared one must be incapable of it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./__gate_strip');

const ROOT = path.join(__dirname, '..');
const nl = (s) => s.split('\n').length;

// ── 1. LINE COUNT IS AN INVARIANT, over every file the gates actually scan ──
// Blanking instead of deleting is also what makes a gate's `server.js:2295`
// point at line 2295 rather than at a line shifted by however many comments
// happened to precede it.
{
  const files = ['server.js', 'validate_deploy.js',
    ...fs.readdirSync(path.join(ROOT, 'lib'))
      .filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'routes'))
      .filter((f) => f.endsWith('.js')).map((f) => `routes/${f}`)];
  let scanned = 0;
  for (const rel of files) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    assert.strictEqual(nl(stripComments(raw)), nl(raw),
      `${rel}: stripping changed the line count, so it removed a line rather than `
      + 'blanking its comment. Every line number a gate reports is now wrong, and '
      + 'whatever was on the removed lines is invisible to it.');
    scanned += 1;
  }
  assert.ok(scanned > 40, `expected to scan the repo's sources, scanned ${scanned}`);
}

// ── 2. THE EXACT REGRESSION: a URL must not open a comment ─────────────────
{
  const csp = [
    "const baseCsp = `default-src 'self'; script-src https://*.contentsquare.net;`;",
    'const KEEP_ME = 1;',
    "const alsoKeep = 'exports/* glob';",
    'const STILL_HERE = 2;',
    '/* a real block comment',
    '   spanning lines */',
    'const AFTER = 3;',
  ].join('\n');
  const out = stripComments(csp);
  for (const must of ['KEEP_ME', 'STILL_HERE', 'AFTER', 'baseCsp']) {
    assert.ok(out.includes(must), `${must} was eaten by a phantom comment`);
  }
  assert.ok(!out.includes('a real block comment'), 'a genuine block comment must go');
  assert.strictEqual(nl(out), nl(csp));
}

// ── 3. It still removes what it is for ─────────────────────────────────────
{
  const src = [
    '// a whole-line comment mentioning forbiddenSymbol',
    'const a = 1; // trailing mentioning forbiddenSymbol',
    'const b = 2; /* inline mentioning forbiddenSymbol */',
    '/**',
    ' * jsdoc mentioning forbiddenSymbol',
    ' */',
    "const url = 'https://example.com/path'; // keeps the url",
  ].join('\n');
  const out = stripComments(src);
  assert.ok(!/forbiddenSymbol/.test(out),
    'comment text must not reach a gate — matching a literal inside documentation '
    + 'is the false-failure this repo has written repeatedly');
  assert.ok(out.includes('const a = 1;') && out.includes('const b = 2;'));
  assert.ok(out.includes("'https://example.com/path'"),
    'the `//` in a URL is not a comment');
  assert.strictEqual(nl(out), nl(src));
}

// ── 4. THE 552 LINES ARE BACK. Named anchors from the region the naive regex
//       swallowed, so this fails if anything reopens the hole. ──────────────
{
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'));
  for (const anchor of [
    "parsed.pathname === '/api/profile/settings'",
    "parsed.pathname === '/api/user/subscription'",
    '[ProfileSettings] update error',
  ]) {
    assert.ok(code.includes(anchor),
      `"${anchor}" is missing from the stripped source — it sits between the CSP `
      + 'header and the next `*/`, which is precisely the region that used to '
      + 'disappear. Every gate scanning server.js is blind again.');
  }
}

// ── 5. NO GATE MAY CARRY ITS OWN STRIPPER ──────────────────────────────────
// Self-invalidating: the allowlist is empty, so any reappearance fails here
// rather than silently shrinking someone's input.
{
  const offenders = [];
  for (const f of fs.readdirSync(__dirname).filter((f) => f.startsWith('__smoke') && f.endsWith('.js'))) {
    if (f === path.basename(__filename)) continue;
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/replace\(\s*\/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\//.test(line)) {
        offenders.push(`${f}:${i + 1}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [],
    'these strip block comments with a regex that cannot tell a string from code, '
    + 'so a URL or a glob containing `/*` deletes everything up to the next `*/`. '
    + "Use require('./__gate_strip').stripComments:\n  " + offenders.join('\n  '));
}

console.log('[smoke] comment strip: PASS (line count invariant across every scanned source; '
  + 'a `://*` URL no longer opens a phantom comment; real comments still removed; the 552 '
  + 'lines the naive regex deleted from server.js — both profile/settings handlers and '
  + 'user/subscription — are back; 0 gates carry their own stripper)');
