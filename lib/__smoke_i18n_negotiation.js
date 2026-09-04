'use strict';
// SMOKE — server-authored copy must be able to reach a non-English user.
//
// THE DEFECT (measured 2026-09-04). The app ships 107 strings in 12 locales and
// the client renders `body.message` VERBATIM — it has no code-to-copy table for
// server strings. The server had NO Accept-Language handling anywhere, so every
// refusal was English for everyone. 545 distinct users in 30 days are on the
// eight non-English locales we already translate (fr 185, ar 128, id 70, es 58,
// pt 51, de 42, ja 6, hi 5 of 11,910).
const fs = require('fs');
const path = require('path');
const { negotiateLocale, SUPPORTED, localeStats } = require('./i18n');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const fail = [];
const ok = (c, m) => { if (!c) fail.push(m); };

// ── the negotiator is CORRECT, not merely present ──────────────────────────
ok(negotiateLocale('fr-FR,fr;q=0.9,en;q=0.8') === 'fr', 'q-ranked French not honoured');
ok(negotiateLocale('de;q=0.2,ja;q=0.9') === 'ja', 'q-values ignored — header order won');
// The regional case that FAILED first time: pt-PT must reach pt-BR, and the
// region fallback has to run at every truncation level to get there.
ok(negotiateLocale('pt-PT') === 'pt-BR', 'pt-PT fell back to English instead of pt-BR');
ok(negotiateLocale('pt') === 'pt-BR', 'bare pt did not reach the regional variant');
// Fails SAFE, never null — every caller is on an error path.
for (const bad of ['', null, undefined, '*', 'zz', 'q=;;', 'en;q=0'])
  ok(negotiateLocale(bad) === 'en', `unsafe negotiation for ${JSON.stringify(bad)}`);
// Never negotiate a locale the app cannot render.
ok(negotiateLocale('zh-CN') === 'en', 'negotiated an unsupported locale');

// ── it must match what the CLIENT actually ships ───────────────────────────
// A locale here that the app has no strings for would return text it cannot
// render; one missing here silently downgrades that language to English.
const XC = path.join(__dirname, '..', 'ios', 'Promptly', 'Promptly', 'Localizable.xcstrings');
if (fs.existsSync(XC)) {
  const j = JSON.parse(fs.readFileSync(XC, 'utf8'));
  const shipped = new Set();
  for (const v of Object.values(j.strings || {}))
    for (const k of Object.keys(v.localizations || {})) shipped.add(k);
  const missing = [...shipped].filter((l) => !SUPPORTED.includes(l));
  const extra = SUPPORTED.filter((l) => !shipped.has(l));
  ok(missing.length === 0, `app ships locales the server will not negotiate: ${missing}`);
  ok(extra.length === 0, `server negotiates locales the app cannot render: ${extra}`);
}

// ── WIRED, not merely built ────────────────────────────────────────────────
// Nine features have shipped gate-green and done nothing. The negotiation is
// worthless unless it runs per request and is observable.
ok(/req\._locale = reqLocale\(req\);/.test(SRC),
   'reqLocale is never called — the negotiator is built but unwired');
{
  const attach = SRC.indexOf('apiLedger.attach(req, res);');
  const loc = SRC.indexOf('req._locale = reqLocale(req);');
  ok(attach > 0 && loc > attach && (loc - attach) < 400,
     'locale observation is not at the top of the request entry — early returns '
     + 'and 404s would go uncounted and understate header_rate');
}
ok(/i18n: \{ supported: _i18n\.SUPPORTED\.length, \.\.\._i18n\.localeStats\(\) \}/.test(SRC),
   '/api/health does not report locale stats — whether the client sends '
   + 'Accept-Language would stay an assumption instead of a curl');
ok(typeof localeStats().requests === 'number', 'localeStats() shape broken');

if (fail.length) {
  console.error('i18n negotiation smoke: FAIL');
  for (const f of fail) console.error(`   ✗ ${f}`);
  process.exit(1);
}
console.log('i18n negotiation smoke: PASS (q-values, regional fallback, fails safe, '
  + 'locale set matches the app, wired at entry, reported on /api/health)');
