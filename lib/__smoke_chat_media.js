'use strict';

// CHAT MEDIA — the reference contract (§1)
//
// The boundary this pins is an AUTHORISATION boundary wearing the costume of a
// serialisation format. `chat-media/{user_id}/...` means the ownership check IS
// the parse, so the assertions below are not shape tests — each one is "can user
// A reach user B's image".
//
// Also pinned: the wire shape on BOTH tiers. /api/chat and /api/chat/stream have
// already drifted apart once (parts[0] was fixed on the streaming path and left
// broken on the one-shot path for weeks, turning good replies into 502s), so the
// two entrances are asserted to emit through the SAME function.

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const cm = require('./chat-media');
const U = '11111111-2222-3333-4444-555555555555';
const V = '99999999-8888-7777-6666-555555555555';

const failures = [];
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures.push(`${name} — ${e.message}`); console.log(`  FAIL ${name} — ${e.message}`); }
}

// ── 1. OWNERSHIP IS STRUCTURAL ─────────────────────────────────────────────
check('a key built for user A is owned by A', () => {
  const k = cm.buildKey(U, 'image/jpeg', 'photo.jpg');
  assert.ok(k.startsWith(`chat-media/${U}/`), k);
  assert.strictEqual(cm.assertOwnedKey(U, k), k);
});

check("user B CANNOT resolve user A's key", () => {
  const k = cm.buildKey(U, 'image/jpeg', 'photo.jpg');
  assert.throws(() => cm.assertOwnedKey(V, k), /forbidden_key/);
  assert.strictEqual(cm.ownsKey(V, k), false);
});

check('a forged key naming the caller but under another prefix is rejected', () => {
  // The attack: keep the caller's uuid so a naive `includes(userId)` passes,
  // but point the prefix at the world-readable bucket root.
  assert.throws(() => cm.assertOwnedKey(U, `sources/${U}/secret.mp4`), /forbidden_key/);
  assert.throws(() => cm.assertOwnedKey(U, `exports/${U}/clean.mp4`), /forbidden_key/);
});

check('path traversal cannot escape the owner prefix', () => {
  for (const bad of [
    `chat-media/${U}/../${V}/photo.jpg`,
    `chat-media/${U}/..%2F..%2Fexports%2Fclean.mp4`,
    `chat-media/${V}/../${U}/photo.jpg`,
    `../chat-media/${U}/photo.jpg`,
  ]) assert.throws(() => cm.assertOwnedKey(U, bad), /forbidden_key/, bad);
});

check('a traversal filename cannot be BUILT into a key', () => {
  const k = cm.buildKey(U, 'image/png', '../../etc/passwd');
  assert.ok(!k.includes('..'), k);
  assert.strictEqual(cm.assertOwnedKey(U, k), k);
});

check('empty / null / non-string keys are rejected, not coerced', () => {
  for (const bad of [null, undefined, '', 0, {}, [], true])
    assert.throws(() => cm.assertOwnedKey(U, bad), /forbidden_key/, String(bad));
});

// ── 2. THE PREFIX IS NOT A PUBLIC ONE ──────────────────────────────────────
// sources/ is world-readable. Landing chat images there is the exact mistake
// that made exports/ publicly downloadable until 2026-08-23.
check('the chat media prefix is NOT sources/ or any public prefix', () => {
  assert.strictEqual(cm.PREFIX, 'chat-media');
  const k = cm.buildKey(U, 'image/jpeg', 'x.jpg');
  assert.ok(!/^(sources|renders|thumbnails)\//.test(k), k);
});

// ── 3. MIME ALLOWLIST ──────────────────────────────────────────────────────
check('non-image types are refused with 415', () => {
  for (const bad of ['application/pdf', 'video/mp4', 'text/html', 'application/octet-stream', '']) {
    const e = (() => { try { cm.buildKey(U, bad, 'f'); return null; } catch (x) { return x; } })();
    assert.ok(e, `${bad} was accepted`);
    assert.strictEqual(e.statusCode, 415, `${bad} → ${e.statusCode}`);
  }
});

check('mime is normalised (case + charset parameter)', () => {
  assert.strictEqual(cm.normalizeMime('IMAGE/JPEG; charset=binary'), 'image/jpeg');
  assert.ok(cm.isAllowedMime('Image/PNG'));
});

check('the extension comes from the MIME, never the client filename', () => {
  // A .exe named file declared as image/png must not keep its extension.
  const k = cm.buildKey(U, 'image/png', 'payload.exe');
  assert.ok(k.endsWith('.png'), k);
});

// ── 4. COUNT LIMIT IS A TYPED ERROR, NEVER A SILENT TRUNCATION ─────────────
// A user who attached four images and got an answer about three would have no
// way to tell which one the model never saw.
check('over-count is a 400 with the limit, not a slice', () => {
  const four = Array.from({ length: 4 }, () => ({ kind: 'image', mime: 'image/jpeg', key: cm.buildKey(U, 'image/jpeg', 'a.jpg') }));
  const e = (() => { try { cm.parseInboundMedia(U, four); return null; } catch (x) { return x; } })();
  assert.ok(e, 'four images were accepted');
  assert.strictEqual(e.statusCode, 400);
  assert.strictEqual(e.detail.limit, cm.MAX_MEDIA_PER_MESSAGE);
  assert.strictEqual(e.detail.got, 4);
});

check('exactly the limit is accepted', () => {
  const three = Array.from({ length: cm.MAX_MEDIA_PER_MESSAGE }, () => ({ mime: 'image/jpeg', key: cm.buildKey(U, 'image/jpeg', 'a.jpg') }));
  assert.strictEqual(cm.parseInboundMedia(U, three).length, cm.MAX_MEDIA_PER_MESSAGE);
});

check('absent media is an empty list, not an error', () => {
  assert.deepStrictEqual(cm.parseInboundMedia(U, undefined), []);
  assert.deepStrictEqual(cm.parseInboundMedia(U, null), []);
});

check("inbound media carrying ANOTHER user's key is refused", () => {
  const foreign = [{ mime: 'image/jpeg', key: cm.buildKey(V, 'image/jpeg', 'theirs.jpg') }];
  assert.throws(() => cm.parseInboundMedia(U, foreign), /forbidden_key/);
});

// ── 5. THE BYTE CEILING IS ENFORCED ON THE READ ────────────────────────────
// A presigned PUT cannot be trusted to have honoured what the client declared,
// so the limit that matters is the one applied when we read the object back.
check('an oversized object throws 413 and is NOT truncated', async () => { /* async below */ });

// ── 6. WIRE SHAPE, IDENTICAL ON BOTH TIERS ─────────────────────────────────
check('attachmentFrame emits exactly {kind, mime, key}', () => {
  const f = cm.attachmentFrame('image', 'IMAGE/PNG', 'chat-media/x/y.png');
  assert.deepStrictEqual(Object.keys(f).sort(), ['key', 'kind', 'mime']);
  assert.strictEqual(f.mime, 'image/png');
  // No `url`: a URL in a stored transcript expires and there is no server
  // writer for chats.messages that could ever refresh it.
  assert.strictEqual(f.url, undefined);
  assert.strictEqual(f.data, undefined);
});

check('BOTH chat tiers build attachments through persistGeneratedAttachments', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const n = (src.match(/persistGeneratedAttachments\(/g) || []).length;
  // one-shot + stream. If a third entrance appears it must be deliberate.
  assert.strictEqual(n, 2, `expected 2 call sites, found ${n}`);
  // and the SSE frame must carry the key under `attachments`
  assert.ok(/JSON\.stringify\(\{\s*attachments:\s*streamAtts\s*\}\)/.test(src),
    'the SSE attachments frame is missing or renamed');
});

check('the three endpoints FRONTEND depends on are mounted', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/'\/api\/chat\/media-resolve'/.test(src), '/api/chat/media-resolve missing');
  assert.ok(/purpose \|\| ''\) === 'chat_media'/.test(src), "upload-url purpose:'chat_media' branch missing");
  assert.ok(/'\/api\/upload-url'/.test(src), '/api/upload-url missing');
});

check('chat_media upload does NOT return a public URL', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("=== 'chat_media'");
  const j = src.indexOf('Upload door (wall N+1)', i);
  assert.ok(i > 0 && j > i, 'could not slice the chat_media branch');
  // STRIP COMMENTS FIRST. The first cut of this assertion failed because the
  // branch's own comment explains that it deliberately returns no public URL —
  // and the word appearing in prose read exactly like the defect. Scanning
  // source for a symbol must scan CODE; a comment is not a behaviour. (Same
  // class as the `exports/*` glob whose `/*` opened a phantom block comment and
  // swallowed a route handler out of __smoke_chat_model_pinned.js.)
  const branch = src.slice(i, j)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/getPublicUrl/.test(branch), 'the chat_media branch mints a PUBLIC url');
  assert.ok(!/publicUrl/.test(branch), 'the chat_media branch returns publicUrl');
  // and prove the stripper did not simply erase the branch
  assert.ok(/createPresignedPutUrl/.test(branch), 'comment-stripping ate the branch body');
});

check('chat_media branch runs BEFORE the video upload wall', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const media = src.indexOf("=== 'chat_media'");
  const wall = src.indexOf("sendUploadDenial(res, dec, 'upload-url'", media > 0 ? media : 0);
  assert.ok(media > 0 && wall > media,
    'the wall runs first — sending a photo would consume a render from the quota');
});

// ── async: the byte ceiling ────────────────────────────────────────────────
(async () => {
  const fakeS3Big = {
    async getObjectBuffer(key, maxBytes) {
      const e = new Error('too_large'); e.statusCode = 413;
      e.detail = { size: maxBytes + 1, limit: maxBytes }; throw e;
    },
  };
  const media = [{ kind: 'image', mime: 'image/jpeg', key: cm.buildKey(U, 'image/jpeg', 'big.jpg') }];
  let threw = null;
  try { await cm.inlinePartsForGemini(fakeS3Big, media); } catch (e) { threw = e; }
  check('an oversized image surfaces 413 rather than a truncated buffer', () => {
    assert.ok(threw, 'no throw');
    assert.strictEqual(threw.statusCode, 413);
  });

  // ordering: Gemini reads image parts positionally, so index order must hold
  // even when the slower fetch is first.
  const fakeS3 = {
    async getObjectBuffer(key) {
      const n = key.includes('-a.') ? 30 : 0;
      await new Promise((r) => setTimeout(r, n));
      return { buffer: Buffer.from(key.includes('-a.') ? 'AAA' : 'BBB'), contentType: 'image/jpeg', size: 3 };
    },
    async upload() { return 'ok'; },
  };
  const ordered = [
    { kind: 'image', mime: 'image/jpeg', key: `chat-media/${U}/1-x-a.jpg` },
    { kind: 'image', mime: 'image/jpeg', key: `chat-media/${U}/2-x-b.jpg` },
  ];
  const parts = await cm.inlinePartsForGemini(fakeS3, ordered);
  check('inline parts preserve attachment order regardless of fetch latency', () => {
    assert.strictEqual(Buffer.from(parts[0].inline_data.data, 'base64').toString(), 'AAA');
    assert.strictEqual(Buffer.from(parts[1].inline_data.data, 'base64').toString(), 'BBB');
    assert.strictEqual(parts[0].inline_data.mime_type, 'image/jpeg');
  });

  // generated attachments: persisted as keys, never returned as base64
  const uploaded = [];
  const fakeUp = { async upload(key, buf, mime) { uploaded.push({ key, mime, n: buf.length }); } };
  const atts = await cm.persistGeneratedAttachments(fakeUp, U, [
    { mimeType: 'image/png', data: Buffer.from('PNGDATA').toString('base64') },
  ]);
  check('a generated image is persisted privately and returned as a KEY', () => {
    assert.strictEqual(atts.length, 1);
    assert.deepStrictEqual(Object.keys(atts[0]).sort(), ['key', 'kind', 'mime']);
    assert.ok(atts[0].key.startsWith(`chat-media/${U}/`), atts[0].key);
    assert.strictEqual(atts[0].data, undefined, 'base64 leaked into the wire shape');
    assert.strictEqual(uploaded.length, 1);
    assert.strictEqual(uploaded[0].mime, 'image/png');
  });

  // a failed persist must not lose the text reply
  const brokenUp = { async upload() { throw new Error('s3 down'); } };
  const errs = [];
  const none = await cm.persistGeneratedAttachments(brokenUp, U,
    [{ mimeType: 'image/png', data: 'AAAA' }], (e) => errs.push(e));
  check('a failed persist drops the image LOUDLY and never throws', () => {
    assert.deepStrictEqual(none, []);
    assert.strictEqual(errs.length, 1, 'the failure was silent');
  });

  if (failures.length) {
    console.error(`\n[smoke] FAILED: ${failures.length} chat-media assertion(s)`);
    process.exit(1);
  }
  console.log('[smoke] chat media reference contract: OK');
})();
