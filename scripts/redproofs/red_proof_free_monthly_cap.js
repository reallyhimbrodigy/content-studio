// RED proof for the free monthly cap. Each mutation restores a plausible
// wrong version; the smoke must go red on the NAMED leg.
const fs = require('fs'), cp = require('child_process'), path = require('path');
const ROOT  = path.join(__dirname, '..', '..');
const SMOKE = path.join(ROOT, 'lib', '__smoke_free_monthly_cap.js');
const CAP   = path.join(ROOT, 'lib', 'free-monthly-cap.js');
const SRV   = path.join(ROOT, 'server.js');

const M = [
  // The cap ships DARK — the shape nine features have already died of here.
  ['cap_ships_dark', CAP,
   "  return String(env.FREE_MONTHLY_CAP_ENABLED ?? '1') !== '0';",
   "  return String(env.FREE_MONTHLY_CAP_ENABLED ?? '0') === '1';",
   // L1, not L6: with the cap dark, the FIRST leg to read capState already
   // reads DISABLED and fires. L6's explicit-env leg would catch it too; the
   // proof names what actually fires, not what ought to.
   'L1'],
  // The cap reaches builds that DO have a claim path — two limiters on one
  // request, showing a credit-holding user the wrong refusal.
  ['cap_leaks_onto_247', CAP,
   "  if (build >= claimMinBuild) return 'HAS_CLAIM_PATH';",
   "  if (build > 9999) return 'HAS_CLAIM_PATH';",
   'L3'],
  // An unreadable build caps the user at one video a month on a guess.
  ['unknown_build_fails_closed', CAP,
   "  if (!Number.isInteger(build)) return 'BUILD_UNKNOWN';",
   "  if (!Number.isInteger(build)) return 'APPLIES';",
   'L5'],
  // The refusal states a balance that cannot exist — 246 routes kind:'credits'
  // into insufficientCredits(needed:balanceKnown:).
  ['refusal_states_a_balance', CAP,
   "    kind: 'render',\n    limit: n,",
   "    kind: 'credits',\n    limit: n,",
   'L7'],
  // The copy loses the window and reads as a daily cap.
  ['copy_drops_the_window', CAP,
   "      ? `You've used your free video for this month.${proVideos ? ` Pro includes ${proVideos} videos a month.` : ''}`",
   "      ? `You've used your free video.`",
   'L7'],
  // RC unreachable is treated as "RC says free" — a 402 at someone who may
  // have paid thirty seconds ago.
  ['rc_unreachable_refuses', CAP,
   "  if (rcCheck === 'FAILED') {",
   "  if (rcCheck === '__never__') {",
   'L8'],
  // ...and the mirror: every state becomes retryable, so the cap is
  // unenforceable for anyone who has ever subscribed.
  ['rc_negative_also_retries', CAP,
   "  if (rcCheck === 'FAILED') {",
   "  if (rcCheck !== '__never__') {",
   'L9'],
  // The monthly claim gains the racy fallback the daily one has — silently
  // returning the whole cohort to unlimited whenever the RPC is absent.
  ['monthly_claim_gains_a_racy_fallback', SRV,
   "      console.error('[usage] claim_monthly_slot IS NOT DEPLOYED — apply '\n        + 'supabase/migrations/20260924_claim_monthly_slot.sql. Refusing rather than '\n        + 'falling back to an uncapped free tier.');\n      const e = new Error('monthly_claim_unavailable'); e.statusCode = 503; throw e;",
   "      const today = await countTodayUsage(userId, kind);\n      if (today >= monthlyLimit) return { ok: false };\n      await logUsageEvent(userId, kind);\n      return { ok: true };",
   'L11'],
  // Nothing ever assigns FAILED — the 503 branch becomes dead code and an RC
  // outage silently 402s a paying user. THIS IS THE ONE A SOURCE GREP MISSES
  // if it does not strip comments: the word FAILED survives in the prose.
  ['nothing_ever_sets_failed', SRV,
   "      _rcCheck = 'FAILED';",
   "      _rcCheck = 'NEGATIVE';",
   'L11'],
  // The claim is never given back — our failure costs the user their month.
  ['claim_is_never_released', SRV,
   "  async function releaseMonthlyUsage(userId, kind) {",
   "  async function releaseMonthlyUsage_RENAMED(userId, kind) {",
   'L11'],
  // A free-tier door that does NOT ask about the RC state — the shape that
  // 402s a user who may have paid whenever RevenueCat is unreachable.
  ['a_reedit_door_skips_the_rc_state', SRV,
   "          const _r = _monthlyCap.refusalForRcState(entitlement.rcCheck, {\n            error: 'pro_required',\n            kind: 'reedit',",
   "          const _r = { status: 402, body: {\n            error: 'pro_required',\n            kind: 'reedit',",
   'L12'],
];

const run = () => { try { const o = cp.execFileSync(process.execPath, [SMOKE], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }); return { code: 0, out: o }; } catch (e) { return { code: e.status, out: (e.stdout||'') + (e.stderr||'') }; } };

const base = run();
if (base.code !== 0) { console.error('HARNESS FAILURE: unmutated smoke is not green'); console.error(base.out.slice(-800)); process.exit(2); }
console.log('baseline green.\n');
let red = 0;
for (const [name, file, from, to, leg] of M) {
  const raw = fs.readFileSync(file, 'utf8');
  const n = raw.split(from).length - 1;
  if (n !== 1) { console.log(`  ${name.padEnd(38)} HARNESS FAILURE: anchor ${n}x in ${path.basename(file)}`); continue; }
  fs.writeFileSync(file, raw.replace(from, to));
  const r = run();
  fs.writeFileSync(file, raw);
  const named = r.out.includes(leg + ':');
  const ok = r.code !== 0 && named;
  if (ok) red++;
  console.log(`  ${name.padEnd(38)} ${ok ? 'RED ' : 'NOT RED'}  exit=${r.code} names_${leg}=${named}`);
  if (!ok) console.log('      | ' + r.out.trim().split('\n').slice(-4).join(' | ').slice(0, 300));
}
console.log(`\n${red}/${M.length} RED-proven`);
process.exit(red === M.length ? 0 : 1);
