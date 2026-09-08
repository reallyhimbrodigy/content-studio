'use strict';
// SMOKE — /api/account/delete removes the profile BEFORE the auth user.
//
// WHY THIS IS LOAD-BEARING, NOT TIDINESS. profiles_id_fkey is ON DELETE
// **NO ACTION** (measured from pg_constraint 2026-09-06). Deleting the auth user
// while the profile row exists raises a foreign-key violation, so the delete
// 500s and the user is left holding an account they cannot remove. Apple
// requires an in-app deletion path for any app with sign-in, so this is a review
// risk as well as a product one.
//
// The code used to CLAIM the opposite — a comment asserting the FK cascades —
// which is the dangerous kind of wrong: it invites someone to "simplify" by
// dropping the profiles delete, and the endpoint breaks for everyone.
//
// The FK map, for the record:
//   NO ACTION  profiles                          -> must be deleted first
//   SET NULL   video_jobs, chats                 -> orphan rather than block
//   CASCADE    usage_events, device_tokens, auth.* -> go automatically
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const fail = [];
const ok = (c, m) => { if (!c) fail.push(m); };

const i = SRC.indexOf("'/api/account/delete'");
ok(i > 0, 'the /api/account/delete endpoint is GONE — Apple requires an in-app '
        + 'account deletion path for any app with sign-in');

if (i > 0) {
  const end = SRC.indexOf("/api/admin/email-test", i);
  const body = SRC.slice(i, end > i ? end : i + 6000);

  // MUST be the delete inside the allSettled BATCH, not the one in the retry
  // block. Searching the whole handler found the retry and passed even with the
  // batch line deleted — a check that accepts either occurrence is checking
  // neither.
  const batchStart = body.indexOf('Promise.allSettled');
  const batchEnd = body.indexOf(']);', batchStart);
  const batch = batchStart > 0 ? body.slice(batchStart, batchEnd) : '';
  ok(batch.indexOf(".from('profiles').delete()") > 0,
     'the profiles delete is missing from the deletion BATCH — auth.admin.'
     + 'deleteUser will fail on profiles_id_fkey (ON DELETE NO ACTION) and the '
     + 'user cannot delete their account');
  const profDel = body.indexOf(".from('profiles').delete()");
  const authDel = body.indexOf('auth.admin.deleteUser');
  ok(profDel > 0, 'the profiles row is never deleted — auth.admin.deleteUser '
                + 'will fail on profiles_id_fkey and the user cannot delete '
                + 'their account');
  ok(authDel > 0, 'the auth user is never deleted');
  ok(profDel > 0 && authDel > 0 && profDel < authDel,
     'the auth user is deleted BEFORE the profile — guaranteed FK violation');

  // The guard that turns a swallowed failure into an honest error. Without it
  // the batch logs "continuing" and step 3 returns a generic auth_delete_failed
  // naming neither the table nor the constraint.
  const verify = body.indexOf('profile_delete_failed');
  ok(verify > 0,
     'nothing verifies the profiles row actually went before the auth delete — '
     + 'a failed profile delete is logged and skipped, and the user gets an '
     + 'opaque 500 they can never get past');
  ok(verify > profDel && verify < authDel,
     'the profile-deletion check does not sit between the batch and the auth delete');

  // The comment must not re-assert the false CASCADE claim.
  ok(!/profiles[\s\S]{0,80}FK has CASCADE/.test(body),
     'the comment claims profiles CASCADEs. It is ON DELETE NO ACTION — that '
     + 'claim is what invites deleting the load-bearing line');

  ok(/requireSupabaseUser\(req\)/.test(body),
     'the endpoint does not authenticate — anyone could delete any account');
  // indexOf returns -1 when ABSENT, and -1 < profDel is true — so an ordering
  // check alone passes when auth is removed entirely. Presence first.
  const authAt = body.indexOf('requireSupabaseUser');
  ok(authAt >= 0 && authAt < profDel,
     'authentication is absent or does not precede the deletes');
}

if (fail.length) {
  console.error('FAIL __smoke_account_deletion:');
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log('ok __smoke_account_deletion — endpoint exists, authenticated, '
  + 'profile deleted before auth user, absence verified with an honest error, '
  + 'no false CASCADE claim');
