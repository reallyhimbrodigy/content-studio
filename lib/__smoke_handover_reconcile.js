'use strict';
// GATE: a completed job that never reaches a chat must PAGE.
//
// THE DEFECT (2026-09-07): 17 completed jobs across 8 users had every delivery
// column populated — rendered_video_url, HLS, thumbnail, result — and NO CHAT
// referencing them. The client renders videos out of chat bubbles, so those
// users watched nothing arrive while every server-side metric said success.
// Newest instance was from that same day on 1.3.27: still growing.
//
// SAME CLASS AS THE 08-02 PROJECTION FAILURE, ONE LAYER LATER. That one was
// "rendered but the delivery columns are NULL"; this is "columns are fine but
// nothing hands them over". Both are a finished video that never reached its
// owner, and both stayed invisible because every check stopped at the layer it
// owned and passed.

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'completion-reconcile.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const mod = require('./completion-reconcile');

const fail = [];
const check = (label, cond, detail) => { if (!cond) fail.push(label + (detail ? `  :: ${detail}` : '')); };

check('the detector is exported', typeof mod.findUnhandedOverCompletions === 'function');
check('the sweep is exported', typeof mod.reconcileHandover === 'function');
check('it runs in the existing completion sweep', server.includes('reconcileHandover('));

// MATCH ON THE FIELD, NOT THE BLOB. A substring search over messages::text also
// matches a job id a user quoted inside their own prompt, which would mark a
// genuinely stranded job as delivered and hide it forever.
check('it matches m.jobId, not a substring of the messages blob',
  src.includes("m.jobId") && !src.includes("messages::text like"),
  'a user quoting a job id in their prompt would otherwise read as delivered');

// ONE QUERY FOR CHATS. A LIKE over the jsonb per job is a sequential scan each
// time; the sweep runs every 2 minutes.
check('chats are fetched once, not per job',
  (src.match(/from\('chats'\)/g) || []).length === 1);

// IT DETECTS, IT DOES NOT REPAIR. The missing artifact is a chat the CLIENT
// writes; manufacturing one server-side is a recovery decision, not a
// reconciliation, and a sweep that invents user messages is worse than one that
// pages.
check('the handover sweep never writes',
  !/reconcileHandover[\s\S]*?\.update\(|reconcileHandover[\s\S]*?\.insert\(/.test(src),
  'a sweep that manufactures chats is inventing user data');

// LOUD, and per USER first (Rule 7).
check('it pages on every occurrence', src.includes('[ALERT] undelivered handover'));
check('it leads with the user count', /users\.size\} user\(s\)/.test(src),
  'a user with five stranded videos is one lost user, not five failures');

// A GRACE PERIOD, because the client writes the chat moments after completion
// and the sweep runs every 2 minutes.
check('there is a grace period', typeof mod.HANDOVER_GRACE_MINUTES === 'number'
  && mod.HANDOVER_GRACE_MINUTES > 0,
  'without it every healthy in-flight job pages, and a check that cries wolf '
  + 'gets switched off');

// OWNERLESS JOBS ARE A SEPARATE CLASS — all 34 are demo rows written with no
// user at creation. Nobody is missing them, and paging on them would be noise.
check('ownerless jobs are excluded', src.includes("not('user_id', 'is', null)"));

// A CRASH HERE MUST NOT STOP THE REPAIR THAT SELF-HEALS REAL DAMAGE.
check('the new sweep has its own try/catch in server.js',
  /reconcileHandover\(supabaseAdmin\);[\s\S]{0,200}?catch \(hErr\)/.test(server),
  'the 08-02 projection repair has been fixing user-visible damage since '
  + 'August and must not be taken down by a newer detector');

if (fail.length) {
  console.error(`❌ handover reconcile (${fail.length}):`);
  fail.forEach((f) => console.error('   - ' + f));
  process.exit(1);
}
console.log('✅ handover reconcile wired (11 checks)');
