'use strict';
// RULING 4 — the stratified hand-check sample for the D4 dark read.
//
// THE JOIN PROBLEM, AND WHY IT IS SOLVED THIS WAY. The shadow table stores a
// sha256 of the brief and never the brief itself, so it cannot become a second
// copy of user content. But judging a FALSE POSITIVE requires reading the
// brief. So the text is fetched from video_jobs (the one place it already
// lives) and matched by RECOMPUTING the hash — the shadow table stays clean and
// the check still gets what it needs. Read-only on both.
//
// STRATIFIED, AND DELIBERATELY NOT RANDOM. A uniform sample of 20 would be
// mostly generative_vfx and music in English, because that is where the volume
// is, and it would miss the two places false positives are KNOWN to cluster:
//   - NEGATED asks ("do NOT apply any beauty filter") — a constraint read as a
//     request. This exact brief ranked #10 in the backlog before the precedence
//     rule, 10 jobs, all completed.
//   - DESCRIPTIONS of the user's own footage ("my vertical video",
//     "Tamil-English mixed voiceover") — the source described, not requested.
// Both are over-weighted on purpose. A sample that flatters the classifier is
// worth nothing; this one is aimed at where it is most likely wrong.
const crypto = require('crypto');
const ENV = require('./env.js')();
const U = ENV.SUPABASE_URL, K = ENV.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}` };

const NEGATED = /\b(do ?n.?t|dont|do not|no|not|without|never|avoid|skip|keep (my|the|it) natural|nicht|não|nao|нет|tanpa|sin )\b/i;
const SELF_DESCRIBING = /\b(my|this|the) (vertical|horizontal|portrait|landscape|\w+-language|\w+ mixed)?\s?(video|clip|footage|voiceover|audio|recording)\b/i;

async function page(q) {
  const out = []; let from = 0;
  for (;;) {
    const r = await fetch(`${U}/rest/v1/${q}`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
    const b = await r.json();
    out.push(...b);
    if (b.length < 1000) break;
    from += 1000;
  }
  return out;
}

(async () => {
  const sinceIso = process.argv[2] || new Date(Date.now() - 24 * 3600e3).toISOString();
  const decisions = await page(`negotiation_decisions?select=*&created_at=gte.${sinceIso}&order=created_at.asc`)
    .catch(e => { console.error(`[handcheck] shadow table unreadable (${e.message}) — has the migration landed?`); return []; });

  if (!decisions.length) {
    console.log(JSON.stringify({ state: 'ABSENT', since: sinceIso,
      why: 'no rows in negotiation_decisions for the window — either the migration has not landed, or the deploy has not run for 24h yet. NOT zero: nothing has been recorded.' }, null, 1));
    process.exit(0);
  }

  // recompute the hash over recent briefs to recover the text for review only
  const jobs = await page(`video_jobs?select=id,created_at,vibe_input&created_at=gte.${sinceIso}`);
  const byHash = new Map();
  for (const j of jobs) {
    const h = crypto.createHash('sha256').update(String(j.vibe_input || '')).digest('hex');
    if (!byHash.has(h)) byHash.set(h, j.vibe_input);
  }

  const parked = decisions.filter(d => d.verdict !== 'PASS');
  const rows = parked.map(d => {
    const text = byHash.get(d.request_hash) || null;
    return { ...d, text,
      negated: text ? NEGATED.test(text) : false,
      self_desc: text ? SELF_DESCRIBING.test(text) : false };
  });

  // ── the read Zac asked for: by class and by language ──────────────────
  const byClass = {}, byLang = {}, byDecider = {};
  for (const d of decisions) {
    for (const c of (d.classes || [])) byClass[c] = (byClass[c] || 0) + 1;
    byLang[d.language || 'unknown'] = (byLang[d.language || 'unknown'] || 0) + 1;
    byDecider[d.decider || 'none'] = (byDecider[d.decider || 'none'] || 0) + 1;
  }
  console.log(`=== D4 DARK READ — ${sinceIso} to now ===`);
  console.log(`decisions recorded: ${decisions.length}   WOULD HAVE BEEN PARKED: ${parked.length} (${(100 * parked.length / decisions.length).toFixed(1)}%)`);
  console.log(`  refused: ${decisions.filter(d => d.verdict === 'REFUSE').length}   negotiated: ${decisions.filter(d => d.verdict === 'NEGOTIATE').length}`);
  console.log(`  degraded (model leg unavailable): ${decisions.filter(d => d.degraded).length}`);
  console.log(`\nby class:    ${JSON.stringify(byClass)}`);
  console.log(`by language: ${JSON.stringify(byLang)}`);
  console.log(`by decider:  ${JSON.stringify(byDecider)}`);
  console.log(`brief text recovered for ${rows.filter(r => r.text).length}/${rows.length} parked rows`);

  // ── the 20, weighted toward where it is most likely wrong ─────────────
  const take = [];
  const push = (r) => { if (r && !take.find(x => x.id === r.id)) take.push(r); };
  for (const r of rows.filter(r => r.negated)) { if (take.length < 7) push(r); }
  for (const r of rows.filter(r => r.self_desc)) { if (take.length < 12) push(r); }
  const classes = [...new Set(rows.flatMap(r => r.classes || []))];
  const langs = [...new Set(rows.map(r => r.language).filter(Boolean))];
  for (const c of classes) push(rows.find(r => (r.classes || []).includes(c) && !take.find(x => x.id === r.id)));
  for (const l of langs) push(rows.find(r => r.language === l && !take.find(x => x.id === r.id)));
  for (const r of rows) { if (take.length < 20) push(r); }

  console.log(`\n=== HAND-CHECK SAMPLE (${take.length}) — weighted to negated asks and self-descriptions ===`);
  take.slice(0, 20).forEach((r, i) => {
    console.log(`\n#${String(i + 1).padStart(2)} ${r.verdict}  [${(r.classes || []).join(',')}]  lang=${r.language}  by=${r.decider}` +
      `${r.negated ? '  NEGATED?' : ''}${r.self_desc ? '  SELF-DESC?' : ''}`);
    console.log(`    brief: ${r.text ? JSON.stringify(r.text.replace(/\s+/g, ' ').slice(0, 150)) : '(text not recovered — job outside the window)'}`);
    console.log(`    would say: ${r.sentence ? JSON.stringify(r.sentence.slice(0, 120)) : '(refusal — no sentence)'}`);
    console.log(`    VERDICT: [ ] correct   [ ] FALSE POSITIVE   because: ______`);
  });
})();
