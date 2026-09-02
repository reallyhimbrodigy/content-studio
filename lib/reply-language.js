'use strict';
// ── reply_language — the language the ASSISTANT answers in ───────────────────
//
// THE DISTINCTION THAT MUST NOT BE MERGED (SERVER_REPLY_LANGUAGE_SPEC.md):
//
//     The reply follows the USER. The captions follow the CONTENT.
//
// A Hindi speaker editing an English interview wants the assistant to answer in
// Hindi — it is talking TO THEM — and the burned-in captions to stay English,
// because they transcribe the audio. Driving captions from reply_language would
// mistranslate every clip whose audio is not the reader's language, which is
// most of them. Driving the reply from the clip's detected_language answers a
// Hindi user in English whenever they upload an English clip — today's bug.
//
// So this governs the MODEL REPLY only. It must never reach caption text,
// transcript excerpts, or the vibe_input echo. Those are content.
//
// ONE MECHANISM: /api/chat and /api/chat/actions both read the field through
// parseReplyLanguage and both append replyLanguageInstruction. A second reader
// would drift, and a per-endpoint default would answer the same user in two
// different languages depending on which surface they used.

// The app's twelve. AppLanguage.current sends one of these; anything else is a
// client bug or an attacker, and both get 'en'.
const LANGUAGES = {
  en: 'English', es: 'Spanish', 'pt-BR': 'Brazilian Portuguese', fr: 'French',
  de: 'German', ja: 'Japanese', hi: 'Hindi', bn: 'Bengali', ne: 'Nepali',
  ur: 'Urdu', ar: 'Arabic', id: 'Indonesian',
};

const DEFAULT_LANGUAGE = 'en';

/**
 * Validate the client's reply_language against the twelve. NEVER returns an
 * unvalidated string: the value is interpolated into a system prompt, so an
 * arbitrary one is prompt injection with extra steps. Unknown, missing,
 * malformed or hostile input all collapse to 'en'.
 *
 * Case- and separator-tolerant ('PT-br', 'pt_BR') because a client that sends
 * the right language in the wrong casing should get their language, not English.
 */
function parseReplyLanguage(body) {
  const raw = body && typeof body === 'object' ? body.reply_language : null;
  if (typeof raw !== 'string') return DEFAULT_LANGUAGE;
  const norm = raw.trim().replace(/_/g, '-').toLowerCase();
  if (!norm) return DEFAULT_LANGUAGE;
  for (const code of Object.keys(LANGUAGES)) {
    if (code.toLowerCase() === norm) return code;
  }
  // 'pt' -> 'pt-BR', 'ar-EG' -> 'ar': match on the primary subtag, but only
  // when exactly one of the twelve claims it, so a guess is never ambiguous.
  const primary = norm.split('-')[0];
  const hits = Object.keys(LANGUAGES).filter(
    (c) => c.toLowerCase().split('-')[0] === primary);
  return hits.length === 1 ? hits[0] : DEFAULT_LANGUAGE;
}

/**
 * The instruction appended to the system prompt.
 *
 * RETURNS '' FOR ENGLISH ON PURPOSE. English is the overwhelming majority of
 * traffic and today's prompt has no such line; emitting nothing keeps those
 * requests BYTE-IDENTICAL to current behaviour, so this change cannot regress
 * the common path. Only a non-English reader gets a modified prompt.
 *
 * The second sentence is load-bearing. Without it the model "helpfully" remarks
 * that the clip is in another language, or translates transcript quotes into
 * the reply language — turning content into chrome, which is the exact merge
 * this module exists to prevent.
 */
function replyLanguageInstruction(code) {
  const c = LANGUAGES[code] ? code : DEFAULT_LANGUAGE;
  if (c === DEFAULT_LANGUAGE) return '';
  const name = LANGUAGES[c];
  return [
    '',
    `Respond in ${name}. The user reads ${name}. This is independent of the `
    + 'language spoken in their video, which you must never translate or '
    + 'comment on unless they ask.',
    `Quote transcript text, caption text and their vibe wording EXACTLY as they `
    + `are — do not translate them into ${name}. Those are content; only your `
    + 'own words to the user are in ' + name + '.',
  ].join('\n');
}

module.exports = { LANGUAGES, DEFAULT_LANGUAGE, parseReplyLanguage, replyLanguageInstruction };
