'use strict';

// SIGN ON READ must survive all three stored forms, and must ship BEFORE the
// columns become keys.
//
// The rot: completions stored a 7-day CloudFront signature in a durable column,
// so the row's usable life was the signature's life. 2,062 of 2,643 signed
// `renderedVideoUrl` values in chats.messages were dead when this was written,
// across 1,391 users, ~90 more per day.
//
// The sequencing hazard this gate exists to make impossible: `/refresh-urls`
// used to derive the key with `new URL(stored)`, which THROWS on a bare key and
// fell through to returning the stored value verbatim. That endpoint is the
// fleet's ONLY recovery path — 100% of dead chat links carry a jobId, and build
// 246 (~880 of ~1,000 active users) calls it on a failed pre-flight HEAD or an
// AVPlayer 403. Migrating the columns to keys while that was true would have
// handed every shipped client a bare key where a url belongs, at once.
//
// Exit 0 = clean. Exit 1 = a read path has gone blind to one of the forms.

process.env.CLOUDFRONT_DOMAIN = 'cdn.example.net';

const fs = require('fs');
const path = require('path');
const { signRead, signReadFields } = require('./sign-on-read');

const bad = [];
const OURS = 'renders-private/job-abc/final.mp4';

function fakeS3(opts = {}) {
  return {
    S3_BUCKET: 'testbucket',
    isConfigured: () => true,
    createPresignedGetUrl: async (key, ttl) => {
      if (opts.throws) throw new Error('signer down');
      return `https://cdn.example.net/${key}`
        + `?Expires=${Math.floor(Date.now() / 1000) + ttl}&Key-Pair-Id=K1&Signature=FRESH`;
    },
  };
}

(async () => {
  const s3 = fakeS3();

  // 1. A BARE KEY — the post-migration shape. This is the one the old
  //    extractS3Key could not do, and the reason reads ship first.
  const fromKey = await signRead(OURS, 't', { s3 });
  if (!/^https:\/\/cdn\.example\.net\//.test(String(fromKey)) || !/Signature=FRESH/.test(String(fromKey))) {
    bad.push(`a bare key did not become a signed url (got: ${String(fromKey).slice(0, 90)}) — `
           + 'every shipped client would render a key where a url belongs');
  }

  // 2. A DEAD SIGNATURE re-grants on the SAME key, with no nested credentials.
  const dead = `https://cdn.example.net/${OURS}?Expires=1000000000&Key-Pair-Id=OLD&Signature=DEAD`;
  const revived = String(await signRead(dead, 't', { s3 }));
  if (!/Signature=FRESH/.test(revived) || /Signature=DEAD/.test(revived)) {
    bad.push('an expired signature was not replaced with a fresh grant');
  }
  if ((revived.match(/\?/g) || []).length !== 1 || /Expires=[0-9]+.*Expires=/.test(revived)) {
    bad.push('re-granting nested the old query instead of stripping it — the key must be '
           + 'read from the pathname, which is what makes this idempotent');
  }
  if (!revived.includes(OURS)) bad.push('re-granting changed the key');

  // 3. An UNSIGNED CDN url (6,136 durable rows) still gets a grant.
  const unsigned = `https://cdn.example.net/${OURS}`;
  if (!/Signature=FRESH/.test(String(await signRead(unsigned, 't', { s3 })))) {
    bad.push('an unsigned CDN url was not granted');
  }

  // 4. A FOREIGN url passes through UNTOUCHED. Minting a grant for someone
  //    else's object produces a confident url pointing at a key we do not have.
  const foreign = 'https://xyz.supabase.co/storage/v1/object/public/v/x.mp4';
  if (await signRead(foreign, 't', { s3 }) !== foreign) {
    bad.push('a foreign (legacy Supabase Storage) url was rewritten onto our CDN');
  }

  // 5. FAIL-OPEN. A signing blip must degrade to today's behaviour, never to a
  //    blank player: deliver first, enrich second.
  const quiet = { error: () => {}, warn: () => {}, log: () => {} };
  if (await signRead(unsigned, 't', { s3: fakeS3({ throws: true }), log: quiet }) !== unsigned) {
    bad.push('a signing failure did not fail open — it un-delivered a video that rendered');
  }

  // 6. signReadFields returns a NEW object and never mutates the row. Writing a
  //    grant back into durable data is precisely how this bug was created.
  const row = { rendered_video_url: OURS, thumbnail_url: OURS, other: 'keep' };
  const out = await signReadFields(row, ['rendered_video_url', 'thumbnail_url'], 't', { s3 });
  if (row.rendered_video_url !== OURS) bad.push('signReadFields mutated the row it was given');
  if (out.other !== undefined) bad.push('signReadFields leaked unrequested fields');
  if (!/Signature=FRESH/.test(String(out.thumbnail_url))) bad.push('signReadFields did not sign thumbnail_url');

  // 7. REACHABILITY. All three server read paths must route through the
  //    chokepoint, and the url-parsing key extraction must be gone.
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = srv.indexOf('refresh-urls$');
  const handler = i > 0 ? srv.slice(i, i + 4000) : '';
  if (!/signRead\(job\.rendered_video_url/.test(handler)) {
    bad.push('/refresh-urls no longer signs through the chokepoint — this is the ONLY '
           + 'recovery path the shipped fleet has for a dead chat link');
  }
  if (/const extractS3Key\s*=/.test(handler)) {
    bad.push('the `new URL(stored)` key extraction is back in /refresh-urls — it throws on '
           + 'a bare key and falls through to returning the stored value verbatim');
  }
  const sseOk = /videoUrl: _signed\.rendered_video_url/.test(srv);
  const jobOk = /rendered_video_url: _signed\.rendered_video_url/.test(srv);
  if (!sseOk) bad.push('the SSE connect snapshot no longer signs on read');
  if (!jobOk) bad.push('the durable job-status response no longer signs on read');

  if (bad.length) {
    console.log('sign-on-read: FAIL');
    for (const b of bad) console.log('  -', b);
    process.exit(1);
  }
  console.log('  key / dead-signature / unsigned all grant fresh; foreign passes through; '
    + 'fails open; no row mutation; all three server read paths route through the chokepoint.');
  console.log('sign-on-read: PASS');
})().catch((e) => { console.log('sign-on-read: FAIL —', e && e.message); process.exit(1); });
