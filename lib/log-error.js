'use strict';

// ── ONE LINE, OR THE CAUSE IS NOT IN THE RECORD YOU FIND ────────────────────
//
// `console.error('[ProfileSettings] update error', pgErr)` looks complete and
// is not. Node's util.inspect breaks any object wider than ~80 characters onto
// several lines, and a log pipe stores one record per line. So the record that
// matches a search for the tag is literally:
//
//     [ProfileSettings] update error {
//
// and the cause — code 23505, constraint profiles_email_key — sits in four
// further records that carry no tag, no route and no user, one of them just
// `}`. Grep finds the line that ends at `{` and stops. The failure was visible
// 29 times over four days and nobody could read it.
//
// Same class as the _delivered predicate and the empty-success 200: the thing
// that LOOKS like the signal is not the thing that carries it.
//
// So: one line, identifying fields FIRST, so that the length cap at the end can
// only ever cost the tail (a long `details`) and never the code or the message.

const MAX = 800;

function oneLine(s) {
  return String(s).replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/**
 * A PostgREST/Supabase error, an Error, or anything else, as ONE line.
 *
 * @param {*} err  what the failing call handed back
 * @param {object} [ctx]  identifying fields to lead with (user, route, id…).
 *   Put the user here: without it a 500 in the log cannot be counted per user,
 *   and Rule 7 says the user count is the headline.
 */
function errLine(err, ctx) {
  const parts = [];
  for (const [k, v] of Object.entries(ctx || {})) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${k}=${oneLine(v)}`);
  }

  if (err === null || err === undefined) {
    parts.push('err=<none> (a falsy error reached a logger — the caller branched on the wrong value)');
    return parts.join(' ');
  }

  if (err instanceof Error) {
    parts.push(`err=${err.name}: ${oneLine(err.message) || '<empty message>'}`);
    if (err.code) parts.push(`code=${oneLine(err.code)}`);
    if (err.statusCode) parts.push(`status=${err.statusCode}`);
    const frame = String(err.stack || '').split('\n')[1];
    if (frame) parts.push(`at=${oneLine(frame).replace(/^at\s+/, '')}`);
  } else if (typeof err === 'object') {
    // PostgREST's shape. `code` and `message` are what name the cause, so they
    // go first; `details` can be long and goes last, where the cap bites.
    if (err.code !== undefined) parts.push(`code=${oneLine(err.code)}`);
    if (err.message !== undefined) parts.push(`message=${oneLine(err.message)}`);
    // The constraint name is inside message for 23505 ("violates unique
    // constraint \"profiles_email_key\"") — lift it out so it is greppable on
    // its own, because the constraint IS the diagnosis.
    const con = /constraint "([^"]+)"/.exec(String(err.message || ''));
    if (con) parts.push(`constraint=${con[1]}`);
    if (err.hint) parts.push(`hint=${oneLine(err.hint)}`);
    if (err.details) parts.push(`details=${oneLine(err.details)}`);
    const known = new Set(['code', 'message', 'hint', 'details']);
    const extra = Object.keys(err).filter((k) => !known.has(k));
    for (const k of extra.slice(0, 6)) {
      const v = err[k];
      if (v === null || v === undefined || typeof v === 'object') continue;
      parts.push(`${k}=${oneLine(v)}`);
    }
  } else {
    parts.push(`err=${oneLine(err)}`);
  }

  const line = parts.join(' ');
  return line.length <= MAX ? line : `${line.slice(0, MAX - 3)}...`;
}

module.exports = { errLine, MAX };
