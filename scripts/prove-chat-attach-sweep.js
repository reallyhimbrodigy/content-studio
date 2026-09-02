#!/usr/bin/env node
'use strict';

// ── PROVE THE CHAT-ATTACH SWEEP EXECUTES, ON DEMAND ─────────────────────────
//
// FRONTEND has held the Library merge for two sessions on one sentence: "the
// sweep executes on live completions." The census says every completed render
// is in a chat (still_stranded = 0 of 5,406) and the inline path has been
// observed repairing exactly one real orphan — but the BACKSTOP has no rate,
// because after the backfill no organic orphan has appeared, and one may not
// for days. Waiting is not evidence, and neither is a unit test.
//
// So this MAKES the condition the sweep exists for, and watches production
// answer. A completed render with a deliverable and no chat message is exactly
// the state a dropped client PATCH leaves behind; the sweep's whole job is to
// notice it within 10 minutes and reconstruct the chat.
//
// WHAT IT WILL AND WILL NOT TOUCH:
//
//   · It CREATES one job row, marked with a TEST-PREFIXED id where the column
//     allows it (the bleed meter already excludes e2e-/test-/smoke- ids, so the
//     cost digest stays honest without anyone remembering to filter).
//   · It NEVER edits an existing user's chat. The obvious cheaper trick —
//     delete a real render's message and watch it come back — degrades a real
//     person's history for up to ten minutes to prove a point about our code.
//   · It DELETES both rows at the end, pass or fail, so the organic
//     denominators stay clean. A synthetic row left behind would show up in
//     read_chat_attach_live.py as a server_reconstructed and quietly turn a
//     controlled proof into a fake organic one.
//
//     node scripts/prove-chat-attach-sweep.js --user <uuid> [--wait 900]

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { deterministicChatId } = require('../lib/chat-attach');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const userId = arg('--user');
  const waitS = Number(arg('--wait', '900'));
  if (!url || !key || !userId) {
    console.error('need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and --user <uuid>');
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  // A test-prefixed id if the column is text; a uuid otherwise. Either way the
  // row is deleted at the end — the prefix is belt, the cleanup is braces.
  let jobId = `smoke-sweep-${crypto.randomUUID()}`;
  const row = () => ({
    id: jobId,
    user_id: userId,
    status: 'completed',
    vibe_input: 'SYNTHETIC sweep proof — auto-deleted; not a real render',
    // video_url is the SOURCE and is NOT NULL on this table — the first attempt
    // omitted it and the insert was rejected. Modelled on a real completed row
    // rather than guessed a second time.
    video_url: 'https://d1iax8jos987n3.cloudfront.net/synthetic/sweep-proof-source.mp4',
    rendered_video_url: 'https://d1iax8jos987n3.cloudfront.net/synthetic/sweep-proof.mp4',
    source_type: 'local',
    created_at: new Date().toISOString(),
  });

  let created = false;
  try {
    let { error } = await db.from('video_jobs').insert(row());
    if (error && /invalid input syntax for type uuid/i.test(error.message || '')) {
      console.log('  id column is uuid — test prefix not usable, falling back');
      jobId = crypto.randomUUID();
      ({ error } = await db.from('video_jobs').insert(row()));
    }
    if (error) throw new Error(`insert failed: ${error.message}`);
    created = true;
    console.log(`  created synthetic completed render ${jobId}`);

    // It must START orphaned, or the test proves nothing.
    const filt = JSON.stringify([{ jobId }]);
    const { data: pre } = await db.from('chats').select('id')
      .eq('user_id', userId).contains('messages', filt).limit(1);
    if (pre && pre.length) throw new Error('already in a chat — probe is vacuous');
    console.log('  confirmed ORPHANED (in no chat) — the sweep now has its condition');

    const want = deterministicChatId(jobId);
    console.log(`  waiting up to ${waitS}s for the sweep to reconstruct ${want.slice(0, 8)}…`);
    const t0 = Date.now();
    let attached = null;
    while ((Date.now() - t0) / 1000 < waitS) {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await db.from('chats').select('id, messages')
        .eq('id', want).limit(1);
      if (data && data.length) { attached = data[0]; break; }
      // eslint-disable-next-line no-await-in-loop
      await sleep(20000);
      process.stdout.write('.');
    }
    console.log('');
    if (!attached) {
      console.error(`  *** NOT ATTACHED after ${waitS}s — the sweep is NOT executing `
        + `on live completions. This is the finding; do not report the census as `
        + `if it covered the backstop.`);
      process.exitCode = 1;
    } else {
      const msg = (attached.messages || []).find((m) => m && m.jobId === jobId);
      const ok = msg && msg.renderedVideoUrl && msg.jobStatus === 'completed';
      console.log(`  ATTACHED in ${Math.round((Date.now() - t0) / 1000)}s — chat `
        + `${attached.id.slice(0, 8)} holds the render message, playable=${Boolean(msg
        && msg.renderedVideoUrl)}, status=${msg && msg.jobStatus}`);
      if (!ok) { console.error('  *** but the message is malformed'); process.exitCode = 1; }
    }
  } catch (e) {
    console.error('  FAILED:', e && e.message);
    process.exitCode = 1;
  } finally {
    // ALWAYS. A synthetic row left behind becomes a fake organic signal in
    // every denominator that follows it.
    try {
      await db.from('chats').delete().eq('id', deterministicChatId(jobId));
      if (created) await db.from('video_jobs').delete().eq('id', jobId);
      console.log('  cleaned up: synthetic chat + job row deleted');
    } catch (e) {
      console.error(`  *** CLEANUP FAILED — remove job ${jobId} and chat `
        + `${deterministicChatId(jobId)} by hand: ${e && e.message}`);
      process.exitCode = 1;
    }
  }
})();
