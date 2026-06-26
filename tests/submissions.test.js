'use strict';

// Run with:  node --test tests/submissions.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const {
  SUBMISSION_KEY_PREFIX,
  MAX_VIDEO_BYTES,
  MAX_VIDEOS_PER_SUBMISSION,
  MAX_NAME_LEN,
  MAX_NOTES_LEN,
  MAX_EMAIL_LEN,
  VALID_STATUSES,
  isSubmissionAdmin,
  isValidVideoKey,
  isValidStatus,
  validateUploadRequest,
  validateSubmission,
} = require('../lib/submissions');

// Helper: a valid server-generated video key.
const videoKey = (name = 'clip.mp4') => `${SUBMISSION_KEY_PREFIX}1718000000000-uuid-${name}`;
const video = (overrides = {}) => ({
  key: videoKey(),
  filename: 'clip.mp4',
  size: 1024,
  content_type: 'video/mp4',
  ...overrides,
});

// --- isSubmissionAdmin ---

test('isSubmissionAdmin: email in allowlist (case-insensitive + trimmed)', () => {
  assert.strictEqual(isSubmissionAdmin('Admin@Example.com', 'admin@example.com'), true);
  assert.strictEqual(isSubmissionAdmin('  admin@example.com  ', '  Admin@Example.COM  '), true);
});

test('isSubmissionAdmin: email not in allowlist', () => {
  assert.strictEqual(isSubmissionAdmin('nope@example.com', 'admin@example.com'), false);
});

test('isSubmissionAdmin: empty email is not admin', () => {
  assert.strictEqual(isSubmissionAdmin('', 'admin@example.com'), false);
  assert.strictEqual(isSubmissionAdmin(null, 'admin@example.com'), false);
  assert.strictEqual(isSubmissionAdmin(undefined, 'admin@example.com'), false);
});

test('isSubmissionAdmin: empty / undefined allowlist is not admin', () => {
  assert.strictEqual(isSubmissionAdmin('admin@example.com', ''), false);
  assert.strictEqual(isSubmissionAdmin('admin@example.com', undefined), false);
  assert.strictEqual(isSubmissionAdmin('admin@example.com', null), false);
});

test('isSubmissionAdmin: matches within multiple comma-separated allowlist', () => {
  const list = 'first@example.com, Admin@Example.com , third@example.com';
  assert.strictEqual(isSubmissionAdmin('admin@example.com', list), true);
  assert.strictEqual(isSubmissionAdmin('third@example.com', list), true);
  assert.strictEqual(isSubmissionAdmin('missing@example.com', list), false);
});

// --- isValidVideoKey ---

test('isValidVideoKey: valid submissions/ key is true', () => {
  assert.strictEqual(isValidVideoKey(videoKey()), true);
});

test('isValidVideoKey: key without prefix is false', () => {
  assert.strictEqual(isValidVideoKey('sources/123-clip.mp4'), false);
});

test('isValidVideoKey: path-traversal key is false', () => {
  assert.strictEqual(isValidVideoKey(`${SUBMISSION_KEY_PREFIX}../etc/passwd`), false);
});

test('isValidVideoKey: empty / non-string is false', () => {
  assert.strictEqual(isValidVideoKey(''), false);
  assert.strictEqual(isValidVideoKey(null), false);
  assert.strictEqual(isValidVideoKey(undefined), false);
  assert.strictEqual(isValidVideoKey(123), false);
});

// --- isValidStatus ---

test('isValidStatus: each valid status is true', () => {
  for (const s of VALID_STATUSES) {
    assert.strictEqual(isValidStatus(s), true);
  }
});

test('isValidStatus: invalid status is false', () => {
  assert.strictEqual(isValidStatus('deleted'), false);
  assert.strictEqual(isValidStatus(''), false);
  assert.strictEqual(isValidStatus(null), false);
  assert.strictEqual(isValidStatus(undefined), false);
});

// --- validateUploadRequest ---

test('validateUploadRequest: valid video request is accepted', () => {
  const r = validateUploadRequest({ fileName: 'my video.mp4', contentType: 'video/mp4', size: 1024 });
  assert.strictEqual(r.ok, true);
  // Spaces sanitized to underscores.
  assert.strictEqual(r.safeName, 'my_video.mp4');
});

test('validateUploadRequest: non-video contentType is rejected', () => {
  const r = validateUploadRequest({ fileName: 'doc.pdf', contentType: 'application/pdf', size: 1024 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('validateUploadRequest: zero / oversize is rejected', () => {
  assert.strictEqual(validateUploadRequest({ fileName: 'v.mp4', contentType: 'video/mp4', size: 0 }).ok, false);
  assert.strictEqual(validateUploadRequest({ fileName: 'v.mp4', contentType: 'video/mp4', size: MAX_VIDEO_BYTES + 1 }).ok, false);
});

test('validateUploadRequest: filename is sanitized', () => {
  const r = validateUploadRequest({ fileName: 'a/b\\c?*<>.mp4', contentType: 'video/quicktime', size: 500 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.safeName, 'a_b_c____.mp4');
  assert.ok(!/[^a-zA-Z0-9._-]/.test(r.safeName));
});

// --- validateSubmission ---

test('validateSubmission: valid single-video submission is accepted', () => {
  const r = validateSubmission({ creator_name: '  Jane Creator  ', videos: [video()] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.creator_name, 'Jane Creator');
  assert.strictEqual(r.value.creator_email, null);
  assert.strictEqual(r.value.notes, null);
  assert.strictEqual(r.value.videos.length, 1);
});

test('validateSubmission: valid batch submission is accepted', () => {
  const videos = Array.from({ length: MAX_VIDEOS_PER_SUBMISSION }, (_, i) =>
    video({ key: videoKey(`clip${i}.mp4`), filename: `clip${i}.mp4` })
  );
  const r = validateSubmission({ creator_name: 'Batch Creator', videos });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.videos.length, MAX_VIDEOS_PER_SUBMISSION);
});

test('validateSubmission: missing name is rejected', () => {
  const r = validateSubmission({ videos: [video()] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('validateSubmission: blank (whitespace) name is rejected', () => {
  const r = validateSubmission({ creator_name: '   ', videos: [video()] });
  assert.strictEqual(r.ok, false);
});

test('validateSubmission: name too long is rejected', () => {
  const r = validateSubmission({ creator_name: 'x'.repeat(MAX_NAME_LEN + 1), videos: [video()] });
  assert.strictEqual(r.ok, false);
});

test('validateSubmission: bad email is rejected', () => {
  const r = validateSubmission({ creator_name: 'Jane', creator_email: 'not-an-email', videos: [video()] });
  assert.strictEqual(r.ok, false);
});

test('validateSubmission: valid email is accepted and normalized', () => {
  const r = validateSubmission({ creator_name: 'Jane', creator_email: '  jane@example.com  ', videos: [video()] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.creator_email, 'jane@example.com');
});

test('validateSubmission: over-length email is rejected', () => {
  const longEmail = 'a'.repeat(MAX_EMAIL_LEN) + '@example.com';
  const r = validateSubmission({ creator_name: 'Jane', creator_email: longEmail, videos: [video()] });
  assert.strictEqual(r.ok, false);
});

test('validateSubmission: multi-dot domain email is accepted', () => {
  const r = validateSubmission({ creator_name: 'Jane', creator_email: 'jane@studio.co.uk', videos: [video()] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.creator_email, 'jane@studio.co.uk');
});

test('validateSubmission: absent email is accepted (null)', () => {
  const r = validateSubmission({ creator_name: 'Jane', videos: [video()] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.creator_email, null);
});

test('validateSubmission: zero videos is rejected', () => {
  const r = validateSubmission({ creator_name: 'Jane', videos: [] });
  assert.strictEqual(r.ok, false);
});

test('validateSubmission: more than MAX_VIDEOS_PER_SUBMISSION videos is rejected', () => {
  const videos = Array.from({ length: MAX_VIDEOS_PER_SUBMISSION + 1 }, (_, i) =>
    video({ key: videoKey(`clip${i}.mp4`), filename: `clip${i}.mp4` })
  );
  const r = validateSubmission({ creator_name: 'Jane', videos });
  assert.strictEqual(r.ok, false);
});

test('validateSubmission: video with forged key is rejected', () => {
  const r = validateSubmission({
    creator_name: 'Jane',
    videos: [video({ key: 'sources/evil/../../secret.mp4' })],
  });
  assert.strictEqual(r.ok, false);
});

test('validateSubmission: notes too long is rejected', () => {
  const r = validateSubmission({
    creator_name: 'Jane',
    notes: 'n'.repeat(MAX_NOTES_LEN + 1),
    videos: [video()],
  });
  assert.strictEqual(r.ok, false);
});
