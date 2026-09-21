'use strict';
// THE DUPLICATION CHECK MUST NOT REPORT A CLEAN ZERO WHEN IT COULD NOT LOOK.
//
// Second-device sign-in depends on Supabase's automatic email linking. Measured
// 2026-09-21: 0 emails on 2+ accounts across 20,544. If that setting changes,
// nothing errors — a user quietly gets a second account and finds out when
// their videos are gone. So the invariant is read hourly and alerted on.
//
// The failure mode of such a check is not missing the duplication. It is
// reporting ZERO because the read failed, which is indistinguishable from
// health and is exactly the class this repo keeps getting bitten by: a Supabase
// 503 once made every failure class read 0 and looked like a recovery.
//
// Exit 0 = clean. Exit 1 = the check can go blind quietly.
const fs = require('fs');
const path = require('path');
const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations',
  '20260921_identity_duplication_check.sql'), 'utf8');
const bad = [];

// 1. the check exists and is scheduled — a check nobody runs is a comment
if (!/runIdentityDuplicationCheck/.test(srv)) bad.push('the duplication check is gone');
if (!/setInterval\(runIdentityDuplicationCheck/.test(srv))
  bad.push('the check is never scheduled — it would run at most once at boot');

// 2. A FAILED READ IS NOT ZERO. This is the whole point.
const fn = srv.slice(srv.indexOf('const runIdentityDuplicationCheck'),
                     srv.indexOf('setTimeout(runIdentityDuplicationCheck'));
// ISOLATE THE ERROR BRANCH. The first version of this check searched the whole
// function for `ok: false` — which the catch block also contains — and gated the
// zero-count test on the ABSENCE of `ok: true`, which the success path always
// supplies. So a mutation that made the error branch write
// `{ duplicateEmails: 0 }` passed clean. The property is about THAT BRANCH.
const errStart = fn.indexOf('if (error || !row)');
const errEnd = fn.indexOf('identityDuplication = {', fn.indexOf('return;', errStart));
const errBranch = errStart >= 0 && errEnd > errStart ? fn.slice(errStart, errEnd) : '';
if (!errBranch) {
  bad.push('the failed-read branch is gone — a read that fails would fall through to the '
         + 'success path and publish whatever it found');
} else {
  if (!/ok:\s*false/.test(errBranch))
    bad.push('the failed-read branch no longer marks ok:false — it would render as a clean '
           + 'zero, which is the failure this check exists to avoid');
  if (/duplicateEmails\s*:/.test(errBranch))
    bad.push('the failed-read branch WRITES A COUNT — "could not look" and "looked and found '
           + 'none" would become indistinguishable');
  if (!/CANNOT READ/.test(errBranch))
    bad.push('the failed-read branch no longer logs CANNOT READ');
}
const catchStart = fn.indexOf('} catch (e) {');
if (catchStart < 0 || !/ok:\s*false/.test(fn.slice(catchStart)))
  bad.push('the throw path no longer marks ok:false');

// 3. it must ALERT when non-zero, not merely record
if (!/\[ALERT\] identity duplication/.test(fn))
  bad.push('a non-zero count no longer raises [ALERT] — it would sit in a health field nobody reads');
if (!/duplicateEmails\s*>\s*0/.test(fn))
  bad.push('the alert is no longer conditioned on a non-zero count');

// 4. readable from outside
if (!/identityDuplication,/.test(srv))
  bad.push('identityDuplication is no longer on /api/health');
if (!/let identityDuplication = null/.test(srv))
  bad.push('the holder no longer starts null — starting at zero means "never looked" and '
         + '"looked and found none" render identically before the first pass');

// 5. COUNTS ONLY. An address in a log or a health payload is a worse trade than
//    the check is worth.
if (/SELECT\s+.*\bemail\b.*FROM auth\.users/i.test(mig.replace(/lower\(email\)/g, 'X'))
    && !/RETURNS TABLE\(duplicate_emails int, worst_count int, users_with_email int\)/.test(mig))
  bad.push('the RPC may return email addresses — it must return counts only');
if (!/GRANT EXECUTE ON FUNCTION public\.identity_duplication_check\(\) TO service_role/.test(mig))
  bad.push('the RPC is not granted to service_role');
if (!/REVOKE ALL ON FUNCTION public\.identity_duplication_check\(\) FROM PUBLIC, anon, authenticated/.test(mig))
  bad.push('the RPC is not revoked from anon/authenticated — it reads auth.users under '
         + 'SECURITY DEFINER and must not be callable by a signed-in client');
if (!/SET search_path = public, auth, pg_temp/.test(mig))
  bad.push('the SECURITY DEFINER function has no pinned search_path');

if (bad.length) {
  console.log('identity-duplication: FAIL');
  for (const b of bad) console.log('  -', b);
  process.exit(1);
}
console.log('  scheduled hourly; a failed read marks ok:false and logs CANNOT READ rather than '
  + 'zero; non-zero raises [ALERT]; the RPC returns counts only and is service_role-only.');
console.log('identity-duplication: PASS');
