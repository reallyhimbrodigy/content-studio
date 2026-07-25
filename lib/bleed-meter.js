'use strict';

// Daily bleed meter — a once-a-day [REPORT] digest to the founder: what the
// pipeline produced in the last 24h and roughly what it cost, so a silent cost
// runaway (a retry storm, a stuck-loop burning compute, a spike of expensive
// premium renders) becomes visible within a day instead of at the next Modal
// invoice. Same channel as the [ALERT] path (sendOwnerAlert → APNs to the
// founder). Report-only: it never gates, refunds, or mutates a job.
//
// Hygiene (permanent, per the founder's standing rule): every count excludes
// internal accounts (admin / review / founder / far-future pro_until) AND
// test-prefixed job ids (e2e-*, test-*, smoke-*). The digest reflects real
// user traffic only — the same exclusion set as the funnel/retroactive stats.

const { sendOwnerAlert } = require('../services/pushNotifier');

const OWNER_USER_ID = process.env.OWNER_USER_ID || 'ec702499-ca10-49e6-8850-df8f99840904';

// Fire once/day at a fixed UTC hour so the digest lands at a predictable time
// regardless of when the dyno last restarted.
const REPORT_HOUR_UTC = Number(process.env.BLEED_REPORT_HOUR_UTC || 15);

// Modal cost model. These are unit list-price rates for the run_pipeline_bg
// container shape (cpu=64, memory=128GiB); confirm against the actual Modal
// invoice and override via env if they drift. The digest prints the derived
// per-hour rate so the estimate is always auditable, never a black box.
const CPU_CORE_SEC_USD = Number(process.env.MODAL_CPU_CORE_SEC_USD || 0.0000131); // ~$0.047/core/hr
const MEM_GIB_SEC_USD  = Number(process.env.MODAL_MEM_GIB_SEC_USD  || 0.00000222); // ~$0.008/GiB/hr
const WORKER_CORES = Number(process.env.MODAL_WORKER_CORES || 64);
const WORKER_GIB   = Number(process.env.MODAL_WORKER_GIB   || 128);
const RATE_PER_SEC = WORKER_CORES * CPU_CORE_SEC_USD + WORKER_GIB * MEM_GIB_SEC_USD;

// Designed rejections — a deliberate "we can't edit this" verdict, NOT a bug.
// These are healthy (the pipeline protecting output quality); they get their
// own line so a spike in real errors can't hide behind them.
const DESIGNED_CODES = new Set([
  'NO_SPEECH', 'NO_SPEECH_FACE', 'NO_SPEECH_NONENGLISH', 'NOT_TALKING_HEAD',
  'NO_FACE', 'CLIP_TOO_LONG', 'CLIP_TOO_SHORT',
]);

const TEST_PREFIXES = ['e2e-', 'test-', 'smoke-'];

const COMMERCE_EVENTS = [
  'paywall_view', 'offerings_loaded', 'offerings_load_failed',
  'purchase_attempt', 'purchase_error', 'trial_start',
];

const INTERNAL_OR =
  '(pro_until.gte.2030-01-01,email.eq.admin@usepromptly.app,' +
  'email.eq.promptlyreview@gmail.com,email.eq.zacharylibman@gmail.com)';

// Module-level day guard so a mid-day dyno restart cannot double-fire the
// digest. Seeded from the marker table on first run (below).
let _lastReportedDayKey = null;

function _isTestJob(id) {
  const s = String(id || '');
  return TEST_PREFIXES.some((p) => s.startsWith(p));
}

// Wall-clock compute seconds for one job: started_at → terminal instant. Falls
// back to created_at / updated_at when the precise stamps are absent. Clamped
// to [0, 3600] so a corrupt timestamp can't blow up the spend estimate.
function _wallSeconds(row) {
  const start = row.started_at || row.created_at;
  const end = row.completed_at || row.updated_at;
  if (!start || !end) return 0;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 0;
  const secs = (e - s) / 1000;
  if (!(secs > 0)) return 0;
  return Math.min(secs, 3600);
}

// Pull an error code out of the terminal result json / error_message. Designed
// rejections always carry an explicit code; a failure with no extractable code
// is treated as a real error (conservative — surfaces for investigation rather
// than hiding in the designed-rejection bucket).
function _errCode(row) {
  const res = row.result;
  if (res && typeof res === 'object') {
    if (typeof res.error_code === 'string') return res.error_code;
    if (typeof res.code === 'string') return res.code;
    if (res.error && typeof res.error === 'object' && typeof res.error.code === 'string') {
      return res.error.code;
    }
  }
  const em = String(row.error_message || '');
  const m = em.match(/\b([A-Z][A-Z0-9_]{3,})\b/);
  return m ? m[1] : null;
}

async function _internalIds(supabaseAdmin) {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id,email')
      .or(INTERNAL_OR);
    if (error) throw error;
    return new Set((data || []).map((r) => r.id));
  } catch (e) {
    console.warn('[bleed-meter] internal-id fetch failed (non-fatal):', e?.message || e);
    return new Set();
  }
}

// Compute the digest for [sinceISO, untilISO). Pure read; paginates video_jobs.
async function computeBleedDigest(supabaseAdmin, { sinceISO, untilISO }) {
  const internal = await _internalIds(supabaseAdmin);
  const d = {
    sinceISO, untilISO,
    completions: 0, designedRejections: 0, realErrors: 0, inFlight: 0,
    computeSeconds: 0, ratePerSec: RATE_PER_SEC,
    excludedInternal: 0, excludedTest: 0, total: 0,
    designedBreakdown: {}, errorBreakdown: {},
  };

  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('video_jobs')
      .select('id,status,result,error_message,user_id,created_at,started_at,completed_at,updated_at')
      .gte('created_at', sinceISO)
      .lt('created_at', untilISO)
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) {
      if (_isTestJob(row.id)) { d.excludedTest++; continue; }
      if (internal.has(row.user_id)) { d.excludedInternal++; continue; }
      d.total++;
      d.computeSeconds += _wallSeconds(row);
      const st = row.status;
      if (st === 'completed') {
        d.completions++;
      } else if (st === 'failed') {
        const code = _errCode(row);
        if (code && DESIGNED_CODES.has(code)) {
          d.designedRejections++;
          d.designedBreakdown[code] = (d.designedBreakdown[code] || 0) + 1;
        } else {
          d.realErrors++;
          const key = code || 'UNCODED';
          d.errorBreakdown[key] = (d.errorBreakdown[key] || 0) + 1;
        }
      } else {
        d.inFlight++; // queued/processing at snapshot time
      }
    }
    if (rows.length < PAGE) break;
  }

  d.estUsd = d.computeSeconds * RATE_PER_SEC;
  return d;
}

// Commerce line — counts the six client events in the window. Returns null
// until events actually flow (iOS ship), so the line reads "—" rather than a
// misleading zero.
async function _commerceLine(supabaseAdmin, { sinceISO, untilISO }) {
  try {
    const { data, error } = await supabaseAdmin
      .from('analytics_events')
      .select('event')
      .in('event', COMMERCE_EVENTS)
      .gte('created_at', sinceISO)
      .lt('created_at', untilISO)
      .limit(5000);
    if (error) throw error;
    if (!data || data.length === 0) return null;
    const c = {};
    for (const r of data) c[r.event] = (c[r.event] || 0) + 1;
    const pv = c.paywall_view || 0;
    const pa = c.purchase_attempt || 0;
    const ts = c.trial_start || 0;
    const pe = c.purchase_error || 0;
    return `paywalls ${pv} · attempts ${pa} · trials ${ts} · errors ${pe}`;
  } catch (e) {
    // table may not exist yet (migration not applied) — degrade silently
    return null;
  }
}

// Degeneration-class scoreboard (Lever-3 flip watch): scans the day's divergence
// ledgers for the worker's always-on `rationale_length` line (ballooned = a why
// past 500 chars, ~6x its budget) + the gemini_degen_tail / degen_retry aborts —
// so the flip has a live incidence line from minute one. Best-effort; the whole
// scan is wrapped so a missing bucket / creds never breaks the digest.
async function _degenScoreboard(sinceISO, untilISO) {
  try {
    const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-1' });
    const B = 'thisismybucketagainwooo';
    const since = new Date(sinceISO), until = new Date(untilISO);
    let editorial = 0, ballooned = 0, aborts = 0, maxChars = 0, token;
    for (let page = 0; page < 30; page++) {
      const r = await s3.send(new ListObjectsV2Command({
        Bucket: B, Prefix: 'divergences/', MaxKeys: 1000, ContinuationToken: token,
      }));
      for (const o of (r.Contents || [])) {
        const m = new Date(o.LastModified);
        if (m < since || m >= until) continue;
        try {
          const g = await s3.send(new GetObjectCommand({ Bucket: B, Key: o.Key }));
          const body = await g.Body.transformToString();
          let sawRat = false, sawBloat = false, sawAbort = false, mx = 0;
          for (const line of body.split('\n')) {
            if (!line) continue;
            if (line.includes('"rationale_length"')) {
              sawRat = true;
              const mm = line.match(/"max_field_chars":\s*(\d+)/);
              if (mm) mx = Math.max(mx, Number(mm[1]));
              if (/"ballooned":\s*true/.test(line)) sawBloat = true;
            }
            if (line.includes('gemini_degen_tail') || line.includes('degen_retry')) sawAbort = true;
          }
          if (sawRat) editorial++;
          if (sawBloat) ballooned++;
          if (sawAbort) aborts++;
          maxChars = Math.max(maxChars, mx);
        } catch (_) { /* unreadable ledger — skip */ }
      }
      if (!r.IsTruncated) break;
      token = r.NextContinuationToken;
    }
    if (editorial === 0 && aborts === 0) return null;
    const maxK = maxChars >= 1000 ? `${(maxChars / 1000).toFixed(1)}k` : String(maxChars);
    return `${ballooned}/${editorial} ballooned why${aborts ? ` · ${aborts} aborts` : ''}`
      + (maxChars ? ` · max ${maxK} chars` : '');
  } catch (_) {
    return null;
  }
}

// Language-coverage scoreboard (multilingual Workstream C watch): scans the
// day's divergence ledgers for the worker's `language_coverage` records — one
// per NON-English render, tagged with language name + tier (1 = certified,
// 2 = enabled+watched). Surfaces what languages we actually render and flags a
// Tier-2 language the moment it appears. Best-effort; the whole scan is wrapped
// so a missing bucket / creds never breaks the digest.
async function _languageScoreboard(sinceISO, untilISO) {
  try {
    const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-1' });
    const B = 'thisismybucketagainwooo';
    const since = new Date(sinceISO), until = new Date(untilISO);
    const byLang = new Map(); // name -> { count, tier }
    let token;
    for (let page = 0; page < 30; page++) {
      const r = await s3.send(new ListObjectsV2Command({
        Bucket: B, Prefix: 'divergences/', MaxKeys: 1000, ContinuationToken: token,
      }));
      for (const o of (r.Contents || [])) {
        const m = new Date(o.LastModified);
        if (m < since || m >= until) continue;
        try {
          const g = await s3.send(new GetObjectCommand({ Bucket: B, Key: o.Key }));
          const body = await g.Body.transformToString();
          for (const line of body.split('\n')) {
            if (!line.includes('language_coverage')) continue;
            let rec; try { rec = JSON.parse(line); } catch (_) { continue; }
            if (!rec || rec.component !== 'language_coverage') continue;
            const orig = rec.original || {};
            const name = orig.name || orig.lang || '?';
            const tier = /2/.test(String(rec.reason)) ? 2 : 1;
            const cur = byLang.get(name) || { count: 0, tier };
            cur.count++; cur.tier = tier;
            byLang.set(name, cur);
          }
        } catch (_) { /* unreadable ledger — skip */ }
      }
      if (!r.IsTruncated) break;
      token = r.NextContinuationToken;
    }
    if (byLang.size === 0) return null;
    const parts = [...byLang.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, v]) => `${name}:${v.count}(T${v.tier})`);
    const t2 = [...byLang.values()].filter((v) => v.tier === 2).length;
    return parts.join(' · ') + (t2 ? `  [${t2} Tier-2 watch]` : '');
  } catch (_) {
    return null;
  }
}

function formatDigest(d, commerce, degen, languages) {
  const day = String(d.untilISO).slice(0, 10);
  const hrs = (d.computeSeconds / 3600);
  const ratePerHr = d.ratePerSec * 3600;
  const desc = Object.entries(d.designedBreakdown)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k.replace(/^NO_SPEECH_?/, 'NS_') }:${v}`).join(' ');
  const errd = Object.entries(d.errorBreakdown)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k}:${v}`).join(' ');
  const lines = [
    `✅ Completions: ${d.completions}`,
    `🚫 Rejections: ${d.designedRejections}${desc ? `  (${desc})` : ''}`,
    `🔴 Errors: ${d.realErrors}${errd ? `  (${errd})` : ''}${d.inFlight ? ` · ${d.inFlight} in-flight` : ''}`,
    `🌀 Degen: ${degen || '— (0 ballooned)'}`,
    `🌐 Languages: ${languages || '— (English only)'}`,
    `💸 Est. Modal: $${d.estUsd.toFixed(2)}  (${hrs.toFixed(2)}h @ $${ratePerHr.toFixed(2)}/h)`,
    `📈 Commerce: ${commerce || '— (awaiting iOS event ship)'}`,
  ];
  // Owner-alert title law: "[Promptly]" in every operator push title (the bare
  // notification otherwise collides with Render-the-host and friends). The
  // grep-stable [REPORT] channel tag stays on the log line that prints this.
  const title = `[Promptly] Bleed meter · ${day}`;
  const excl = (d.excludedInternal + d.excludedTest) > 0
    ? `\n(excl ${d.excludedInternal} internal · ${d.excludedTest} test)` : '';
  const body = lines.join('\n') + excl;
  return { title, body };
}

// Best-effort marker in analytics_events — doubles as the restart-dedup source
// and a durable audit trail of past digests. Tolerates the table being absent.
async function _lastReportDayKey(supabaseAdmin) {
  try {
    const { data, error } = await supabaseAdmin
      .from('analytics_events')
      .select('created_at,props')
      .eq('event', 'ops_bleed_report')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    if (data && data[0]) return (data[0].props && data[0].props.day_key) || null;
  } catch (_) { /* table absent — fall back to in-memory guard */ }
  return null;
}

async function _writeMarker(supabaseAdmin, dayKey, digest) {
  try {
    await supabaseAdmin.from('analytics_events').insert({
      event: 'ops_bleed_report',
      props: {
        day_key: dayKey,
        completions: digest.completions,
        designed_rejections: digest.designedRejections,
        real_errors: digest.realErrors,
        est_usd: Number(digest.estUsd.toFixed(2)),
        compute_seconds: Math.round(digest.computeSeconds),
      },
    });
  } catch (e) {
    console.warn('[bleed-meter] marker write failed (non-fatal):', e?.message || e);
  }
}

// Hourly tick. Fires the digest at most once per UTC day, at/after
// REPORT_HOUR_UTC. `now` is injectable for tests.
async function maybeRunBleedMeter(supabaseAdmin, opts = {}) {
  if (!supabaseAdmin) return { ran: false, reason: 'no_supabase' };
  const now = opts.now || new Date();
  const dayKey = now.toISOString().slice(0, 10); // UTC date

  // Before the report hour → nothing to do yet today.
  if (now.getUTCHours() < REPORT_HOUR_UTC) return { ran: false, reason: 'before_hour' };

  // Seed the guard from the durable marker on first run after a restart.
  if (_lastReportedDayKey === null) {
    _lastReportedDayKey = await _lastReportDayKey(supabaseAdmin);
  }
  if (_lastReportedDayKey === dayKey) return { ran: false, reason: 'already_today' };

  const untilISO = now.toISOString();
  const sinceISO = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const digest = await computeBleedDigest(supabaseAdmin, { sinceISO, untilISO });
  const commerce = await _commerceLine(supabaseAdmin, { sinceISO, untilISO });
  const degen = await _degenScoreboard(sinceISO, untilISO);
  const languages = await _languageScoreboard(sinceISO, untilISO);
  const { title, body } = formatDigest(digest, commerce, degen, languages);

  console.log(`[REPORT] ${title}\n${body}`);
  try {
    await sendOwnerAlert({
      ownerUserId: OWNER_USER_ID,
      title,
      body,
      threadId: 'bleed-meter',
      supabaseAdmin,
    });
  } catch (e) {
    console.warn('[bleed-meter] owner push failed (non-fatal):', e?.message || e);
  }

  _lastReportedDayKey = dayKey;
  await _writeMarker(supabaseAdmin, dayKey, digest);
  return { ran: true, digest };
}

module.exports = {
  maybeRunBleedMeter,
  computeBleedDigest,
  formatDigest,
  RATE_PER_SEC,
};
