'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { registerPrewarm, awaitPrewarmHint } = require('../lib/video-processor/dispatch-to-modal');

// The bug: prewarmRegistry keyed on the raw URL string, so a presigned URL at
// intent and a re-signed/raw URL at dispatch — the SAME S3 object — missed,
// because X-Amz-Signature/Expires differ. Normalising to the source key fixes it.
test('prewarm hint: presigned register + raw/re-signed await = HIT (same source)', async () => {
  const raw = 'https://d1iax8jos987n3.cloudfront.net/sources/u1/1785-ABC.mp4';
  const presigned = `${raw}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef&X-Amz-Expires=3600`;
  const reSigned = `${raw}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=CAFED00D&X-Amz-Expires=7200`;
  registerPrewarm(presigned, Promise.resolve({ cache_key: 'k1', word_count: 42 }));
  const hitRaw = await awaitPrewarmHint(raw);
  const hitReSigned = await awaitPrewarmHint(reSigned);
  assert.ok(hitRaw && hitRaw.word_count === 42, 'raw await hits the presigned registration');
  assert.ok(hitReSigned && hitReSigned.word_count === 42, 're-signed await hits too');
});

test('prewarm hint: a DIFFERENT source key still MISSES', async () => {
  registerPrewarm('https://d1iax8jos987n3.cloudfront.net/sources/u1/A.mp4', Promise.resolve({ word_count: 1 }));
  const miss = await awaitPrewarmHint('https://d1iax8jos987n3.cloudfront.net/sources/u1/B.mp4');
  assert.equal(miss, null, 'a different object never falsely hits');
});
