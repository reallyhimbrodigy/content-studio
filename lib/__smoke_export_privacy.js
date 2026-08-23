'use strict';
// GATE SMOKE — a function that can silently degrade from a GRANT to a
// PERMANENT PUBLIC LINK must not be reachable.
//
// MEASURED 2026-08-23, on production:
//   https://<cf-domain>/exports/<job>/clean.mp4  ->  HTTP 200
//       content-type: video/mp4   content-length: 34,240,387   ftyp magic
//       two independent keys, x-cache: Hit from cloudfront
//   https://<bucket>.s3.<region>.amazonaws.com/exports/...     ->  403
//
// The bucket is locked; the DISTRIBUTION serves exports/ to anyone. So the
// "private clean master" is public and the export paywall is theatre — exactly
// the failure server.js's own comment says the public/private split exists to
// prevent ("anyone with the link has the clean file").
//
// ROOT SHAPE, and why this is a gate and not a note. services/cloudfront.js
// splits signedMode (domain + KEY_PAIR_ID + PRIVATE_KEY) from unsignedMode
// (domain alone). In unsigned mode createSignedUrl returns a BARE, NON-EXPIRING
// https://<domain>/<key> — byte-identical to getPublicUrl — and
// createPresignedGetUrl returns that FIRST, never reaching the S3 presigner.
// Callers believe they minted a short-TTL grant. They minted a permanent link.
// A function whose contract silently inverts is the worst shape available:
// every call site reads correctly and every one of them is wrong.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cf = fs.readFileSync(path.join(ROOT, 'services', 'cloudfront.js'), 'utf8');
const s3 = fs.readFileSync(path.join(ROOT, 'services', 's3.js'), 'utf8');

// 1. The two modes still exist and are still distinguished — if this collapses,
//    the reasoning below no longer describes the code.
assert.ok(/const signedMode\s*=/.test(cf) && /const unsignedMode\s*=/.test(cf),
  'cloudfront.js no longer distinguishes signed from unsigned mode');

// 2. THE GUARD ITSELF. createPresignedGetUrl must REFUSE in unsigned mode
//    rather than returning a bare link that reads like a grant.
assert.ok(/UNSIGNED_MODE_REFUSES/.test(s3),
  'services/s3.js does not refuse to mint in unsigned mode. A caller asking for '
  + 'a short-TTL signed URL would receive a PERMANENT PUBLIC LINK and could not '
  + 'tell — measured live: exports/<job>/clean.mp4 returns HTTP 200, 34MB of '
  + 'real mp4, on a distribution with no signed-URL requirement.');

// 3. NO NEW CALLER may mint a "private" URL while the mode is unsigned. The
//    chat-image work is held on exactly this.
const chatReply = fs.readFileSync(path.join(ROOT, 'lib', 'chat-reply.js'), 'utf8');
assert.ok(!/createPresignedGetUrl|getPublicUrl|s3\.upload/.test(chatReply),
  'lib/chat-reply.js has grown an upload/URL path. Image persistence is HELD '
  + 'until exports/ actually 403s — writing user images through a function that '
  + 'mints permanent public links is not acceptable.');

console.log('export-privacy smoke: 3/3 OK');
