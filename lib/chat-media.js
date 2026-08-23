'use strict';

// CHAT MEDIA — the reference contract (§1, 2026-08-23)
//
// WHY NOT BASE64. readJsonBody enforces MAX_JSON_BODY = 1MB on EVERY endpoint,
// base64 inflates ~1.33x, and chat history shares the same body. That leaves
// ~750KB total for three images — roughly 250KB each BEFORE history, against a
// real iPhone photo of 2-5MB. A client budget tight enough to fit would be
// thumbnail-grade, and it degrades as the conversation grows, so the 413 lands
// later in a chat when the user has more invested. The cap is not a tuning
// problem; it is the wrong boundary.
//
// So media travels by REFERENCE: the client PUTs to a presigned URL and sends
// {kind, mime, key}. The body stays kilobytes no matter how many images ride.
//
// OWNERSHIP IS STRUCTURAL, NOT A LOOKUP. The key embeds the owner:
//
//     chat-media/{user_id}/{timestamp}-{random}-{name}
//
// so /api/chat/media-resolve authorises with a prefix comparison and no DB read
// at all. There is no row to forget to check, no join to get wrong, and no way
// for a key belonging to another user to resolve — the check cannot be skipped
// because it IS the parse. `assertOwnedKey` is the single chokepoint; every
// caller goes through it.
//
// The prefix is deliberately NOT `sources/`, which is publicly readable — that
// is the exact mistake that made exports/ world-readable until 2026-08-23.

const MAX_MEDIA_PER_MESSAGE = 3;

// 10MB: comfortably above a full-resolution iPhone photo, far below anything
// that would hurt to fetch server-side. Enforced on the READ, because a
// presigned PUT cannot be trusted to have honoured what the client declared.
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

// Images only. Gemini accepts these inline; anything else is either unsupported
// or a file-upload feature we have not designed. An explicit allowlist means a
// new type is a decision, not an accident.
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
]);

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/gif': 'gif',
};

const PREFIX = 'chat-media';

// A user id is a UUID. Pinning the shape here (rather than accepting any
// non-empty string) stops a crafted id like `../../sources` from ever being
// composed into a key in the first place.
const UUID_RE = /^[0-9a-fA-F-]{36}$/;
const KEY_RE = /^chat-media\/([0-9a-fA-F-]{36})\/[A-Za-z0-9._-]+$/;

function normalizeMime(mime) {
  return String(mime || '').trim().toLowerCase().split(';')[0];
}

function isAllowedMime(mime) {
  return ALLOWED_MIME.has(normalizeMime(mime));
}

/** Build a private, owner-scoped key. Throws on anything it cannot make safe. */
function buildKey(userId, mime, fileName) {
  if (!UUID_RE.test(String(userId || ''))) {
    const e = new Error('invalid_user'); e.statusCode = 400; throw e;
  }
  const m = normalizeMime(mime);
  if (!isAllowedMime(m)) {
    const e = new Error('unsupported_media_type'); e.statusCode = 415; throw e;
  }
  // Strip the client name to a safe token; never trust it for the extension.
  const base = String(fileName || 'image')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.+/g, '.')            // no `..` traversal, even post-sanitisation
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 48) || 'image';
  const stem = base.replace(/\.[^.]*$/, '') || 'image';
  const rand = Math.random().toString(36).slice(2, 10);
  return `${PREFIX}/${userId}/${Date.now()}-${rand}-${stem}.${MIME_EXT[m]}`;
}

/**
 * THE AUTHORISATION CHOKEPOINT. Returns the key when `userId` owns it, throws
 * 403 otherwise. Parsing and authorising are the same operation on purpose:
 * a caller cannot obtain a usable key without having proved ownership.
 */
function assertOwnedKey(userId, key) {
  const k = String(key || '');
  const m = KEY_RE.exec(k);
  // A traversal segment can never appear in a KEY_RE match, but assert it
  // separately so the guarantee does not rest on reading a regex correctly.
  if (!m || k.includes('..') || m[1] !== String(userId)) {
    const e = new Error('forbidden_key'); e.statusCode = 403; throw e;
  }
  return k;
}

function ownsKey(userId, key) {
  try { assertOwnedKey(userId, key); return true; } catch { return false; }
}

/**
 * Validate an inbound `media[]` from a chat request. Returns owned keys.
 * Over-count is a typed 400, never a silent truncation: a user who attached
 * four images and got an answer about three would have no way to tell.
 */
function parseInboundMedia(userId, media) {
  if (media == null) return [];
  if (!Array.isArray(media)) {
    const e = new Error('media_must_be_array'); e.statusCode = 400; throw e;
  }
  if (media.length > MAX_MEDIA_PER_MESSAGE) {
    const e = new Error('too_many_media');
    e.statusCode = 400;
    e.detail = { limit: MAX_MEDIA_PER_MESSAGE, got: media.length };
    throw e;
  }
  return media.map((it) => {
    const mime = normalizeMime(it && it.mime);
    if (!isAllowedMime(mime)) {
      const e = new Error('unsupported_media_type'); e.statusCode = 415; throw e;
    }
    return { kind: 'image', mime, key: assertOwnedKey(userId, it && it.key) };
  });
}

/**
 * THE WIRE SHAPE, in one place. FRONTEND decodes {kind, mime, key} and
 * re-resolves the key on read, so no URL is ever embedded in a stored message
 * and nothing expires inside a chat transcript. Both the one-shot and the SSE
 * tier emit through this function so the two entrances cannot drift — the exact
 * failure that let parts[0] eat answers on one path after the other was fixed.
 */
function attachmentFrame(kind, mime, key) {
  return { kind, mime: normalizeMime(mime), key };
}

/**
 * media[] (keys) → Gemini inline parts. Fetches each object and base64s it.
 *
 * `s3` is injected rather than required, so the whole contract is testable with
 * a fake and no AWS credentials — the smoke exercises the real ordering,
 * ceilings and failure modes, not a mock of them.
 *
 * Ordering matters: Gemini reads image parts positionally against the prompt
 * text, so these are returned in the order the user attached them. A Promise.all
 * preserves index order regardless of which fetch finishes first.
 */
async function inlinePartsForGemini(s3, media, maxBytes = MAX_MEDIA_BYTES) {
  if (!media || !media.length) return [];
  return Promise.all(media.map(async (m) => {
    const { buffer } = await s3.getObjectBuffer(m.key, maxBytes);
    // snake_case inline_data: the REST v1beta surface accepts both spellings on
    // input, and the rest of this file's request bodies are snake_case
    // (system_instruction). Staying consistent avoids a mixed-convention body
    // that reads as a typo to the next person.
    return { inline_data: { mime_type: m.mime, data: buffer.toString('base64') } };
  }));
}

/**
 * Model-generated images → private keys, returned as wire attachments.
 *
 * NEVER returns base64 to the client. An inline blob would blow past the 1MB
 * response budget the moment a model emits a real image, and it would land in
 * the stored transcript where it can neither be expired nor re-resolved.
 *
 * A failed persist is DROPPED, not fatal: an answer that also produced an image
 * is still an answer, and losing the text because an upload hiccuped would turn
 * a partial success into a 502. Every drop is reported through `onError` so it
 * is loud to us while staying invisible to the user.
 */
async function persistGeneratedAttachments(s3, userId, inlineAttachments, onError) {
  if (!inlineAttachments || !inlineAttachments.length) return [];
  const out = [];
  for (const att of inlineAttachments) {
    const mime = normalizeMime(att.mimeType || att.mime_type);
    const data = att.data;
    if (!data || !isAllowedMime(mime)) {
      if (onError) onError(new Error(`unsupported generated part mime=${mime || 'none'}`));
      continue;
    }
    try {
      const key = buildKey(userId, mime, 'reply');
      await s3.upload(key, Buffer.from(data, 'base64'), mime);
      out.push(attachmentFrame('image', mime, key));
    } catch (e) {
      if (onError) onError(e);
    }
  }
  return out;
}

module.exports = {
  PREFIX,
  MAX_MEDIA_PER_MESSAGE,
  MAX_MEDIA_BYTES,
  ALLOWED_MIME,
  MIME_EXT,
  normalizeMime,
  isAllowedMime,
  buildKey,
  assertOwnedKey,
  ownsKey,
  parseInboundMedia,
  attachmentFrame,
  inlinePartsForGemini,
  persistGeneratedAttachments,
};
