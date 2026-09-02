'use strict';

// GATE — chat-actions stays dark, tool-driven, drift-free, and incapable of
// acting on anything it did not decide. Auto-discovered by validate_deploy.js
// (lib/__smoke_*.js glob); non-zero exit blocks every content-studio deploy.
//
// What regression each check makes impossible:
//   1. DARK-OFF     — PROMPTLY_CHAT_ACTIONS unset ⇒ enabled() false AND the
//      route answers 404 before auth (indistinguishable from no route).
//   2. NO-REGEX     — the three intent vocabularies are GONE and cannot come
//      back: no EDIT_VERB_RE / COMPONENT_NOUN_RE / PRIOR_REF_RE, no
//      classifyChatAction, no isStatusQuestion call in the decision path.
//   3. THE MISSES   — the three phrasings MEASURED as misses on the regex
//      build now resolve, and they resolve WITHOUT depending on any word list
//      (a nonsense change request resolves identically).
//   4. TOOL CONTRACT — exactly three declarations, each mapping to an endpoint
//      that already exists; every declared name is handled; an undeclared name
//      is loud, never silent.
//   5. STATUS IS NOT FORWARDED — get_job_status never produces an act_* and
//      the route never self-forwards it (selfForward is POST-only; status is a
//      GET; the DB oracle already answers it).
//   6. NO CAPABILITY TOKEN IN A PROMPT — a presigned video_url is a bearer
//      token in a query string and never enters the model prompt.
//   7. ID NEVER TRUSTED — a model-supplied job_id outside the caller's own
//      rows refuses BEFORE any self-forward.
//   8. CONSERVATISM — musing converses; no source clarifies; a rendering or
//      stale target clarifies; trivial input never even reaches the model.
//   9. FAIL-SAFE    — a model error or an empty candidate converses. A failed
//      decision must never become an action, and never a user-visible error.
//  10. NO DOUBLE DISPATCH — the confirmation turn is tool-disabled, so one
//      user message can never start two renders.
//  11. MODEL PIN    — the default model here EQUALS server.js's CHAT_MODEL
//      default and is not a rotating alias.
//  12. NO-PARALLEL-PATH — the route never requires server.js, documents its
//      one-line mount, and dispatches ONLY through the loopback self-forward.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

delete process.env.PROMPTLY_CHAT_ACTIONS;
const ca = require('./chat-actions');
const route = require('../routes/chat-actions');

const NOW = Date.parse('2026-08-09T12:00:00Z');
// A presigned S3 source URL: the ?X-Amz-Signature part is a bearer capability.
const PRESIGNED = 'https://s3.example.com/sources/u1/1754700000-clip.mp4?X-Amz-Signature=CAPABILITYTOKEN123';
const doneJob = { id: 'j1', status: 'completed', updated_at: '2026-08-09T08:00:00Z',
                  vibe_input: 'founder POV', video_url: PRESIGNED };
const staleJob = { id: 'j2', status: 'completed', updated_at: '2026-08-01T08:00:00Z',
                   vibe_input: 'old one', video_url: PRESIGNED };
const liveJob = { id: 'j3', status: 'processing', current_step: 'render',
                  updated_at: '2026-08-09T11:59:00Z', vibe_input: 'viral hype' };

// ── Gemini turn builders (offline; no network, no spend) ───────────────────
const gTool = (name, args) => ({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] });
const gText = (t) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });
const gEmpty = () => ({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] });

/** A stub model. Records every payload it is handed so the smoke can assert on
 *  what was SENT, not only on what came back. */
function stub(reply) {
  const calls = [];
  const fn = async (payload) => {
    calls.push(payload);
    if (typeof reply === 'function') return reply(payload, calls.length);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  fn.calls = calls;
  return fn;
}

// The exact context a completed-job user has.
const CTX = (over) => ({ nowMs: NOW, recentJobs: [doneJob], ...over });

(async () => {
  // ── 1. DARK-OFF (unchanged) ─────────────────────────────────────────────
  assert.strictEqual(ca.enabled(), false, 'enabled() must default false');
  let sent = null;
  await route.handle({ headers: {} }, {}, {
    sendJson: (_res, status, body) => { sent = { status, body }; },
  });
  assert.ok(sent && sent.status === 404, 'dark route must 404 before auth');

  // ── 2. NO-REGEX: the vocabularies cannot come back ──────────────────────
  for (const gone of ['EDIT_VERB_RE', 'COMPONENT_NOUN_RE', 'PRIOR_REF_RE',
                      'classifyChatAction']) {
    assert.strictEqual(ca[gone], undefined,
      `${gone} is back — intent decided by a hand-written word list is the exact `
      + 'defect this replaced; every phrasing outside the list is a miss BY '
      + 'CONSTRUCTION');
  }
  const LIB_SRC = fs.readFileSync(path.join(__dirname, 'chat-actions.js'), 'utf8');
  // CODE ONLY — the comments necessarily NAME the removed regexes to explain
  // why they went, and a check that reads its own documentation is not a check.
  const LIB_CODE = LIB_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/isStatusQuestion/.test(LIB_CODE),
    'the decision path calls chat-router.isStatusQuestion again — that is a regex '
    + 'intent classifier wearing a different hat; the MODEL routes to '
    + 'get_job_status and the DB oracle answers it');
  assert.ok(/statusAnswerFromJob/.test(
    fs.readFileSync(path.join(__dirname, '..', 'routes', 'chat-actions.js'), 'utf8')),
    'the status DB oracle left routes/chat-actions.js — status must stay answered '
    + 'from the job row, not forwarded');

  // ── 3. THE THREE CONFIRMED MISSES ───────────────────────────────────────
  // MEASURED on the regex build (commit cd9dc6e, fresh completed job in
  // context): all three returned converse/no_action_signal. They are the RED
  // cases. "make it viral" is deliberately NOT used — it MATCHED the old rule
  // (make + it), so it proves nothing.
  const MISSES = [
    'tighten the front half',            // no COMPONENT_NOUN, no PRIOR_REF
    'get rid of the silence at the start', // "get rid of" is not an EDIT_VERB
    'punch it up',                       // "punch" is not an EDIT_VERB
  ];
  for (const msg of MISSES) {
    const gen = stub(gTool('revise_edit', { change_request: msg }));
    const v = await ca.decideChatAction(msg, CTX({ generate: gen }));
    assert.strictEqual(v.kind, 'act_reedit',
      `MISS REGRESSED: "${msg}" no longer reaches the re-edit path — this is one of `
      + 'the three phrasings measured falling through to converse on the regex build');
    assert.strictEqual(v.changeRequest, msg,
      `"${msg}" must reach the worker VERBATIM — a paraphrased change_request is a `
      + 'different edit than the one the user asked for');
    assert.strictEqual(v.jobId, 'j1');
    assert.strictEqual(gen.calls.length, 1, 'exactly one decision turn per message');
  }

  // ...and the resolution does not depend on ANY vocabulary. A change request
  // made of words no human list would contain resolves identically — which is
  // the property a word list can never have.
  {
    const msg = 'frobnicate the wibbly bits in the middle';
    const v = await ca.decideChatAction(msg, CTX({ generate: stub(gTool('revise_edit', { change_request: msg })) }));
    assert.strictEqual(v.kind, 'act_reedit',
      'resolution is vocabulary-dependent again — the whole point is that it is not');
    assert.strictEqual(v.changeRequest, msg);
  }

  // ── 4. TOOL CONTRACT ────────────────────────────────────────────────────
  assert.deepStrictEqual(ca.TOOL_NAMES, ['create_edit', 'revise_edit', 'get_job_status'],
    'the tool set changed. A tool that does not map to an endpoint that already '
    + 'exists must not be declared — a callable the server cannot honour is a '
    + 'promise the product breaks');
  assert.strictEqual(ca.TOOL_DECLARATIONS.length, 3);
  for (const d of ca.TOOL_DECLARATIONS) {
    assert.ok(d.description && d.parameters && d.parameters.type === 'object',
      `tool ${d.name} is not a well-formed declaration`);
  }
  // Every declared name is HANDLED (no name can fall through to the unknown
  // branch, which is what "declared but unimplemented" would look like).
  for (const name of ca.TOOL_NAMES) {
    const v = ca.resolveToolCall({ kind: 'tool_call', name, args: {} },
      CTX({ hasVideoAttached: true }));
    assert.ok(!v.unknownTool, `declared tool ${name} is not handled by resolveToolCall`);
  }
  // An UNDECLARED name is loud and inert — never an action, never silent.
  {
    const v = ca.resolveToolCall({ kind: 'tool_call', name: 'delete_account', args: {} }, CTX());
    assert.strictEqual(v.kind, 'converse');
    assert.strictEqual(v.unknownTool, 'delete_account',
      'an unimplemented tool name must surface so chat_tool_unknown can count it');
  }

  // ── 5. STATUS IS NOT FORWARDED ──────────────────────────────────────────
  {
    const v = ca.resolveToolCall({ kind: 'tool_call', name: 'get_job_status', args: {} },
      CTX({ recentJobs: [liveJob] }));
    assert.strictEqual(v.kind, 'status', 'get_job_status must resolve to the DB oracle');
    assert.strictEqual(v.jobId, 'j3');
  }
  const ROUTE_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'chat-actions.js'), 'utf8');
  const ROUTE_CODE = ROUTE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.strictEqual((ROUTE_CODE.match(/selfForward\(PORT,/g) || []).length, 2,
    'there must be exactly TWO self-forwards (create + re-edit). A third means job '
    + 'status was turned into a forwarding tool — selfForward is POST-only, status '
    + 'is a GET, and the DB oracle already answers it');
  assert.ok(/method:\s*'POST'/.test(ROUTE_CODE) && !/method:\s*(authHeader|method)/.test(ROUTE_CODE),
    'selfForward is no longer hard-coded POST — generalising it to GET is new '
    + 'machinery for zero new capability');

  // ── 6. NO CAPABILITY TOKEN IN A PROMPT ──────────────────────────────────
  {
    const prompt = ca.buildToolSystemPrompt(CTX({ recentJobs: [doneJob, staleJob] }));
    assert.ok(!prompt.includes('X-Amz-Signature') && !prompt.includes(PRESIGNED)
      && !prompt.includes('s3.example.com'),
      'a PRESIGNED source URL reached the model prompt. That query string is a '
      + 'bearer capability token — the model is told only WHETHER a source exists');
    assert.ok(prompt.includes('id=j1') && prompt.includes('status=completed'),
      'the recent-jobs list is gone from the prompt — without it job_id is a field '
      + 'the model must hallucinate or omit, and "omit → most recent" silently '
      + 'becomes the only path that ever runs');
  }

  // ── 7. ID NEVER TRUSTED ─────────────────────────────────────────────────
  for (const name of ['revise_edit', 'get_job_status']) {
    const v = ca.resolveToolCall(
      { kind: 'tool_call', name, args: { job_id: 'someone-elses-job', change_request: 'x' } },
      CTX());
    assert.strictEqual(v.kind, 'refuse',
      `${name} accepted a job_id outside the caller's own rows. A model-supplied id `
      + 'is caller-influenced input; the caller can say anything to the model');
    assert.strictEqual(v.reason, 'job_not_yours');
  }

  // ── 8. CONSERVATISM (the good half of the old gate, through the new path) ─
  {
    // Trivial input never reaches the model at all.
    const gen = stub(gTool('create_edit', { vibe: 'x' }));
    const v = await ca.decideChatAction('...', CTX({ generate: gen }));
    assert.strictEqual(v.kind, 'converse', 'trivial converses');
    assert.strictEqual(gen.calls.length, 0, 'trivial input must not burn a model call');
  }
  {
    const v = await ca.decideChatAction('yellow captions might look nice someday',
      CTX({ generate: stub(gText('They can look great — want me to try it?')) }));
    assert.strictEqual(v.kind, 'converse', 'a text turn is ordinary conversation');
  }
  {
    const v = await ca.decideChatAction('make it cinematic',
      CTX({ hasVideoAttached: true, generate: stub(gTool('create_edit', { vibe: 'make it cinematic' })) }));
    assert.strictEqual(v.kind, 'act_render', 'video + text renders (composer semantics)');
    assert.strictEqual(v.source, 'attached');
  }
  {
    // No attached video and no explicit re-use → clarify, never a silent billed
    // render. There IS no upload registry to resolve "my last upload" against.
    const v = await ca.decideChatAction('make me something punchy',
      CTX({ generate: stub(gTool('create_edit', { vibe: 'punchy' })) }));
    assert.strictEqual(v.kind, 'clarify', 'create_edit without a source must clarify');
  }
  {
    // The one honourable no-attachment source: a previous job's stored video_url,
    // and only when the model explicitly asked for it.
    const v = await ca.decideChatAction('redo my last video but punchier',
      CTX({ generate: stub(gTool('create_edit', { vibe: 'punchier', use_last_source: true })) }));
    assert.strictEqual(v.kind, 'act_render');
    assert.strictEqual(v.source, 'last_job');
    assert.strictEqual(v.videoUrl, PRESIGNED, 'the SERVER supplies the URL, not the model');
  }
  {
    const v = await ca.decideChatAction('tighten the front half',
      CTX({ recentJobs: [liveJob], generate: stub(gTool('revise_edit', { change_request: 'tighten the front half' })) }));
    assert.strictEqual(v.kind, 'clarify', 'mid-render edit ask clarifies, never races');
    assert.strictEqual(v.reason, 'edit_ask_while_rendering');
  }
  {
    const v = await ca.decideChatAction('punch it up',
      CTX({ recentJobs: [staleJob], generate: stub(gTool('revise_edit', { change_request: 'punch it up' })) }));
    assert.strictEqual(v.kind, 'clarify',
      'an OMITTED job_id must not silently resolve to a stale job — that is us '
      + 'guessing, and guessing starts a billed render');
  }
  {
    // But an EXPLICIT id off the context list (which shows every job's age) is a
    // choice, and is honoured.
    const v = await ca.decideChatAction('punch it up',
      CTX({ recentJobs: [staleJob], generate: stub(gTool('revise_edit', { change_request: 'punch it up', job_id: 'j2' })) }));
    assert.strictEqual(v.kind, 'act_reedit', 'an explicitly named job is a choice, not a guess');
    assert.strictEqual(v.jobId, 'j2');
  }
  {
    const v = await ca.decideChatAction('change it',
      CTX({ generate: stub(gTool('revise_edit', {})) }));
    assert.strictEqual(v.kind, 'clarify', 'a revise call with no change_request must ask');
  }

  // ── 9. FAIL-SAFE ────────────────────────────────────────────────────────
  for (const [label, gen] of [
    ['model throws', stub(new Error('gemini_http_503'))],
    ['empty candidate', stub(gEmpty())],
  ]) {
    const v = await ca.decideChatAction('tighten the front half', CTX({ generate: gen }));
    assert.strictEqual(v.kind, 'converse',
      `${label}: a failed decision became an action. Fail loudly to us, never to the `
      + 'user — converse is the safe floor (the client falls through to /api/chat/stream)');
    assert.ok(/^(decide_failed|model_empty):/.test(v.reason),
      `${label}: the failure reason is not ledgered, so a broken decider would be invisible`);
  }

  // ── 10. NO DOUBLE DISPATCH ──────────────────────────────────────────────
  {
    const call = { kind: 'tool_call', name: 'revise_edit', args: { change_request: 'punch it up' } };
    const gen = stub(gText('Done — punching it up now.'));
    const msg = await ca.composeConfirmation({
      message: 'punch it up',
      verdict: { kind: 'act_reedit', turn: call },
      toolResult: { ok: true, job_id: 'j9' },
      ctx: { generate: gen },
    });
    assert.strictEqual(msg, 'Done — punching it up now.', 'the model writes the confirmation');
    const cfg = gen.calls[0].tool_config.function_calling_config;
    assert.strictEqual(cfg.mode, 'NONE',
      'the confirmation turn can call tools again — one user message could then '
      + 'start TWO renders');
    // Any failure falls back to the template; an action always says something.
    const fb = await ca.composeConfirmation({
      message: 'punch it up',
      verdict: { kind: 'act_reedit', turn: call },
      toolResult: { ok: true, job_id: 'j9' },
      ctx: { generate: stub(new Error('timeout')) },
    });
    assert.strictEqual(fb, ca.actionEcho('act_reedit'),
      'a failed confirmation turn must fall back to the template, never to silence');
  }
  // The DECISION turn, by contrast, must have the tools ON — mode NONE there
  // would silently turn every message into conversation.
  {
    const gen = stub(gText('hi'));
    await ca.decideChatAction('tighten the front half', CTX({ generate: gen }));
    const p = gen.calls[0];
    assert.strictEqual(p.tool_config.function_calling_config.mode, 'AUTO');
    assert.strictEqual(p.tools[0].function_declarations.length, 3,
      'the decision turn no longer carries all three declarations');
  }

  // ── 11. MODEL PIN — no drift from server.js, no alias ────────────────────
  {
    const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const sm = SERVER.match(/CHAT_MODEL\s*=\s*\(process\.env\.CHAT_MODEL\s*\|\|\s*'([^']+)'\)/);
    const lm = LIB_CODE.match(/process\.env\.CHAT_MODEL\s*\|\|\s*'([^']+)'/);
    assert.ok(sm && lm, 'the chat model default is no longer declared where it can be read');
    assert.strictEqual(lm[1], sm[1],
      `chat-actions pins "${lm[1]}" but server.js chat pins "${sm[1]}" — two model `
      + 'pins that can drift is how one surface silently moves onto a model with no '
      + 'provisioned quota');
    assert.ok(!/-latest$/.test(lm[1]),
      `the tool model "${lm[1]}" is a rotating ALIAS — an alias rotated onto a model `
      + 'with no provisioned quota and took chat to 100% 429');
  }

  // ── 12. NO-PARALLEL-PATH (unchanged) ────────────────────────────────────
  const src = ROUTE_SRC;
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

  // ── OPT-IN LIVE PROBE ───────────────────────────────────────────────────
  // Everything above is OFFLINE and deterministic: it proves the PATH — that a
  // revise_edit call for "tighten the front half" reaches the re-edit endpoint,
  // where the regex build structurally could not. It does NOT prove Gemini
  // EMITS that call; only a real turn can. That probe is opt-in and never in
  // the deploy path, because putting a live model call in render.yaml's
  // buildCommand would let a Gemini blip block every content-studio deploy.
  //   PROMPTLY_CHAT_TOOLS_LIVE=1 GEMINI_API_KEY=... node lib/__smoke_chat_actions.js
  if (/^(1|true|yes|on)$/i.test(String(process.env.PROMPTLY_CHAT_TOOLS_LIVE || ''))) {
    let livePass = 0;
    for (const msg of MISSES) {
      const v = await ca.decideChatAction(msg, CTX());
      const tool = v.turn && v.turn.kind === 'tool_call' ? v.turn.name : `(${v.reason})`;
      console.log(`   LIVE "${msg}" → tool=${tool} kind=${v.kind}`);
      if (v.kind === 'act_reedit') livePass++;
    }
    assert.strictEqual(livePass, MISSES.length,
      `LIVE probe: only ${livePass}/${MISSES.length} of the measured misses produced a `
      + 'revise_edit call. The path is right; the model or the tool descriptions are not');
    console.log(`chat-actions smoke: PASS (+ LIVE ${livePass}/${MISSES.length})`);
    process.exit(0);
  }

  console.log('chat-actions smoke: PASS (offline; ' + MISSES.length
    + ' measured misses resolve, tool set + dark flag + self-forward intact)');
  console.log('   note: live model probe NOT run — set PROMPTLY_CHAT_TOOLS_LIVE=1 '
    + 'with a GEMINI_API_KEY to verify the model actually emits the calls.');
  process.exit(0);
})().catch((e) => {
  console.error('chat-actions smoke: FAIL —', e && e.message);
  process.exit(1);
});
