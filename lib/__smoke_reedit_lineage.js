'use strict';

// GATE — re-edit lineage is written ON THE INSERT, and rooted at the TOP of the
// tree rather than at the parent.
//
// THE WINDOW THIS CLOSES. parent_job_id used to reach the row only through
// dispatchJobToModal({ parentJobId }), i.e. AFTER the insert. In that window
// the row exists with no parent: a /versions read places the re-edit as its own
// ROOT instead of a version of its parent, and the one-at-a-time guard — keyed
// on root_job_id — does not see it under the right root at all. Same
// check-then-act shape as client_message_id, which is written on the insert for
// exactly this reason and is three lines above it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fail = [];
const ok = (c, m) => { if (!c) fail.push(m); };
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ── ON THE INSERT ──────────────────────────────────────────────────────────
const insertAt = src.indexOf('.insert(insertRow)');
ok(insertAt > 0, 'the video_jobs insert moved — this gate cannot locate it');
for (const col of ['parent_job_id', 'root_job_id']) {
  const at = src.indexOf(`insertRow.${col} =`);
  ok(at >= 0, `insertRow.${col} is never set — lineage is not on the insert`);
  // PRESENCE FIRST: indexOf returns -1 when absent and -1 < insertAt is true,
  // so an ordering check alone passes when the assignment is deleted entirely.
  ok(at >= 0 && at < insertAt,
     `insertRow.${col} is assigned AFTER the insert — that is the window, not a fix`);
}

// ── ROOTED AT THE TOP OF THE TREE, NOT AT THE PARENT ───────────────────────
// Lineage is a tree: 114 re-edits over 97 parents, 29 of them children of
// re-edits, up to 4 siblings on one parent. rootJobId: originalJobId would give
// two siblings the same ordinal, which is the bug the root column exists for.
ok(/rootJobId:\s*orig\.root_job_id/.test(src),
   'the re-edit does not pass the PARENT\'S ROOT as rootJobId — anchoring at the '
   + 'parent hands siblings the same version number');
ok(!/rootJobId:\s*originalJobId\b/.test(src),
   'rootJobId is set to the parent id. Lineage is a TREE; that is depth, and '
   + 'depth collides on siblings');

// ── THE READ MUST CARRY IT, OR THE FALLBACK SILENTLY LIES ──────────────────
// `orig.root_job_id || orig.id` is correct ONLY when the select actually
// fetched root_job_id. Drop it from the select and orig.root_job_id is
// undefined, so EVERY re-edit falls back to orig.id — which roots a child at
// its PARENT rather than the top. For a re-edit of a re-edit (29 rows in prod)
// that is a wrong root, a wrong ordinal, and a one-at-a-time guard watching the
// wrong lock. Nothing throws.
const reeditSel = src.match(/\.select\('id, user_id, status, video_url, vibe_input, edit_recipe, transcript[^']*'\)/);
ok(!!reeditSel, 'the re-edit source select moved — this gate cannot locate it');
ok(!!reeditSel && /\broot_job_id\b/.test(reeditSel[0]),
   'the re-edit reads its parent WITHOUT root_job_id, so orig.root_job_id is '
   + 'undefined and every re-edit silently falls back to rooting at its parent');

if (fail.length) {
  console.error('FAIL __smoke_reedit_lineage:');
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log('ok __smoke_reedit_lineage — parent_job_id and root_job_id written on '
  + 'the INSERT, rooted at the top of the tree, and the parent read carries the root');
