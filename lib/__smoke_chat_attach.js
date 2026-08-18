'use strict';
// Real-path smoke for server-authoritative chat membership.
//
// THE DEFECT: 498 completed videos across 441 users have a jobId that appears
// in NO chat (140 in the last 7 days). The message referencing a render is
// written by the CLIENT as a debounced PATCH of the whole `messages` jsonb, and
// a backgrounded session drops it. The render is paid for, playable, and
// unreachable.
//
// Load-bearing assertions — each one is a way this could ship green and still
// lose data:
//   * healing an existing bubble RE-MERGES after a lost CAS instead of
//     re-issuing the array it read — the client PATCHes this same column from
//     the device, so a blind retry is the lost-update that cost 180 completions
//     their result envelope;
//   * a CAS it cannot win DECLINES (the sweep retries) rather than overwriting;
//   * reconstruction is idempotent by DERIVED PRIMARY KEY, so a duplicate-key
//     error is success, not failure — check-then-act would leave a window;
//   * a render with no deliverable NEVER attaches (a playable bubble on a
//     failed job is a worse lie than a missing one);
//   * an already-correct chat performs ZERO writes (a backstop that rewrites
//     every pass is a write amplifier, not a backstop).

const assert = require('assert');
const {
  uuidv5, deterministicChatId, deterministicMessageId, healMessages,
  attachRenderToChat, sweepChatAttach, deliveryFields,
} = require('./chat-attach');

const JOB = {
  id: 'ba2d6b36-0000-0000-0000-000000000000',
  user_id: 'u-1',
  created_at: '2026-08-10T10:00:00+00:00',
  vibe_input: 'make it punchy',
  rendered_video_url: 'https://cdn/v.mp4',
  hls_manifest_url: 'https://cdn/m.m3u8',
  thumbnail_url: 'https://cdn/t.jpg',
};

/** Mock PostgREST.
 *
 *  TWO PROPERTIES THIS MOCK MUST HAVE, both learned the hard way — the first
 *  version of it had neither, and the blind-retry mutation (the lost update
 *  itself, the most important regression here) passed GREEN against it:
 *
 *    1. READS RETURN SNAPSHOTS. Handing back live references into the store
 *       makes a stale read impossible to simulate — the "stale" object silently
 *       tracks later writes, so re-reading and NOT re-reading look identical.
 *    2. THE CAS IS ENFORCED BY VALUE, as Postgres does — an update matches zero
 *       rows unless its updated_at guard equals the row's CURRENT value. A mock
 *       that decides success from a counter instead tests nothing about the
 *       guard, which is the whole mechanism under test.
 *
 *  `concurrentWrites` simulates the client's own PATCH landing between our read
 *  and our write, N times, by moving the row — which is what makes the CAS fail
 *  for real rather than by fiat. */
function mockDb({ chats = [], jobs = {}, insertError = null, concurrentWrites = 0 } = {}) {
  const calls = { updates: [], inserts: [], casGuards: [], reads: 0 };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let racesLeft = concurrentWrites;
  const store = { chats: clone(chats) };
  return {
    calls,
    store,
    from(table) {
      const st = { table, filters: {}, contains: null, update: null, guard: undefined, guarded: false };
      const b = {
        eq: (k, v) => {
          st.filters[k] = v;
          if (st.update && k === 'updated_at') { st.guard = v; st.guarded = true; calls.casGuards.push([k, v]); }
          return b;
        },
        is: (k, v) => {
          if (st.update && k === 'updated_at') { st.guard = null; st.guarded = true; calls.casGuards.push([k, v]); }
          return b;
        },
        contains: (k, v) => { st.contains = v; return b; },
        not: () => b,
        gte: () => b,
        order: () => b,
        update: (u) => { st.update = u; return b; },
        insert: (row) => { calls.inserts.push(row); return Promise.resolve({ error: insertError }); },
        maybeSingle: () => Promise.resolve({ data: jobs[st.filters.id] || null, error: null }),
        select: (...a) => {
          if (!st.update) return b;
          calls.updates.push(clone(st.update));
          // The client's debounced PATCH lands first, moving the row.
          if (racesLeft > 0) {
            racesLeft -= 1;
            const c = store.chats.find((x) => x.id === st.filters.id);
            if (c) {
              c.updated_at = `moved-${racesLeft}`;
              c.messages = [...c.messages,
                { id: 'client-added', role: 'user', content: 'and add music' }];
            }
          }
          const c = store.chats.find((x) => x.id === st.filters.id);
          if (!c) return Promise.resolve({ data: [], error: null });
          // THE CAS, by value. This is the assertion the mock exists to make.
          if (st.guarded && c.updated_at !== st.guard) {
            return Promise.resolve({ data: [], error: null });
          }
          c.messages = clone(st.update.messages);
          c.updated_at = st.update.updated_at;
          return Promise.resolve({ data: [{ id: c.id }], error: null });
        },
        limit: () => {
          calls.reads += 1;
          const want = st.contains && st.contains[0] && st.contains[0].jobId;
          const rows = store.chats.filter((c) => (
            (!st.filters.user_id || c.user_id === st.filters.user_id)
            && (!want || (c.messages || []).some((m) => m && m.jobId === want))
          ));
          return Promise.resolve({ data: clone(rows), error: null });   // SNAPSHOT
        },
      };
      return b;
    },
  };
}

const chatWithProcessingBubble = () => ([{
  id: 'chat-existing', user_id: 'u-1', updated_at: '2026-08-10T10:05:00+00:00',
  messages: [
    { id: 'm0', role: 'user', content: 'make it punchy' },
    {
      id: 'm1', role: 'assistant', content: '', jobId: JOB.id,
      jobStatus: 'processing', jobProgress: 40, originalVibe: 'make it punchy',
      cachedSourceUrl: 'https://cdn/src.mp4',   // a key we must never touch
    },
  ],
}]);

(async () => {
  // ── 1. derived ids are stable, distinct, and real uuids ──────────────────
  assert.strictEqual(deterministicChatId(JOB.id), deterministicChatId(JOB.id), 'stable');
  assert.notStrictEqual(deterministicChatId(JOB.id), deterministicChatId('other'), 'per-job');
  assert.notStrictEqual(deterministicChatId(JOB.id), deterministicMessageId(JOB.id),
    'chat and message ids must not collide');
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    .test(uuidv5('x')), 'must be a valid RFC 4122 v5 uuid');

  // ── 2. healing fills delivery fields and touches NOTHING else ────────────
  const { next, changed } = healMessages(chatWithProcessingBubble()[0].messages, JOB);
  assert.strictEqual(changed, true);
  const healed = next.find((m) => m.jobId === JOB.id);
  assert.strictEqual(healed.jobStatus, 'completed');
  assert.strictEqual(healed.renderedVideoUrl, 'https://cdn/v.mp4');
  assert.strictEqual(healed.hlsManifestUrl, 'https://cdn/m.m3u8');
  assert.strictEqual(healed.jobProgress, 100, 'a stale mid-render progress must be finished');
  assert.strictEqual(healed.cachedSourceUrl, 'https://cdn/src.mp4',
    'a key we did not put there must survive untouched');
  assert.strictEqual(healed.content, '', 'content is the client\'s, never ours');
  assert.strictEqual(next[0].id, 'm0', 'other messages must be left alone');

  // ── 3. an already-correct chat performs ZERO writes ──────────────────────
  const current = [{
    id: 'chat-ok', user_id: 'u-1', updated_at: 't0',
    messages: [{ id: 'm1', role: 'assistant', jobId: JOB.id, ...deliveryFields(JOB) }],
  }];
  const dbOk = mockDb({ chats: current });
  const okRes = await attachRenderToChat(dbOk, JOB, { log: { log() {}, error() {} } });
  assert.strictEqual(okRes.attached, true);
  assert.strictEqual(okRes.reason, 'already_current');
  assert.strictEqual(dbOk.calls.updates.length, 0,
    'a backstop that rewrites an already-correct chat is a write amplifier');

  // ── 4. the heal CASes on updated_at ──────────────────────────────────────
  const dbHeal = mockDb({ chats: chatWithProcessingBubble() });
  const healRes = await attachRenderToChat(dbHeal, JOB, { log: { log() {}, error() {} } });
  assert.strictEqual(healRes.reason, 'healed_in_place');
  assert.ok(dbHeal.calls.casGuards.some(([k, v]) => k === 'updated_at' && v === '2026-08-10T10:05:00+00:00'),
    'the write MUST be guarded by the updated_at it read — without the CAS this '
    + 'is the lost update that erased 180 result envelopes');

  // ── 5. THE LOST-UPDATE LAW: a lost CAS re-merges, never re-issues ────────
  const dbRace = mockDb({ chats: chatWithProcessingBubble(), concurrentWrites: 1 });
  const raceRes = await attachRenderToChat(dbRace, JOB, { log: { log() {}, error() {} } });
  assert.strictEqual(raceRes.attached, true, 'a single CAS loss must still converge');
  assert.strictEqual(dbRace.calls.updates.length, 2, 'exactly one retry');
  const finalWrite = dbRace.calls.updates[1].messages;
  assert.ok(finalWrite.some((m) => m.id === 'client-added'),
    'THE WHOLE POINT: the winning write must contain the message the client added '
    + 'between our read and our write. Re-issuing the first array would erase it.');
  assert.ok(finalWrite.some((m) => m.jobId === JOB.id && m.jobStatus === 'completed'),
    'and it must still carry our heal');

  // ── 6. a CAS it cannot win DECLINES rather than clobbering ───────────────
  const dbLost = mockDb({ chats: chatWithProcessingBubble(), concurrentWrites: 99 });
  const lostRes = await attachRenderToChat(dbLost, JOB, { log: { log() {}, error() {} } });
  assert.strictEqual(lostRes.attached, false);
  assert.strictEqual(lostRes.reason, 'cas_exhausted');
  assert.ok(dbLost.calls.updates.length <= 3, 'bounded retries, never a spin');

  // ── 7. THE LEAK CASE: no chat at all → reconstruct, sorted into history ──
  const dbNew = mockDb({ chats: [] });
  const newRes = await attachRenderToChat(dbNew, JOB, { log: { log() {}, error() {} } });
  assert.strictEqual(newRes.reason, 'chat_reconstructed');
  const created = dbNew.calls.inserts[0];
  assert.strictEqual(created.id, deterministicChatId(JOB.id), 'PK derived from the job');
  assert.strictEqual(created.user_id, 'u-1');
  assert.strictEqual(created.title, 'make it punchy');
  assert.strictEqual(created.created_at, JOB.created_at,
    'must sort into real history, not jump to the top of the list');
  const bubble = created.messages.find((m) => m.jobId === JOB.id);
  assert.strictEqual(bubble.role, 'assistant');
  assert.strictEqual(bubble.jobStatus, 'completed');
  assert.strictEqual(bubble.renderedVideoUrl, 'https://cdn/v.mp4');
  assert.strictEqual(bubble.originalVibe, 'make it punchy');

  // ── 8. duplicate key is SUCCESS — that is the idempotency working ────────
  const dbDup = mockDb({ chats: [], insertError: { code: '23505', message: 'duplicate key value' } });
  const dupRes = await attachRenderToChat(dbDup, JOB, { log: { log() {}, error() {} } });
  assert.strictEqual(dupRes.attached, true);
  assert.strictEqual(dupRes.reason, 'raced_already_created');

  // ── 9. a render with NO deliverable never attaches ───────────────────────
  const failed = await attachRenderToChat(mockDb({}), { ...JOB, rendered_video_url: null },
    { log: { log() {}, error() {} } });
  assert.strictEqual(failed.attached, false);
  assert.strictEqual(failed.reason, 'no_deliverable');
  assert.strictEqual((await attachRenderToChat(mockDb({}), { id: 'x' })).reason, 'incomplete_job_row');

  // ── 10. missing columns are fetched only on the reconstruct path ─────────
  const dbLazy = mockDb({ chats: [], jobs: { [JOB.id]: { vibe_input: 'from db', created_at: '2026-08-09T09:00:00+00:00' } } });
  const lazy = await attachRenderToChat(dbLazy, {
    id: JOB.id, user_id: 'u-1', rendered_video_url: 'https://cdn/v.mp4',
  }, { log: { log() {}, error() {} } });
  assert.strictEqual(lazy.attached, true);
  assert.strictEqual(dbLazy.calls.inserts[0].title, 'from db',
    'the completion tail has no vibe_input in scope — it must be fetched here');
  assert.strictEqual(dbLazy.calls.inserts[0].created_at, '2026-08-09T09:00:00+00:00');

  // ── 11. the sweep repairs only what is missing, and is LOUD ──────────────
  const attached = {
    id: 'chat-has', user_id: 'u-2', updated_at: 't0',
    messages: [{ id: 'm', role: 'assistant', jobId: 'job-attached', ...deliveryFields(JOB) }],
  };
  const dbSweep = mockDb({ chats: [attached] });
  dbSweep.from = ((orig) => (table) => {
    if (table !== 'video_jobs') return orig(table);
    const b = {
      select: () => b, eq: () => b, not: () => b, gte: () => b, order: () => b,
      limit: () => Promise.resolve({
        data: [
          { ...JOB, id: 'job-attached', user_id: 'u-2' },   // already in a chat
          { ...JOB, id: 'job-orphan', user_id: 'u-3' },     // the leak
        ],
        error: null,
      }),
    };
    return b;
  })(dbSweep.from.bind(dbSweep));
  const logged = [];
  const swept = await sweepChatAttach(dbSweep, { log: { error: (m) => logged.push(m), log() {} } });
  assert.strictEqual(swept.scanned, 2);
  assert.strictEqual(swept.missing, 1, 'only the orphan is missing');
  assert.strictEqual(swept.attached, 1);
  assert.strictEqual(dbSweep.calls.inserts.length, 1, 'the attached render is not touched');
  assert.strictEqual(dbSweep.calls.inserts[0].user_id, 'u-3');
  assert.ok(logged.some((m) => m.includes('[ALERT]')),
    'every repair must alert — a silent self-heal is how this class hides');

  console.log('[smoke] chat attach: ALL PASS (re-merges after a lost CAS; declines rather '
    + 'than clobbers; idempotent by derived PK; no deliverable never attaches)');
})().catch((e) => { console.error('[smoke] FAILED:', e && e.message); process.exit(1); });
