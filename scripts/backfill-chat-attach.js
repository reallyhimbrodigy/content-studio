#!/usr/bin/env node
'use strict';

// ── §8.2 BACKFILL: every completed render that is in no chat ────────────────
//
// The historical half of SERVER_CHAT_ATTACH_SPEC. The runtime attach (inline +
// the 10-minute sweep) stops NEW renders stranding; this clears the ones that
// already did — 498 completed videos across 441 users at the time the spec was
// written, each a paid, rendered, playable file its owner cannot reach.
//
// WHY NOT THE SQL. IOS_LIBRARY_MERGE_MIGRATION.sql does this in three
// statements and is correct. It is also a SECOND IMPLEMENTATION of a shape that
// already has one, and its comment has to CLAIM the message shape matches the
// runtime attach. This runs the runtime attach itself — the same
// attachRenderToChat, the same derived primary key, the same delivery fields —
// so the two converge by construction rather than by assertion, and every
// property already RED-proven for the sweep holds here too.
//
// It is idempotent for the same reason the sweep is: a chat's id is
// uuidv5("chat:"+job_id), so re-running collides on the primary key instead of
// duplicating, and any render that gained a chat in between is found by the
// containment lookup and skipped.
//
// STAGED, because it writes to hundreds of real users' histories:
//
//   node scripts/backfill-chat-attach.js                 # dry run, counts only
//   node scripts/backfill-chat-attach.js --apply --limit 3
//   node scripts/backfill-chat-attach.js --apply
//
// The first batch is verified before the rest runs. That order is not caution
// theatre: the last staged heal in this repo caught a real contradiction on its
// first three rows.

const { createClient } = require('@supabase/supabase-js');
const { attachRenderToChat, deterministicChatId } = require('../lib/chat-attach');

const PAGE = 1000;   // PostgREST's default cap — page explicitly, never assume

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : (process.argv[i + 1] || true);
}

async function pageAll(db, table, select, tune) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = db.from(table).select(select).range(from, from + PAGE - 1);
    if (tune) q = tune(q);
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await q;
    if (error) throw new Error(`${table} page ${from}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

(async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });
  const apply = process.argv.includes('--apply');
  const limit = Number(arg('--limit', 0)) || 0;

  // 1. Every jobId that ANY chat already references. One pass over chats beats
  //    a containment query per job by three orders of magnitude, and the
  //    per-job lookup still runs inside attachRenderToChat as the real guard.
  console.log('  scanning chats…');
  const chats = await pageAll(db, 'chats', 'id, messages');
  const referenced = new Set();
  for (const c of chats) {
    for (const m of (c.messages || [])) {
      if (m && typeof m === 'object' && m.jobId) referenced.add(String(m.jobId));
    }
  }
  console.log(`  ${chats.length} chats reference ${referenced.size} distinct jobIds`);

  // 2. Every completed render.
  console.log('  scanning completed renders…');
  const jobs = await pageAll(
    db, 'video_jobs',
    'id, user_id, created_at, vibe_input, rendered_video_url, hls_manifest_url, thumbnail_url',
    (q) => q.eq('status', 'completed').not('rendered_video_url', 'is', null)
      .order('created_at', { ascending: true }),
  );
  const stranded = jobs.filter((j) => j.rendered_video_url && !referenced.has(String(j.id)));
  const users = new Set(stranded.map((j) => j.user_id));
  console.log(`\n  STRANDED: ${stranded.length} renders / ${users.size} users `
    + `(out of ${jobs.length} completed)   [Rule 7: the user count is the one that matters]`);
  if (!stranded.length) { console.log('  nothing to backfill.'); return; }
  if (!apply) {
    console.log('  (dry run — pass --apply, and stage it: --limit 3 first)');
    console.log(`  first 5: ${stranded.slice(0, 5).map((j) => j.id.slice(0, 8)).join(', ')}`);
    return;
  }

  const batch = limit ? stranded.slice(0, limit) : stranded;
  console.log(`  APPLYING to ${batch.length} render(s)…`);
  const tally = {};
  const done = [];
  for (const job of batch) {
    // eslint-disable-next-line no-await-in-loop
    const r = await attachRenderToChat(db, job, { log: { log() {}, error() {} } });
    tally[r.reason] = (tally[r.reason] || 0) + 1;
    if (r.attached) done.push(job);
    else console.error(`    ${job.id.slice(0, 8)} NOT attached -> ${r.reason}`);
  }
  console.log(`  outcomes: ${JSON.stringify(tally)}`);

  // 3. VERIFY — read back, do not assume. A backfill that reports success from
  //    its own return value has verified nothing.
  console.log('\n  VERIFY (read back from the database):');
  let ok = 0;
  for (const job of done.slice(0, 200)) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await db.from('chats').select('id, messages')
      .eq('id', deterministicChatId(job.id)).limit(1);
    const chat = (data || [])[0];
    const msg = chat && (chat.messages || []).find((m) => m && m.jobId === job.id);
    if (msg && msg.renderedVideoUrl && msg.jobStatus === 'completed') ok += 1;
    else console.error(`    *** ${job.id.slice(0, 8)} did not verify`);
  }
  console.log(`  ${ok}/${Math.min(done.length, 200)} verified: chat exists, holds the `
    + 'render message, playable and marked completed');
  process.exit(ok === Math.min(done.length, 200) ? 0 : 1);
})().catch((e) => { console.error('BACKFILL FAILED:', e && e.message); process.exit(1); });
