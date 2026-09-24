'use strict';
// SERVER-SIDE UPLOAD FLAGS: per-account allowlist, then percentage, then off.
//
// TWO CALLERS, ONE MECHANISM, on purpose. The acceleration canary and
// Frontend's `upload_shrink` want exactly the same thing — turn it on for
// three named accounts, then a slice, then everyone — and two mechanisms
// would mean two rollout behaviours to reason about at 2am.
//
// ── WHY NOT JUST AN ENV VAR ─────────────────────────────────────────────────
// An env var on Render is not live until a REDEPLOY (already written down in
// this repo: "a secret flip is not live until a redeploy" — memory snapshots
// capture os.environ at deploy time). "Changeable without a deploy" therefore
// cannot be env alone. So this reads a DATABASE row first and falls back to
// env, which means:
//   * it works TODAY, with env, before any migration is applied;
//   * it becomes no-deploy the moment the table exists, with no code change.
// migrations/add-server-flags.sql has the table. Until it is applied, every
// resolution comes from env and `source` says so.
//
// ── THE PERCENTAGE IS A STABLE HASH, NOT A COIN FLIP ────────────────────────
// A user must get the SAME answer on every request, or a canary produces a
// user whose first upload accelerates and whose retry does not — and the
// comparison is then between two populations that both contain everybody.
// Hashed on flag+userId so 10% of `upload_shrink` is a different tenth from
// 10% of `s3_accelerate`; sharing the hash would correlate the two rollouts
// and make either one's result unreadable.

const crypto = require('crypto');

// Zac's internal accounts. Named here rather than left to the dashboard so a
// canary has somebody in it on the first deploy — the allowlist being empty
// is how a canary reports "no effect" without ever having run.
const DEFAULT_ALLOWLIST = [
  'ec702499-ca10-49e6-8850-df8f99840904',
  '08956fe8-ab49-4351-a938-474feff0002d',
  '2efb75dd-cf8b-496a-a3a3-75c5f7f349f3',
];

const FLAGS = {
  // The acceleration canary. Global default OFF until the canary lands, then
  // S3_ACCELERATE_PERCENT=100 or the table row.
  s3_accelerate: { envAllow: 'S3_ACCELERATE_USER_IDS', envPct: 'S3_ACCELERATE_PERCENT',
                   envAll: 'S3_USE_ACCELERATE', defaultAllowlist: DEFAULT_ALLOWLIST },
  // Frontend's knob. Values are "on" or ABSENT — never "off", because the
  // client treats absence as off and a third value would be a third code path.
  upload_shrink: { envAllow: 'UPLOAD_SHRINK_USER_IDS', envPct: 'UPLOAD_SHRINK_PERCENT',
                   envAll: 'UPLOAD_SHRINK_ALL', defaultAllowlist: DEFAULT_ALLOWLIST },
};

let _cache = { at: 0, rows: null };
const CACHE_MS = 30 * 1000;   // a rollout change lands within 30s, no deploy

// ── THE FAILURE IS CACHED TOO, AND THE FIRST VERSION DID NOT DO THAT ───────
// _cache was written ONLY on success. With server_flags not yet applied, every
// read errors, nothing is ever cached, and the cache never warms — so EVERY
// REQUEST on /api/upload-url, /api/upload-multipart-init and
// /api/profile/settings issued a fresh query for a table that does not exist,
// and /api/upload-flags issued one PER FLAG ASKED, up to twelve.
//
// The comment I wrote there said "TABLE ABSENT IS NOT ALL FLAGS OFF" — I was
// careful about what absence MEANS and careless about what it COSTS. A
// read-through cache that only caches hits is not a cache; it is a rate
// limiter that never engages, and it engages least exactly when the dependency
// is unhealthy, which is when it is needed most.
//
// A MISSING TABLE IS NOT A TRANSIENT ERROR, so the two are backed off
// differently. PostgREST reports an unknown relation as PGRST205 / 42P01, and
// that condition cannot resolve without a migration — a human action — so
// retrying it every 30 seconds forever is pure load. It goes straight to the
// long window. Anything else might be transient and gets an exponential
// backoff from 30s.
const NEG_MIN_MS = 30 * 1000;
const NEG_MAX_MS = 10 * 60 * 1000;
const MISSING_TABLE_CODES = new Set(['PGRST205', 'PGRST106', '42P01']);
let _neg = { until: 0, ms: NEG_MIN_MS, reason: null, logged: false };

function _backOff(error) {
  const code = (error && (error.code || error.status)) || null;
  const missing = MISSING_TABLE_CODES.has(String(code))
    || /does not exist|could not find the table/i.test((error && error.message) || '');
  _neg.ms = missing ? NEG_MAX_MS : Math.min(NEG_MAX_MS, Math.max(NEG_MIN_MS, _neg.ms * 2));
  _neg.until = Date.now() + _neg.ms;
  _neg.reason = missing ? `missing_table(${code || 'by message'})` : `error(${code || 'unknown'})`;
  // ONCE, NOT PER REQUEST. A per-request line for a known-absent table is the
  // log-spam version of the same defect.
  if (!_neg.logged) {
    _neg.logged = true;
    console.warn(`[upload-flags] server_flags unreadable (${_neg.reason}) — falling back to `
      + `env and backing off ${Math.round(_neg.ms / 1000)}s. This logs once per process.`);
  }
}

async function _dbRows(supabaseAdmin) {
  if (!supabaseAdmin) return null;
  if (_cache.rows && Date.now() - _cache.at < CACHE_MS) return _cache.rows;
  // THE NEGATIVE WINDOW: do not touch the database at all.
  if (Date.now() < _neg.until) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('server_flags').select('flag, allowlist, percent, enabled_all');
    if (error) { _backOff(error); return null; }   // ABSENT IS NOT "ALL FLAGS OFF"
    _cache = { at: Date.now(), rows: data || [] };
    _neg = { until: 0, ms: NEG_MIN_MS, reason: null, logged: false };  // recovered
    return _cache.rows;
  } catch (e) { _backOff(e); return null; }
}

// Test seam: the backoff is process state, and a test that cannot reset it
// measures whichever test ran first.
function _resetFlagCache() {
  _cache = { at: 0, rows: null };
  _neg = { until: 0, ms: NEG_MIN_MS, reason: null, logged: false };
}

function _pct(flag, userId) {
  const h = crypto.createHash('sha256').update(`${flag}:${userId}`).digest();
  return h.readUInt32BE(0) % 100;          // 0..99, stable per (flag, user)
}

function _envList(name) {
  return String(process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * -> { on: boolean, source: 'allowlist'|'percent'|'all'|'off', from: 'db'|'env' }
 *
 * The SOURCE is returned, not just the boolean. A canary that cannot say WHY a
 * user was included cannot tell an allowlist hit from a percentage hit, and
 * those are different experiments sharing one number.
 */
// A FLAG NAME THIS FILE HAS NEVER SEEN STILL RESOLVES. Frontend is about to
// post a third flag name, and requiring a code change per name would make
// "changeable without a deploy" false for exactly the flag that needs it
// soonest. An unlisted name gets the conventional env triplet
// (<NAME>_USER_IDS / <NAME>_PERCENT / <NAME>_ALL) and the same default
// allowlist, so it works the moment the name is chosen.
function specFor(flag) {
  if (FLAGS[flag]) return FLAGS[flag];
  const U = String(flag).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return { envAllow: `${U}_USER_IDS`, envPct: `${U}_PERCENT`, envAll: `${U}_ALL`,
           defaultAllowlist: DEFAULT_ALLOWLIST, conventional: true };
}

async function resolve(flag, userId, supabaseAdmin) {
  const spec = specFor(flag);
  if (!spec) return { on: false, source: 'off', from: 'none', why: 'unknown flag' };
  if (!userId) return { on: false, source: 'off', from: 'none', why: 'no user' };

  const rows = await _dbRows(supabaseAdmin);
  const row = rows && rows.find((r) => r.flag === flag);
  if (row) {
    if (row.enabled_all) return { on: true, source: 'all', from: 'db' };
    if (Array.isArray(row.allowlist) && row.allowlist.includes(userId)) {
      return { on: true, source: 'allowlist', from: 'db' };
    }
    const p = Number(row.percent || 0);
    if (p > 0 && _pct(flag, userId) < p) return { on: true, source: 'percent', from: 'db' };
    return { on: false, source: 'off', from: 'db' };
  }

  // ENV FALLBACK. Note `envAll` is read as an explicit string: S3_USE_ACCELERATE
  // is currently the literal "false" in production, and `Boolean("false")` is
  // true — the classic way a kill switch stops killing.
  const all = String(process.env[spec.envAll] || '').trim().toLowerCase();
  if (all === 'true' || all === '1') return { on: true, source: 'all', from: 'env' };
  const allow = _envList(spec.envAllow);
  const list = allow.length ? allow : spec.defaultAllowlist;
  if (list.includes(userId)) return { on: true, source: 'allowlist', from: 'env' };
  const p = Number(process.env[spec.envPct] || 0);
  if (p > 0 && _pct(flag, userId) < p) return { on: true, source: 'percent', from: 'env' };
  return { on: false, source: 'off', from: 'env' };
}

module.exports = { resolve, specFor, FLAGS, DEFAULT_ALLOWLIST, _pct,
                   _resetFlagCache, NEG_MIN_MS, NEG_MAX_MS };
