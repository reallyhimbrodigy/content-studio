'use strict';

// GATE (LANE-SEAM Step 4) — chat-actions stays dark, conservative, and
// drift-free. Auto-discovered by validate_deploy.js (lib/__smoke_*.js glob).
//
// What regression each check makes impossible:
//   1. DARK-OFF   — PROMPTLY_CHAT_ACTIONS unset ⇒ enabled() false AND the
//      route answers 404 before auth (indistinguishable from no route).
//   2. CONSERVATISM — the ACT verdicts fire only on explicit imperative +
//      resolvable context; musing converses; missing context clarifies;
//      mid-render edit asks clarify (never race, never drop).
//   3. VERB-DRIFT — every imperative verb chat-router's status vetoer knows
//      is also an EDIT verb here (the two lists may not diverge, or an edit
//      instruction could classify as a status question in one layer and an
//      action in the other).
//   4. NO-PARALLEL-PATH — the route module never requires server.js and
//      documents the one-line mount; dispatch goes through selfForward
//      (loopback to the SAME endpoints), which resolves rather than throwing
//      even when the server is down.

const assert = require('assert');

delete process.env.PROMPTLY_CHAT_ACTIONS;
const ca = require('./chat-actions');
const route = require('../routes/chat-actions');

const NOW = Date.parse('2026-08-09T12:00:00Z');
const doneJob = { id: 'j1', status: 'completed', updated_at: '2026-08-09T08:00:00Z' };
const staleJob = { id: 'j2', status: 'completed', updated_at: '2026-08-01T08:00:00Z' };
const liveJob = { id: 'j3', status: 'processing', updated_at: '2026-08-09T11:59:00Z' };

(async () => {
  // 1. DARK-OFF
  assert.strictEqual(ca.enabled(), false, 'enabled() must default false');
  let sent = null;
  await route.handle({ headers: {} }, {}, {
    sendJson: (_res, status, body) => { sent = { status, body }; },
  });
  assert.ok(sent && sent.status === 404, 'dark route must 404 before auth');

  // 2. CONSERVATISM
  const c = (msg, ctx) => ca.classifyChatAction(msg, { nowMs: NOW, ...ctx });
  assert.strictEqual(c('...', {}).kind, 'converse', 'trivial converses');
  assert.strictEqual(c('make it cinematic', { hasVideoAttached: true }).kind,
    'act_render', 'video + text renders (composer semantics)');
  assert.strictEqual(c('is my video done yet?', { recentJob: liveJob }).kind,
    'status', 'status question answers deterministically');
  const re = c('make the captions yellow', { recentJob: doneJob });
  assert.strictEqual(re.kind, 'act_reedit', 'imperative + component + fresh job re-edits');
  assert.strictEqual(re.jobId, 'j1');
  assert.strictEqual(re.changeRequest, 'make the captions yellow');
  assert.strictEqual(c('make the captions yellow', { recentJob: liveJob }).kind,
    'clarify', 'mid-render edit ask clarifies, never races');
  assert.strictEqual(c('make the captions yellow', {}).kind,
    'clarify', 'no context clarifies, never drops');
  assert.strictEqual(c('make the captions yellow', { recentJob: staleJob }).kind,
    'clarify', 'stale job does not silently resolve');
  assert.strictEqual(c('yellow captions might look nice someday', { recentJob: doneJob }).kind,
    'converse', 'musing without an imperative converses');
  assert.strictEqual(c('what can you do?', { recentJob: doneJob }).kind,
    'converse', 'capability question converses');

  // 3. VERB-DRIFT — chat-router's veto verbs ⊆ EDIT_VERB_RE
  for (const v of ['make', 'add', 'remove', 'cut', 'trim', 'zoom', 'slow',
                   'speed', 'caption', 'edit', 'put', 'use', 'give', 'show',
                   'create']) {
    assert.ok(ca.EDIT_VERB_RE.test(v),
      `verb drift: '${v}' is a chat-router veto verb but not an edit verb here`);
  }

  // 4. NO-PARALLEL-PATH
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'chat-actions.js'), 'utf8');
  assert.ok(!/require\(['"][^'"]*server(\.js)?['"]\)/.test(src),
    'routes/chat-actions.js must never require server.js');
  assert.ok(src.includes("parsed.pathname === '/api/chat/actions'"),
    'the one-line mount spec comment is gone');
  assert.ok(src.includes("selfForward(PORT, '/api/video-jobs'"),
    'render dispatch no longer self-forwards to the composer endpoint');
  assert.ok(src.includes("selfForward(PORT, '/api/video-jobs/re-edit'"),
    're-edit dispatch no longer self-forwards to the re-edit endpoint');
  const dead = await route.selfForward(1, '/nope', null, {});
  assert.ok(dead && typeof dead.status === 'number',
    'selfForward must resolve (never throw) when the server is unreachable');

  console.log('chat-actions smoke: PASS');
  process.exit(0);
})().catch((e) => {
  console.error('chat-actions smoke: FAIL —', e && e.message);
  process.exit(1);
});
