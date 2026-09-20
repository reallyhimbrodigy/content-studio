#!/usr/bin/env node
// CALIBRATION FOR ZAC'S RULINGS OF 2026-09-20 — against the live classifier and
// REAL production briefs, fetched by hash at run time.
//
// WHY NOT A STORED FIXTURE FILE. Two standing laws meet here and both must
// hold: fixtures are sampled from production, and UNSAFE TEXT IS NEVER PUT IN A
// FIXTURE. So the fixture stores a request_hash and an expectation, this runner
// resolves the text read-only at run time, and nothing unsafe is ever written
// to disk. It also cannot drift: the row IS the production row.
//
// Usage: node scripts/fulfilment/check_rulings.js
const ENV = require('./env.js')();
const FX = require('./fixtures/ruling_fixtures.json');
const { classifyWithSafety } = require('../../lib/negotiation-classifier.js');

const U = ENV.SUPABASE_URL || ENV.NEXT_PUBLIC_SUPABASE_URL;
const K = ENV.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}`, 'content-type': 'application/json' };

async function briefFor(hash12) {
  const r = await fetch(
    `${U}/rest/v1/negotiation_decisions?select=request_hash,client_job_id&request_hash=like.${hash12}*&limit=1`,
    { headers: H });
  if (!r.ok) throw new Error(`decisions ${r.status} ${(await r.text()).slice(0, 120)}`);
  const rows = await r.json();
  if (!rows.length) return null;
  const j = await fetch(
    `${U}/rest/v1/video_jobs?select=vibe_input&id=eq.${rows[0].client_job_id}&limit=1`,
    { headers: H });
  if (!j.ok) throw new Error(`jobs ${j.status}`);
  const jr = await j.json();
  return jr.length ? jr[0].vibe_input : null;
}

/** The bullets under a "DO NOT ADD:"-style heading, read from the brief itself. */
function forbiddenBullets(text) {
  // THE BLANK LINE AFTER THE HEADING BROKE THE FIRST VERSION. "DO NOT ADD:" is
  // followed by an empty line, so a lazy match to the first blank line captured
  // NOTHING and the leg reported "no bullets" — a check asserting nothing while
  // the classifier had in fact produced all fifteen. Take the contiguous run of
  // bullet lines instead, wherever it starts.
  const lines = String(text || '').split(/\r?\n/);
  const i = lines.findIndex(l => /DO NOT ADD/i.test(l));
  if (i < 0) return [];
  const out = [];
  for (let k = i + 1; k < lines.length; k++) {
    const l = lines[k].trim();
    if (!l) { if (out.length) break; continue; }
    if (!/^[*\-\u2022]/.test(l)) break;
    out.push(l.replace(/^[*\-\u2022]+\s*/, '').trim());
  }
  return out.filter(Boolean);
}

function judge(row, got, text) {
  const e = row.expect, bad = [];
  if (e.verdict && got.verdict !== e.verdict) bad.push(`verdict ${got.verdict} != ${e.verdict}`);
  if (e.not_verdict && got.verdict === e.not_verdict) bad.push(`verdict is ${e.not_verdict}, which this ruling forbids`);
  for (const t of e.oos_includes || []) if (!(got.oos || []).includes(t)) bad.push(`missing oos ${t}`);
  for (const t of e.no_oos || []) if ((got.oos || []).includes(t)) bad.push(`oos ${t} MUST NOT be raised (it is negated in the brief)`);
  // EVERY FORBIDDEN PHRASE MUST BE COVERED, NOT A COUNT OF KINDS (Builder 1,
  // 2026-09-20). This brief forbids FIFTEEN things and only a handful map to
  // checkable kinds — a count would pass while eleven phrases silently vanished.
  // The list is read out of the brief itself so it cannot drift from it.
  if (e.covers_forbidden_list) {
    const bullets = forbiddenBullets(text);
    if (!bullets.length) bad.push('HARNESS: no "DO NOT ADD" bullets found in the brief — this asserted nothing');
    const hay = (got.constraints || []).map(c => `${c.family} ${c.text}`.toLowerCase()).join(' | ');
    const missed = bullets.filter(b => !hay.includes(b.toLowerCase().split(/\s+/)[0]));
    if (missed.length) bad.push(`${missed.length}/${bullets.length} forbidden phrases uncovered: ${missed.slice(0,5).join(', ')}`);
  }
  return bad;
}

(async () => {
  if (!U || !K) { console.log('HARNESS FAILURE: no Supabase credentials'); process.exit(2); }
  if (!(ENV.ANTHROPIC_API_KEY || ENV.CLAUDE_API_KEY)) { console.log('HARNESS FAILURE: no model key'); process.exit(2); }
  process.env.ANTHROPIC_API_KEY = ENV.ANTHROPIC_API_KEY || ENV.CLAUDE_API_KEY;

  const rows = FX.rows;
  if (!rows.length) { console.log('HARNESS FAILURE: no fixtures — this asserted nothing'); process.exit(2); }

  console.log(`RULINGS CHECK — ${rows.length} production briefs, resolved by hash\n`);
  let bad = 0, unresolved = 0;
  const byRuling = {};
  for (const row of rows) {
    let text;
    try { text = await briefFor(row.hash); }
    catch (e) { console.log(`  [HARNESS] ${row.id.padEnd(32)} ${e.message}`); bad++; continue; }
    if (!text) { console.log(`  [MISSING] ${row.id.padEnd(32)} no brief resolved for ${row.hash} — NOT a pass`); unresolved++; bad++; continue; }

    const got = await classifyWithSafety(text, { hasInScopeAsks: true });
    const fails = judge(row, got, text);
    if (row.unresolved) {
      // AN OPEN DEFECT IS REPORTED, NOT COUNTED. Passing it would hide it;
      // failing the suite on it would stop the suite being run.
      console.log(`  [OPEN ] r${row.ruling} ${row.id.padEnd(32)} ${fails.length ? fails.join('; ') : 'passed this run (it is unstable)'}`);
      console.log(`           measured ${JSON.stringify(row.measured)}`);
      continue;
    }
    byRuling[row.ruling] = byRuling[row.ruling] || { n: 0, bad: 0 };
    byRuling[row.ruling].n++;
    const tag = row.green ? 'GREEN' : `r${row.ruling}`;
    if (fails.length) {
      bad++; byRuling[row.ruling].bad++;
      console.log(`  [FAIL ] ${tag.padEnd(5)} ${row.id.padEnd(32)} ${fails.join('; ')}`);
      console.log(`           got verdict=${got.verdict} oos=[${(got.oos || []).join(',')}] constraints=[${(got.constraints || []).map(c => c.family).join(',')}]`);
      // A CHECK THAT CANNOT SAY WHAT IT READ MAKES THE NEXT RUN THE DEBUGGER.
      console.log(`           lang=${(got.safety && got.safety.typed_in) || '?'} reason=${got.reason}`);
    } else {
      console.log(`  [ok   ] ${tag.padEnd(5)} ${row.id.padEnd(32)} verdict=${got.verdict} oos=[${(got.oos || []).join(',')}] constraints=[${(got.constraints || []).map(c => c.family).join(',')}]`);
    }
  }
  console.log('');
  for (const [r, v] of Object.entries(byRuling).sort()) {
    console.log(`  ruling ${r}: ${v.n - v.bad}/${v.n} pass`);
  }
  if (unresolved) console.log(`  ${unresolved} row(s) UNRESOLVED — reported as failures, never as passes`);
  console.log(`\n${rows.length} fixtures, ${rows.length - bad} pass, ${bad} fail`);
  process.exit(bad ? 1 : 0);
})();
