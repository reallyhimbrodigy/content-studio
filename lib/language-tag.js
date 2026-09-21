'use strict';
/**
 * ONE FORM ON READ: the BCP-47 tag.
 *
 * `negotiation_decisions.language` carries TWO VOCABULARIES with a hard seam at
 * the 5800071 deploy (2026-09-20, between 20:46:07Z and 21:12:44Z). Before it
 * the safety schema asked the model for "the language the request is written
 * in" and got prose — `English`, `Urdu`, `Hindi (Latin script transliteration)`.
 * After it the single classifier writes `adj.typed_in`, which is a tag — `en`.
 *
 * I caught that renaming the KEY would write NULL to the field ruling 2 depends
 * on, and fixed that. I did not notice the VALUES changed underneath it. The
 * reader still works; it is the by-language CUT that breaks, because English is
 * two buckets across the seam and the dark read stratifies by language.
 *
 * SO NORMALIZE ON READ AND CHANGE NOTHING ON WRITE. The tags are the better
 * vocabulary and the 101 prose rows are history that cannot be rewritten
 * (Supabase is read-only to this lane, and rewriting a ledger to match a later
 * decision is how a record stops being evidence).
 *
 * THREE STATES, NEVER A GUESS. An unknown value returns UNKNOWN with the raw
 * string attached rather than being folded into a plausible tag — a language
 * silently mapped to the wrong bucket is the by-language cut lying quietly,
 * which is the defect this file exists for.
 */

/**
 * Prose forms MEASURED in the table on 2026-09-20, all 107 rows. This is a map
 * of what was actually written, not a list of the world's languages: a value
 * that is not here has never been seen, and must arrive as UNKNOWN so it is
 * counted rather than absorbed.
 */
const PROSE_TO_TAG = {
  english: 'en',
  spanish: 'es',
  arabic: 'ar',
  french: 'fr',
  hindi: 'hi',
  persian: 'fa',
  bengali: 'bn',
  hebrew: 'he',
  polish: 'pl',
  portuguese: 'pt',
  russian: 'ru',
  turkish: 'tr',
  urdu: 'ur',
  'hindi (hindustani in latin script)': 'hi-Latn',
  'hindi (latin script transliteration)': 'hi-Latn',
};

/** Tags the classifier may legitimately write. Kept as a SHAPE test, not a list. */
const TAG_SHAPE = /^[a-z]{2,3}(-[A-Za-z]{2,8})?$/;

/**
 * -> { state: 'MEASURED'|'ABSENT'|'UNKNOWN', tag, raw, via }
 *   MEASURED  a tag, either written as one or mapped from a prose form
 *   ABSENT    null/empty — the row never recorded a language
 *   UNKNOWN   a non-empty value in neither vocabulary. Counted, never guessed.
 */
function languageTag(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { state: 'ABSENT', tag: null, raw, via: 'empty' };
  }
  const s = String(raw).trim();
  const lower = s.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PROSE_TO_TAG, lower)) {
    return { state: 'MEASURED', tag: PROSE_TO_TAG[lower], raw: s, via: 'prose' };
  }
  if (TAG_SHAPE.test(s)) {
    // Canonicalise case only: `hi-latn` and `hi-Latn` are one bucket.
    const [lang, script] = s.split('-');
    const tag = script ? `${lang.toLowerCase()}-${script[0].toUpperCase()}${script.slice(1).toLowerCase()}` : lang.toLowerCase();
    return { state: 'MEASURED', tag, raw: s, via: 'tag' };
  }
  return { state: 'UNKNOWN', tag: null, raw: s, via: 'unrecognised' };
}

/** The tags the documented list SHOULD name, derived from what traffic wrote. */
function tagsFromRows(rows) {
  const counts = new Map();
  let absent = 0;
  const unknown = [];
  for (const r of rows) {
    const t = languageTag(r);
    if (t.state === 'ABSENT') { absent++; continue; }
    if (t.state === 'UNKNOWN') { unknown.push(t.raw); continue; }
    counts.set(t.tag, (counts.get(t.tag) || 0) + 1);
  }
  return {
    tags: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    absent,
    unknown,
    total: rows.length,
  };
}

module.exports = { languageTag, tagsFromRows, PROSE_TO_TAG };
