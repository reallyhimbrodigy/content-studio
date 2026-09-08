'use strict';

// ── SERVER-SIDE LOCALE NEGOTIATION ──────────────────────────────────────────
//
// THE DEFECT. The app ships 107 localized strings in 12 locales, and every
// server-authored error bypassed all of it: the client renders `body.message`
// VERBATIM (APIService.swift:94, 110, 238, 473), and the server had no
// Accept-Language handling anywhere. Measured 2026-09-04 over 30 days:
// 545 distinct users on non-English device locales out of 11,910 — fr 185,
// ar 128, id 70, es 58, pt 51, de 42, ja 6, hi 5. Every one of those eight is
// a locale we already translate. They were shown English regardless.
//
// WHY A CATALOG AND NOT A TRANSLATION SERVICE. These strings are a closed set of
// ~10 refusals, they change rarely, and a network call on the error path would
// add a failure mode to the code that runs WHEN THINGS ARE ALREADY FAILING.
//
// ARABIC AND URDU ARE RTL. We return text only and set no direction — the
// client owns rendering, and it already lays out RTL for its own strings.

// The locales the iOS app actually ships (Localizable.xcstrings). Negotiating a
// locale we cannot render is worse than falling back: it would return a
// language the client has no font stack or layout for.
const SUPPORTED = ['en', 'ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'ja', 'ne', 'pt-BR', 'ur'];
const DEFAULT_LOCALE = 'en';

/**
 * Best supported locale for an Accept-Language header.
 *
 * RFC 4647 lookup, not a substring match: q-values are honoured, and a tag is
 * matched by progressively dropping subtags ("pt-BR" -> "pt"), so a device
 * asking for pt-PT gets pt-BR rather than English. Returns DEFAULT_LOCALE for
 * anything absent, malformed, or unsupported — never null, because every caller
 * is on an error path and must not have to branch.
 */
function negotiateLocale(header, supported = SUPPORTED) {
  const raw = String(header || '').trim();
  if (!raw) return DEFAULT_LOCALE;
  const lower = supported.map((s) => s.toLowerCase());
  const ranked = raw.split(',').map((part, i) => {
    const [tagRaw, ...params] = part.trim().split(';');
    const qp = params.find((p) => p.trim().startsWith('q='));
    let q = qp ? parseFloat(qp.split('=')[1]) : 1;
    if (!Number.isFinite(q) || q < 0 || q > 1) q = 0;
    // i breaks ties in header order, which is the client's own preference.
    return { tag: tagRaw.trim().toLowerCase(), q, i };
  }).filter((r) => r.tag && r.q > 0)
    .sort((a, b) => (b.q - a.q) || (a.i - b.i));

  for (const { tag } of ranked) {
    if (tag === '*') return DEFAULT_LOCALE;
    let probe = tag;
    while (probe) {
      const hit = lower.indexOf(probe);
      if (hit !== -1) return supported[hit];
      // A tag must also reach a REGIONAL variant we ship, and this has to be
      // tried at EVERY truncation level, not just the original tag: "pt-PT"
      // truncates to "pt", and it is "pt" that matches "pt-BR". Checking only
      // the full tag sent a Portugal device to English — the exact failure
      // this negotiator exists to prevent.
      const region = lower.findIndex((s) => s.startsWith(`${probe}-`));
      if (region !== -1) return supported[region];
      // "pt-br-x-foo" -> "pt-br" -> "pt"
      const cut = probe.lastIndexOf('-');
      if (cut === -1) break;
      probe = probe.slice(0, cut);
    }
  }
  return DEFAULT_LOCALE;
}


// ── DOES THE HEADER EVEN ARRIVE? ────────────────────────────────────────────
// The whole fix is inert if the client sends no Accept-Language. iOS URLSession
// is DOCUMENTED to set it from Locale.preferredLanguages, and the iOS source
// sets it nowhere explicitly — but "documented" is not "observed", and this
// codebase has paid for that difference before. So the server COUNTS what it
// actually receives and /api/health reports it. Within a day of traffic this is
// a measurement instead of an inference.
//
// Bounded and in-memory on purpose: it is a diagnostic, not analytics, and it
// must not become a per-request write or a memory leak.
const _seen = { withHeader: 0, withoutHeader: 0, byLocale: Object.create(null),
                since: Date.now() };

function observeLocale(header, locale) {
  if (String(header || '').trim()) _seen.withHeader++;
  else _seen.withoutHeader++;
  if (Object.keys(_seen.byLocale).length < 40) {
    _seen.byLocale[locale] = (_seen.byLocale[locale] || 0) + 1;
  }
}

function localeStats() {
  const total = _seen.withHeader + _seen.withoutHeader;
  return {
    // THE WINDOW, because this counter is IN-MEMORY and a deploy or instance
    // cycle silently zeroes it. Without these two fields a reader cannot tell
    // "0.72 over a day" from "0.72 over ten minutes since the last deploy" —
    // the same number carrying completely different weight. A rate reported
    // without the window it was measured over is the contaminated-cohort
    // mistake in miniature.
    since: new Date(_seen.since).toISOString(),
    window_s: Math.round((Date.now() - _seen.since) / 1000),
    requests: total,
    with_header: _seen.withHeader,
    without_header: _seen.withoutHeader,
    // THE NUMBER THAT SETTLES IT. Near 0 with real traffic means the client
    // sends nothing and the negotiation is dark until it does.
    header_rate: total ? Math.round((_seen.withHeader / total) * 100) / 100 : null,
    by_locale: { ..._seen.byLocale },
  };
}

module.exports = { SUPPORTED, DEFAULT_LOCALE, negotiateLocale, observeLocale, localeStats };
