'use strict';
// SERVER-SIDE PRESET EXPANSION. Reaches 100% of traffic with no app release.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// The top vibe strings are not what customers say — they are what OUR UI says
// on their behalf. Measured over 30 days, exact strings, cut by distinct user:
//
//     n     users  per-user
//     357    276     1.29   "Viral engaging video"
//     177    150     1.18   "Clean and engaging edit"
//      92     81     1.14   "Clean and professional"
//      70     65     1.08   "Professional corporate style"
//      27     27     1.00   "Fast cuts, big captions"
//      26     22     1.18   "Fast paced punchy"
//      17     17     1.00   "Make this a smooth video, add zooms, sound effects and motion graphics."
//      11     11     1.00   "Make this a smooth video, add zooms, + sound effects and motion graphics."
//
// The capitalisation settles it: "Viral engaging video", capital V only,
// IDENTICAL across 276 distinct users. Free typing does not do that. And
// per-user sits at 1.00-1.29 throughout, which is what a default looks like
// rather than a habit. The last two differ only by a "+", which is a preset
// plus a hand-edit.
//
// These builds are still in the field and cannot be updated, but OUR SERVER
// SEES THE VIBE BEFORE CHATCUT DOES. So a better wording can reach every one
// of them from here.
//
// ── THE RULE THAT MATTERS MOST: EXACT MATCHES ONLY ─────────────────────────
// A prefix or substring match would rewrite what a person TYPED, and a user
// who wrote "viral engaging video about my dog" must reach ChatCut with those
// words and no others. Normalisation is for MATCHING ONLY — case and
// whitespace — and a non-match returns the ORIGINAL STRING BYTE FOR BYTE,
// not the normalised one.
//
// ── DEFAULT IS IDENTITY ────────────────────────────────────────────────────
// Every expansion below is null until B1's realism runs pick a winner. The
// map exists, the plumbing runs, and nothing is rewritten: `variant: 'identity'`
// is the default and it returns the input. That way the A/B mechanism, the
// logging and the recording are all proven on live traffic BEFORE any wording
// changes, so a later result is not confounded by the plumbing arriving with
// it.

const VARIANTS = ['identity', 'expanded'];

// PROVENANCE: derived from 30 days of production traffic, NOT read from the
// client's source list. So this is the set of strings that BEHAVE like
// presets. If Frontend's list carries one that is absent here, that preset is
// being shown and never sent — which is its own finding, and the reason the
// two should be reconciled rather than assumed equal.
const PRESETS = [
  { key: 'viral_engaging', original: 'Viral engaging video', expanded: null },
  { key: 'clean_engaging', original: 'Clean and engaging edit', expanded: null },
  { key: 'clean_professional', original: 'Clean and professional', expanded: null },
  { key: 'corporate', original: 'Professional corporate style', expanded: null },
  { key: 'fast_cuts', original: 'Fast cuts, big captions', expanded: null },
  { key: 'fast_punchy', original: 'Fast paced punchy', expanded: null },
  { key: 'smooth_zooms', expanded: null,
    original: 'Make this a smooth video, add zooms, sound effects and motion graphics.' },
  // The "+" variant is a SEPARATE ENTRY rather than a looser pattern on the
  // one above. A pattern loose enough to catch both is loose enough to catch
  // a sentence someone typed, and this repo has already paid for a matcher
  // that learned a sentence's FORM instead of its content.
  { key: 'smooth_zooms_plus', expanded: null,
    original: 'Make this a smooth video, add zooms, + sound effects and motion graphics.' },
];

/** Case- and whitespace-normalised, FOR MATCHING ONLY. Never returned. */
function normalize(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
}

const BY_NORM = new Map(PRESETS.map((p) => [normalize(p.original), p]));

/**
 * -> { sent, matched, preset_key, variant, changed }
 *
 * `sent` is what ChatCut receives. On any non-match it is `vibe` UNCHANGED,
 * including whitespace and case — the normalised form is never returned.
 */
function expand(vibe, { variant = 'identity' } = {}) {
  const original = vibe == null ? '' : String(vibe);
  const hit = BY_NORM.get(normalize(original));
  if (!hit) {
    return { original, sent: original, matched: false, preset_key: null,
             variant, changed: false };
  }
  // A MATCH IS NOT YET A REWRITE. `expanded` is null until a winner is
  // picked, and the identity variant never rewrites at all.
  const wording = (variant === 'expanded' && hit.expanded) || null;
  return {
    original,
    sent: wording || original,
    matched: true,
    preset_key: hit.key,
    variant,
    changed: Boolean(wording && wording !== original),
  };
}

/**
 * The log line. ORIGINAL AND SENT, both, per the spec — and the first version
 * of this function was malformed: it built the "original" field from
 * `r.sent.slice(0, 0)`, which is the empty string, then tried to patch it up
 * with a .replace. It would have logged an empty original on every request
 * and the field would have looked present. A log that is WRONG is worse than
 * one that is missing, because it is the thing the next person reads instead
 * of checking.
 *
 * Both strings are truncated and JSON-quoted so a newline or a quote in a
 * user's vibe cannot break the line into two.
 */
function logLine(r) {
  const cut = (s) => JSON.stringify(String(s == null ? '' : s).slice(0, 120));
  return `[preset] variant=${r.variant} matched=${r.matched}`
    + (r.preset_key ? ` key=${r.preset_key}` : '')
    + ` changed=${r.changed}`
    + ` original=${cut(r.original)}`
    + (r.changed ? ` sent=${cut(r.sent)}` : ' sent=<unchanged>');
}

module.exports = { expand, normalize, logLine, PRESETS, VARIANTS, BY_NORM };
