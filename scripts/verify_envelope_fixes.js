// VERIFICATION PROBE for the envelope-loss + delivery fixes [Law 2].
//
// Run this against traffic that post-dates BOTH deploys:
//   content-studio b6eceb7 (predicate + CAS + evidence-repair + RMW audit)
//   worker v530 = 5ba82c1 (worker_envelope_write instrument)
//
// THE THREE THINGS IT ANSWERS, in the order they settle:
//   1. worker_envelope_write rows with accepted=false  -> the hard-terminal
//      fence is dropping envelopes (NEVER-ARRIVED at the row, and the fix is
//      in the fence). accepted=true on a row that still has no envelope ->
//      OVERWRITE, and the fix is a different one entirely.
//   2. envelope-absent % -> should fall from the 38-46% baseline.
//   3. delivery mix -> callback should START APPEARING and become the
//      majority. It was 0/465 only because _delivered read the wrong shape
//      and the reconciler stole every stamp.
//
// Do not read it before there is a real denominator: n<100 says nothing, and
// a small-sample zero is the exact class this codebase keeps paying for.
//
//   node scripts/verify_envelope_fixes.js
require('dotenv').config({ path: process.env.ENV_FILE || '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  const { data: ev } = await sb.from('analytics_events')
    .select('created_at,props').eq('event','worker_envelope_write')
    .order('created_at',{ascending:false}).limit(20);
  console.log(`\n  worker_envelope_write rows so far: ${(ev||[]).length}`);
  for (const e of (ev||[]).slice(0,6)) {
    const p=e.props||{};
    console.log(`    ${e.created_at.slice(11,19)} job=${String(p.job_id).slice(0,8)} accepted=${p.accepted} matched=${p.matched} terminal=${p.terminal} status=${p.status} keys=${(p.result_keys||[]).length}`);
  }
  const { data: cd } = await sb.from('analytics_events')
    .select('created_at,props').eq('event','delivery_stamp_lost')
    .order('created_at',{ascending:false}).limit(5);
  console.log(`  delivery_stamp_lost rows: ${(cd||[]).length}`);
  // post-deploy cohort
  const { data } = await sb.from('video_jobs')
    .select('id,created_at,result,completion_delivery')
    .eq('status','completed').gte('created_at', process.env.SINCE || '2026-08-15T00:00:00Z').limit(200);
  const rows=data||[]; let a=0; const by={};
  for (const r of rows){const e=r.result||{};
    if(!(e.stage_timings&&(e.video_url||e.public_url||e.rendered_video_url)))a++;
    by[r.completion_delivery||'(null)']=(by[r.completion_delivery||'(null)']||0)+1;}
  console.log(`\n  POST-DEPLOY cohort (created >= 2026-08-15T00:00Z): n=${rows.length}`);
  if (rows.length) console.log(`    envelope-absent ${a}/${rows.length} = ${(100*a/rows.length).toFixed(1)}%   delivery mix: ${JSON.stringify(by)}`);
  else console.log('    no completions yet in the post-deploy window — verification needs traffic');
})();
