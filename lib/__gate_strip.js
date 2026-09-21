'use strict';

// ── STRIPPING COMMENTS MUST NOT REMOVE CODE ─────────────────────────────────
//
// Fifteen gates scanned source through `src.replace(/\/\*[\s\S]*?\*\//g, '')`.
// That regex has no idea what a string is, and server.js line 2098 contains a
// CSP header:
//
//     script-src ... https://*.contentsquare.net; style-src ...
//
// `://*` contains `/*`. The regex opened a comment there and closed it at the
// next genuine `*/`, 559 lines below — deleting 552 lines of live code,
// silently, from every gate that scanned server.js. Among them both
// /api/profile/settings handlers and /api/user/subscription. A gate cannot find
// a defect in source it was never given: this is the shrunken-input class, where
// a detector reads clean by having less to find.
//
// It also shifted every line number those gates reported, so a failure pointed
// at the wrong line.
//
// TWO RULES HERE:
//   1. LINE COUNT IS PRESERVED. Comments are blanked, never deleted, so
//      `server.js:NNNN` in a gate's message is the real line.
//   2. A BLOCK COMMENT ONLY OPENS WHERE ONE PLAUSIBLY COULD — at the start of a
//      line, or opened and closed within one line away from a URL. Anywhere
//      else the `/*` is assumed to be data. The failure direction matters: a
//      comment left in the scanned text can only make a gate fire when it
//      should not, which is loud. Code removed from the scanned text makes a
//      gate silently pass, which is what happened.

/** Same-line comments. Leaves `http://x` and `https://*.y` alone. */
function stripLine(line) {
  return line
    // `} catch (_) { /* best-effort */ }` — opens AND closes here, and the `/*`
    // is not part of a `//*` or `:*` run, so it cannot be a URL.
    .replace(/(^|[^:/])\/\*(?:(?!\*\/)[\s\S])*?\*\//g, '$1')
    // `// trailing` but never the `//` in `https://`
    .replace(/(^|[^:])\/\/.*$/, '$1');
}

/**
 * Comments out, line count unchanged.
 * @param {string} src
 * @returns {string} same number of lines, comment text replaced by nothing
 */
function stripComments(src) {
  const lines = String(src).split('\n');
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      inBlock = false;
      out.push(stripLine(line.slice(end + 2)));
      continue;
    }
    const open = line.indexOf('/*');
    // Only a `/*` that begins the line starts a multi-line comment. A `/*`
    // anywhere else that did not close on this line is data — a URL, a glob, a
    // regex — and treating it as a comment is exactly the 552-line hole.
    if (open !== -1 && line.slice(0, open).trim() === '' && line.indexOf('*/', open + 2) === -1) {
      inBlock = true;
      out.push('');
      continue;
    }
    out.push(stripLine(line));
  }
  return out.join('\n');
}

module.exports = { stripComments, stripLine };
