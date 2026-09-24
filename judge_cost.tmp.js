// WHAT THE JUDGE COST — token side MEASURED via Anthropic's count_tokens
// (free, no generation), on REAL rows from the days it actually ran, using
// the judge's own SYSTEM + TOOL + user-message construction.
require('dotenv').config({ path: '/Users/zaclibman/content-studio/.env.local', quiet: true });
const path = require('path');
const fs = require('fs');
const KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
const URL_ = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: SKEY, Authorization: `Bearer ${SKEY}` };

// Pull the judge's own SYSTEM/TOOL/extractEvidence without running its main().
const src = fs.readFileSync(path.join(__dirname, 'scripts', 'fulfillment-judge.js'), 'utf8')
  .replace(/^\(async \(\) => \{[\s\S]*$/m, '')          // drop main
  .replace(/^require\('dotenv'\)[\s\S]*?\n/m, '')
  + '\nmodule.exports = { SYSTEM, TOOL, extractEvidence };\n';
const tmp = '/tmp/_judge_parts.js';
fs.writeFileSync(tmp, src);
const { SYSTEM, TOOL, extractEvidence } = require(tmp);

const MODEL = 'claude-haiku-4-5-20251001';
const PRICE_IN = 1.0, PRICE_OUT = 5.0;   // USD per Mtok, the script's own figures

(async () => {
  // A real due-day cohort, exactly as the judge selects it.
  const r = await fetch(`${URL_}/rest/v1/video_jobs?status=eq.completed`
    + `&created_at=gte.2026-09-22T00:00:00Z&created_at=lt.2026-09-23T00:00:00Z`
    + `&select=id,created_at,vibe_input,change_request,edit_recipe,er2:result->edit_recipe,`
    + `notes:result->capability_notes,route:result->>route&order=created_at.asc&limit=1000`,
    { headers: H });
  const rows = (await r.json()).map(x => ({ ...x, edit_recipe: x.edit_recipe || x.er2 || null }))
    .filter(x => x.edit_recipe);
  console.log(`cohort for one due-day (2026-09-22): ${rows.length} recipe-bearing completions`);

  // Sample across the cohort rather than the head — prompt size tracks recipe
  // size, and the first N rows of a day are not a random draw.
  const step = Math.max(1, Math.floor(rows.length / 12));
  const sample = rows.filter((_, i) => i % step === 0).slice(0, 12);
  let tot = 0; const each = [];
  for (const job of sample) {
    const user = [
      `USER REQUEST (vibe_input): ${JSON.stringify(job.vibe_input || '')}`,
      job.change_request ? `RE-EDIT CHANGE REQUEST: ${JSON.stringify(job.change_request)}` : null,
      `PRESET-MATCH (exact string used by >=20 jobs): false`,
      `RECIPE EVIDENCE: ${JSON.stringify(extractEvidence(job))}`,
      `CAPABILITY_NOTES: ${JSON.stringify(job.notes || [])}`,
    ].filter(Boolean).join('\n');
    const cr = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, system: SYSTEM, tools: [TOOL],
        messages: [{ role: 'user', content: user }] }),
    });
    const j = await cr.json();
    if (j.error) { console.error('count_tokens error:', j.error.message); process.exit(1); }
    each.push(j.input_tokens); tot += j.input_tokens;
  }
  each.sort((a, b) => a - b);
  const mean = tot / each.length;
  console.log(`\ninput tokens per call, MEASURED over ${each.length} real jobs (count_tokens, free):`);
  console.log(`  min ${each[0]}  median ${each[Math.floor(each.length / 2)]}  max ${each[each.length - 1]}  mean ${mean.toFixed(0)}`);
  console.log(`  (system + tool schema is the floor; the variable part is the recipe evidence)`);

  // Output side: max_tokens 1500, tool_choice forced. The historical run gives
  // the real ratio — FULFILLMENT_BASELINE reports 3,766 asks over 1,607 jobs.
  const OUT_EST = 260;   // a forced tool_use with ~2.3 asks; conservative
  const perCall = mean / 1e6 * PRICE_IN + OUT_EST / 1e6 * PRICE_OUT;
  console.log(`\nper call: $${perCall.toFixed(5)}  (in ${mean.toFixed(0)} tok @ $${PRICE_IN}/Mtok + out ~${OUT_EST} tok @ $${PRICE_OUT}/Mtok)`);
  fs.writeFileSync('/tmp/judge_cost.json', JSON.stringify({ meanIn: mean, outEst: OUT_EST, perCall, cohort: rows.length }));
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
