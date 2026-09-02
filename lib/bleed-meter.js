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
    completions: 0, designedRejections: 0, realErrors: 0, inFlight: 0, canceled: 0,
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
      } else if (st === 'canceled' || st === 'cancelled') {
        // A CANCEL IS TERMINAL, NOT IN-FLIGHT (2026-08-04). Cancels fell to the
        // else-branch and were reported as still running, so the in-flight
        // figure counted jobs the user had already abandoned. They are NOT
        // errors either — the user chose it, they are refunded, and they carry
        // no result by design — so they get their own line rather than
        // inflating either side.
        d.canceled = (d.canceled || 0) + 1;
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
      .select('event,props')
      .in('event', COMMERCE_EVENTS)
      .gte('created_at', sinceISO)
      .lt('created_at', untilISO)
      .limit(5000);
    if (error) throw error;
    if (!data || data.length === 0) return null;
    const c = {};
    // Sandbox conversions must not inflate commerce (a TestFlight tester's own
    // purchase). Webhook-truth events (trial_start) carry props.environment; drop
    // SANDBOX. Client events (paywall_view/purchase_attempt) have no tag and pass.
    for (const r of data) {
      if (r.props && r.props.environment === 'SANDBOX') continue;
      c[r.event] = (c[r.event] || 0) + 1;
    }
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


// Defects line (Zac LOUD FAIL-SAFE standing rule, 2026-07-25): worker fail-safes
// that mask a missing module / unarmed hook / absent DB column now ledger
// defect-class divergences (action *_defect, component 'defect') plus the
// progressive publisher's loud fallback — this scoreboard surfaces them daily
// so infrastructure gaps can never degrade silently again (the moodreel-mount
// lesson). Same S3 ledger scan as the degen/language boards.
async function _defectScoreboard(sinceISO, untilISO) {
  try {
    const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-1' });
    const B = 'thisismybucketagainwooo';
    const since = new Date(sinceISO), until = new Date(untilISO);
    const byAction = new Map(); // action -> count
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
            if (!line.includes('_defect') && !line.includes('progressive_publish_fallback')) continue;
            let rec; try { rec = JSON.parse(line); } catch (_) { continue; }
            if (!rec || !rec.action) continue;
            const isDefect = /_defect$/.test(String(rec.action))
              || rec.action === 'progressive_publish_fallback';
            if (!isDefect) continue;
            const site = ((rec.original || {}).site || (rec.original || {}).stage || '');
            const key = site ? `${rec.action}@${site}` : String(rec.action);
            byAction.set(key, (byAction.get(key) || 0) + 1);
          }
        } catch (_) { /* unreadable ledger — skip */ }
      }
      if (!r.IsTruncated) break;
      token = r.NextContinuationToken;
    }
    if (byAction.size === 0) return null;
    return [...byAction.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`).join(' · ');
  } catch (_) {
    return null;
  }
}


// Push-delivery line (SA-D step-4): lifecycle pushes sent in the window, counted
// from the claim markers (result.lifecycle_push_v1[kind] = ISO ts) — the same
// atomic claims that make double-push unconstructible double as the audit trail.
// Flag state named so the line is honest while USER_LIFECYCLE_PUSHES is off.

// Lumen scoreboard (premium designed-scene funnel watch): reads the worker's
// result.lumen_funnel + tier/model markers off completed video_jobs rows —
// routed premium jobs, scenes the model emitted, scenes that actually shipped,
// and which stage stripped the rest (the 0-shipped-in-80-jobs class becomes a
// one-line daily read). Same hygiene as every count: internal accounts and
// test-prefixed job ids excluded. Best-effort; returns null (line reads "—")
// when no premium job ran, and on ANY error — never breaks the digest.
async function _lumenScoreboard(supabaseAdmin, { sinceISO, untilISO }) {
  try {
    const internal = await _internalIds(supabaseAdmin);
    const agg = { routed: 0, emitted: 0, shipped: 0, drops: {} };
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('video_jobs')
        .select('id,status,result,user_id')
        .eq('status', 'completed')
        .gte('created_at', sinceISO)
        .lt('created_at', untilISO)
        .order('created_at', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      const rows = data || [];
      for (const row of rows) {
        if (_isTestJob(row.id) || internal.has(row.user_id)) continue;
        const res = row.result;
        if (!res || typeof res !== 'object') continue;
        const lf = (res.lumen_funnel && typeof res.lumen_funnel === 'object')
          ? res.lumen_funnel : {};
        const routed = res.route_premium === true || res.model === 'lumen'
          || lf.route_premium === true;
        if (!routed) continue;
        agg.routed++;
        const emitted = Number(lf.emitted_raw != null ? lf.emitted_raw : lf.emitted) || 0;
        const shipped = Number(lf.shipped) || 0;
        agg.emitted += emitted;
        agg.shipped += shipped;
        if (emitted > shipped && lf.drop_stage) {
          agg.drops[lf.drop_stage] = (agg.drops[lf.drop_stage] || 0) + 1;
        }
      }
      if (rows.length < PAGE) break;
    }
    if (agg.routed === 0) return null;
    const dropStr = Object.entries(agg.drops)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`).join(' ');
    return `routed ${agg.routed} · emitted ${agg.emitted} · shipped ${agg.shipped}`
      + (dropStr ? `  (drops ${dropStr})` : '');
  } catch (_) {
    return null;
  }
}

// W2 effort-tier wall-clock line: p50 total by tier (minimal / hype / TH),
// from result.stage_timings.total + result.route on completions in the window.
// "Per video should be different" as a reported fact.
async function _tierWallLine(supabaseAdmin, { sinceISO, untilISO }) {
  try {
    const { data, error } = await supabaseAdmin
      .from('video_jobs')
      .select('result')
      .eq('status', 'completed')
      .gte('updated_at', sinceISO)
      .lte('updated_at', untilISO)
      .limit(2000);
    if (error) throw error;
    const tiers = { minimal: [], hype: [], th: [] };
    for (const r of (data || [])) {
      const res = r.result || {};
      const t = (res.stage_timings || {}).total;
      if (typeof t !== 'number') continue;
      const route = res.route === 'minimal' ? 'minimal' : (res.route === 'hype' ? 'hype' : 'th');
      tiers[route].push(t);
    }
    const p50 = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)]); };
    const parts = [];
    for (const [name, arr] of Object.entries(tiers)) {
      if (arr.length) parts.push(`${name} ${p50(arr)}s(n${arr.length})`);
    }
    return parts.length ? parts.join(' · ') : null;
  } catch (_) {
    return null;
  }
}

async function _pushDeliveryLine(supabaseAdmin, { sinceISO, untilISO }) {
  try {
    const flagOn = String(process.env.USER_LIFECYCLE_PUSHES || '') === '1';
    const { data, error } = await supabaseAdmin
      .from('video_jobs')
      .select('result')
      .gte('updated_at', sinceISO)
      .lte('updated_at', untilISO)
      .not('result->lifecycle_push_v1', 'is', null)
      .limit(2000);
    if (error) throw error;
    let completed = 0, failed = 0;
    for (const r of (data || [])) {
      const m = (r.result || {}).lifecycle_push_v1 || {};
      if (m.completed) completed++;
      if (m.failed) failed++;
    }
    const state = flagOn ? '' : '  [flag OFF]';
    if (!completed && !failed) return `— (0 sent)${state}`;
    return `sent ${completed} completed · ${failed} failed${state}`;
  } catch (_) {
    return null;
  }
}

// SILENT-FAILURE DETECTOR (Zac 2026-08-02): a completed job that delivers ZERO
// countable visual events is invisible to every error metric — status=completed,
// no error_code — yet the user got nothing. The ONLY thing that sees it. Counts
// events across BOTH recipe shapes (standard editorial + caption-less HypePlan),
// ported from query_silent_failures_app.py. Cut by ROUTE and by USER (Rule 7 —
// one user with five silent jobs is one lost user, not five failures).
function _countEvents(rec) {
  if (!rec || typeof rec !== 'object') return null;   // unreadable
  const len = (x) => (Array.isArray(x) ? x.length : 0);
  let n = 0;
  // standard editorial shape. Match Python `cuts or clips`: an EMPTY cuts falls
  // through to clips (JS [] is truthy, Python [] is falsy — replicate Python).
  const cc = (Array.isArray(rec.cuts) && rec.cuts.length) ? rec.cuts : rec.clips;
  n += len(cc);
  for (const em of (rec.emphasis_moments || [])) {
    if (!em || typeof em !== 'object') continue;
    if (em.zoom_effect && em.zoom_effect.type) n += 1;
    if (em.motion_graphic) n += 1;
  }
  n += len(rec.motion_graphics);
  n += len(rec.caption_keywords);
  n += len(rec.transitions);
  n += len(rec.tight_cut_overlays);
  n += len(rec.text_overlays);
  n += len(rec.broll_clips);
  // caption-less shape: {route, reason, plan} where plan is a HypePlan
  const plan = rec.plan;
  if (plan && typeof plan === 'object') {
    n += len(plan.clips);
    n += len(plan.transitions);
  }
  return n;
}

// Same query shape as _lumenScoreboard: paginate completed jobs, read result,
// drop test/internal. Wrapped so a missing table / creds never breaks the digest.
// A completed job "delivered" iff at least one of the columns the CLIENT reads
// (rendered_video_url / hls_manifest_url — see SSEClient.pollJobStatus) is set.
// Both empty = the user sees a finished job with no video. Pure + exported so the
// no-delivery shape is regression-proof (Rule 1) and never silently un-seen.
function _isNoDelivery(row) {
  return !(row && (row.rendered_video_url || row.hls_manifest_url));
}

async function _silentFailureScoreboard(supabaseAdmin, { sinceISO, untilISO }) {
  try {
    const internal = await _internalIds(supabaseAdmin);
    const perRoute = {};   // route -> {done, silent}
    const perUser = {};    // user -> {done, silent}
    let unreadable = 0;
    let noDelivery = 0;                 // completed but delivery columns empty
    const noUrlUsers = new Set();
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('video_jobs')
        .select('id,status,result,user_id,rendered_video_url,hls_manifest_url')
        .eq('status', 'completed')
        .gte('created_at', sinceISO)
        .lt('created_at', untilISO)
        .order('created_at', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      const rows = data || [];
      for (const row of rows) {
        if (_isTestJob(row.id) || internal.has(row.user_id)) continue;
        const res = row.result;
        if (!res || typeof res !== 'object') continue;
        const route = res.route || 'standard';
        const uid = row.user_id || '?';
        // NO-DELIVERY: completed but the top-level columns the client reads
        // (rendered_video_url / hls_manifest_url) are BOTH empty → the user sees a
        // finished job with no video, even when result{} carries urls. A harder
        // failure than zero-events; counted independently, incl. unreadable rows.
        // (2026-08-02: the integrity_observe_only completion path wrote result{}
        // but not these columns — df2e89c0 completed yet delivered nothing.)
        if (_isNoDelivery(row)) { noDelivery++; noUrlUsers.add(uid); }
        const n = _countEvents(res.edit_recipe);
        if (n === null) { unreadable++; continue; }
        (perRoute[route] = perRoute[route] || { done: 0, silent: 0 });
        (perUser[uid] = perUser[uid] || { done: 0, silent: 0 });
        perRoute[route].done++; perUser[uid].done++;
        if (n <= 0) { perRoute[route].silent++; perUser[uid].silent++; }
      }
      if (rows.length < PAGE) break;
    }
    const totalDone = Object.values(perRoute).reduce((s, v) => s + v.done, 0);
    const totalSilent = Object.values(perRoute).reduce((s, v) => s + v.silent, 0);
    if (totalDone === 0) return null;
    const usersHit = Object.values(perUser).filter((v) => v.silent > 0).length;
    const noUrlStr = ` || ${noDelivery}/${totalDone} completions with NO VIDEO URL — client shows nothing`
      + (noDelivery ? ` (${noUrlUsers.size} user${noUrlUsers.size === 1 ? '' : 's'})` : '');
    if (totalSilent === 0 && noDelivery === 0) return `0/${totalDone} completions silent (all delivered events + urls)`;
    const routeStr = Object.entries(perRoute)
      .filter(([, v]) => v.silent > 0)
      .sort((a, b) => b[1].silent - a[1].silent)
      .map(([k, v]) => `${k} ${v.silent}/${v.done}`).join(' · ');
    return `${totalSilent}/${totalDone} completions delivered 0 EVENTS · ${usersHit} user(s)`
      + (routeStr ? ` · ${routeStr}` : '') + (unreadable ? ` · ${unreadable} unreadable` : '') + noUrlStr;
  } catch (_) {
    return null;
  }
}

function formatDigest(d, commerce, degen, languages, pushes, tiers, lumen, defects, silent) {
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
    `🔴 Errors: ${d.realErrors}${errd ? `  (${errd})` : ''}${d.inFlight ? ` · ${d.inFlight} in-flight` : ''}${d.canceled ? ` · ${d.canceled} canceled` : ''}`,
    `🌀 Degen: ${degen || '— (0 ballooned)'}`,
    `🌐 Languages: ${languages || '— (English only)'}`,
    `💸 Est. Modal: $${d.estUsd.toFixed(2)}  (${hrs.toFixed(2)}h @ $${ratePerHr.toFixed(2)}/h)`,
    `📈 Commerce: ${commerce || '— (awaiting iOS event ship)'}`,
    `🔔 Pushes: ${pushes || '— (no data)'}`,
    `⏱ Tiers: ${tiers || '— (no data)'}`,
    `🎨 Lumen: ${lumen || '— (no premium routed)'}`,
    `🔩 Defects: ${defects || '— (0 — fail-safes quiet)'}`,
    `🕳 Silent: ${silent || '— (no completions read)'}`,
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

// SPEND TRIPWIRE (Zac 2026-08-03): ~15 days from the $1500 MONTHLY Modal cap
// (resets 00:00Z on the 1st), and going offline mid-month UNWARNED is the one
// fully-predictable failure. Projects month-end spend from the run rate and
// PAGES if it would breach before month end. Estimate-based (compute-seconds ×
// rate, the SAME basis as the daily digest's estUsd) — a tripwire, not an
// invoice: it catches a run-rate spike early even if the absolute number drifts
// from Modal's billing. Override the cap with MODAL_MONTHLY_CAP_USD.
async function _spendTripwire(supabaseAdmin, { now }) {
  try {
    const CAP = Number(process.env.MODAL_MONTHLY_CAP_USD || 1500);
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const monthStart = new Date(Date.UTC(y, m, 1)).toISOString();
    const monthDigest = await computeBleedDigest(supabaseAdmin, { sinceISO: monthStart, untilISO: now.toISOString() });
    const spendSoFar = Number(monthDigest.estUsd || 0);
    const jobs = Number(monthDigest.completions || 0);
    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const daysRemaining = daysInMonth - dayOfMonth;
    const dailyRate = spendSoFar / Math.max(1, dayOfMonth);
    const projected = spendSoFar + dailyRate * daysRemaining;
    const perJob = jobs > 0 ? spendSoFar / jobs : 0;
    const daysToCap = dailyRate > 0 ? (CAP - spendSoFar) / dailyRate : Infinity;
    const breach = projected > CAP;
    let capWhen = '';
    if (breach && isFinite(daysToCap)) {
      const capDate = new Date(now.getTime() + Math.max(0, daysToCap) * 86400000);
      capWhen = ` ~${capDate.toISOString().slice(5, 10)} (${Math.max(0, Math.floor(daysToCap))}d)`;
    }
    const line = `💸 spend ~$${spendSoFar.toFixed(0)}/${CAP} this month · $${dailyRate.toFixed(0)}/day`
      + ` · $${perJob.toFixed(3)}/job (n=${jobs}) · projected month-end ~$${projected.toFixed(0)}`
      + (breach ? ` 🚨 CAP BREACH${capWhen} — rendering goes OFFLINE` : ' ✓ under cap');
    return { line, breach, projected, dailyRate, perJob };
  } catch (e) {
    return { line: `💸 spend tripwire unavailable (${e && e.message ? e.message : e})`, breach: false };
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
  const pushes = await _pushDeliveryLine(supabaseAdmin, { sinceISO, untilISO });
  const tiers = await _tierWallLine(supabaseAdmin, { sinceISO, untilISO });
  const lumen = await _lumenScoreboard(supabaseAdmin, { sinceISO, untilISO });
  const defects = await _defectScoreboard(sinceISO, untilISO);
  const silent = await _silentFailureScoreboard(supabaseAdmin, { sinceISO, untilISO });
  const spend = await _spendTripwire(supabaseAdmin, { now });
  const { title, body } = formatDigest(digest, commerce, degen, languages, pushes, tiers, lumen, defects, silent);
  // SPEND TRIPWIRE rides the daily digest: its line always shows, and a projected
  // cap breach ESCALATES the title so the page is unmissable (going offline
  // mid-month unwarned is the worst, fully-predictable failure).
  const finalBody = `${body}\n${spend.line}`;
  const finalTitle = spend.breach ? `🚨 SPEND CAP BREACH — ${title}` : title;

  console.log(`[REPORT] ${finalTitle}\n${finalBody}`);
  try {
    await sendOwnerAlert({
      ownerUserId: OWNER_USER_ID,
      title: finalTitle,
      body: finalBody,
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
  _spendTripwire,
  _countEvents,
  _isNoDelivery,
  RATE_PER_SEC,
};
