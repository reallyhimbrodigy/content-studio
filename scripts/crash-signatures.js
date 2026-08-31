#!/usr/bin/env node
'use strict';
// CRASH SIGNATURES, RANKED BY DISTINCT AFFECTED USERS (Rule 7).
//
// WHY THIS EXISTS AT ALL: this read has been requested repeatedly and performed
// by hand every time, which is how it stayed wrong. Ranking by event count
// inflates every signature by its retry multiplier — one user who relaunches
// into the same crash five times reads as five failures. That is precisely the
// arithmetic that once turned a one-user bug into a "67% outage". So the
// headline number here is DISTINCT USERS, always, and event count is a
// secondary column.
//
// THE DARK WINDOW IS NOT A ZERO. Sentry accepted nothing from 2026-08-15 to
// 2026-08-28 (quota rate-limited). Builds 226-235 shipped entirely inside that
// window. They will report zero crashes forever, and that zero is a FAILED
// READ, not a clean build. This script marks those builds NO-DATA explicitly
// rather than letting a reader mistake silence for health — the single most
// likely misreading of this table.
//
// IT VERIFIES THE PIPE BEFORE IT REPORTS. An empty issue list and a broken
// token produce identical output. So the ingestion check runs FIRST and an
// empty result is only ever printed as a zero once the pipe is proven live.
//
// IT VERIFIES THE FIELD BEFORE SPLITTING ON IT. Every by-build number depends
// on the release tag actually being populated. If most events carry no release,
// the split is being computed on a sparse field and every per-build rate is
// wrong — the same defect that put every by-language metric on a 20% mirror
// column. So there is a positive control, and it refuses the split if it fails.
//
// Usage:  node scripts/crash-signatures.js [--since-build 229] [--days 90]
// Exit 0 = read succeeded (even if zero crashes). Exit 2 = could not read,
// which is NOT the same as healthy and must never be reported as one.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const ORG = 'promptly-s9';
const PROJECT = 'promptly-ios';
const PROJECT_ID = '4511288247320576';

// The quota outage. Anything whose whole life sits in here has no crash data
// and never will — events rate-limited at the edge were never stored.
const DARK_START = Date.parse('2026-08-15T00:00:00Z');
const DARK_END = Date.parse('2026-08-28T00:00:00Z');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const SINCE_BUILD = parseInt(argOf('--since-build', '229'), 10);
// The issues endpoint accepts ONLY '', '24h' and '14d' for statsPeriod — it
// rejects anything else with a 400. Asking for 90d silently becomes an error,
// not a wider window, so the choice is clamped here and the clamp is announced.
// 14d is not a limitation in practice right now: ingestion was dead until
// 2026-08-28, so 14d already covers every event that exists post-outage.
const ALLOWED_PERIODS = ['24h', '14d'];
const RAW_PERIOD = argOf('--period', '14d');
const PERIOD = ALLOWED_PERIODS.includes(RAW_PERIOD) ? RAW_PERIOD : '14d';

function sentryToken() {
  const p = path.join(os.homedir(), '.sentryclirc');
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, 'utf8').match(/^\s*token\s*=\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

function getJSON(pathname, token) {
  return new Promise((resolve) => {
    https.get({ host: 'sentry.io', path: pathname, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }); }
        catch { resolve({ status: res.statusCode, body: null, raw: d.slice(0, 300) }); }
      });
    }).on('error', (e) => resolve({ status: 0, body: null, error: e.message }));
  });
}

// iOS release strings arrive in several shapes depending on how the dSYM was
// uploaded: "1.3.23+241", "1.3.23 (241)", "com.bundle.id@1.3.23+241". Parse the
// build out of any of them, and return null rather than a guess when none match
// — an unparsed release must not silently collapse into a bucket with real
// builds and dilute its numbers.
function parseBuild(release) {
  if (!release || typeof release !== 'string') return null;
  let m = release.match(/[+(](\d{2,5})\)?\s*$/);
  if (m) return parseInt(m[1], 10);
  m = release.match(/\b(\d+\.\d+\.\d+)[^\d]+(\d{2,5})\b/);
  if (m) return parseInt(m[2], 10);
  return null;
}
function parseVersion(release) {
  const m = (release || '').match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

(async () => {
  const token = sentryToken();
  if (!token) {
    console.error('crash-signatures: CANNOT READ — no token in ~/.sentryclirc. NOT a clean result.');
    process.exit(2);
  }

  // ── 0. PROVE THE PIPE IS LIVE before any zero can be believed ────────────
  const qs = new URLSearchParams({
    field: 'sum(quantity)', category: 'error', groupBy: 'outcome',
    statsPeriod: '24h', interval: '1h', project: PROJECT_ID,
  });
  const pipe = await getJSON(`/api/0/organizations/${ORG}/stats_v2/?${qs}`, token);
  if (pipe.status !== 200 || !pipe.body || !Array.isArray(pipe.body.intervals)) {
    console.error(`crash-signatures: CANNOT READ — stats_v2 HTTP ${pipe.status}. NOT a clean result.`);
    if (pipe.body && pipe.body.detail) console.error(`  detail: ${pipe.body.detail}`);
    process.exit(2);
  }
  let accepted24 = 0;
  for (const g of pipe.body.groups || []) {
    if (g.by.outcome === 'accepted') accepted24 = (g.series['sum(quantity)'] || []).reduce((a, b) => a + b, 0);
  }
  console.log(`crash-signatures: pipe check — ${accepted24} events accepted in the last 24h`);
  if (accepted24 === 0) {
    console.log('  NOTE: nothing accepted in 24h. Any empty result below is UNPROVEN, not a zero.');
  }

  // ── 1. Issues, ranked by users ───────────────────────────────────────────
  const iq = new URLSearchParams({
    query: 'is:unresolved', statsPeriod: PERIOD, sort: 'user', limit: '100',
  });
  const r = await getJSON(`/api/0/projects/${ORG}/${PROJECT}/issues/?${iq}`, token);
  if (r.status !== 200 || !Array.isArray(r.body)) {
    console.error(`crash-signatures: CANNOT READ — issues HTTP ${r.status}. NOT a clean result.`);
    if (r.body && r.body.detail) console.error(`  detail: ${r.body.detail}`);
    process.exit(2);
  }
  const issues = r.body;
  console.log(`crash-signatures: ${issues.length} unresolved issues in the last ${PERIOD}` + (RAW_PERIOD !== PERIOD ? ` (clamped from ${RAW_PERIOD} — the API rejects anything but 24h/14d)` : '') + '\n');

  if (!issues.length) {
    console.log(accepted24 > 0
      ? 'ZERO unresolved crash signatures, out of a pipe proven live in the last 24h. This is a real zero.'
      : 'Empty issue list AND a pipe with no accepted events — this is a FAILED READ, not a zero.');
    process.exit(0);
  }

  // ── 2. POSITIVE CONTROL on the release tag ───────────────────────────────
  // Every by-build number below depends on this field. If it is sparse, the
  // split is being computed on a mirror of the truth and must not be printed.
  let tagged = 0, untagged = 0;
  const sample = issues.slice(0, 25);
  const releaseByIssue = new Map();
  for (const iss of sample) {
    const t = await getJSON(`/api/0/organizations/${ORG}/issues/${iss.id}/tags/release/values/`, token);
    const vals = Array.isArray(t.body) ? t.body : [];
    if (vals.length) { tagged++; releaseByIssue.set(iss.id, vals); } else { untagged++; }
  }
  const coverage = tagged + untagged ? tagged / (tagged + untagged) : 0;
  console.log(`release-tag control: ${tagged}/${tagged + untagged} sampled issues carry a release tag (${(coverage * 100).toFixed(0)}%)`);
  if (coverage < 0.5) {
    console.log('  REFUSING the by-build split — the release tag is sparse, so every per-build');
    console.log('  number would be computed on a field most events do not carry.\n');
  }

  // ── 3. Rank by DISTINCT USERS, with the top-user share (Rule 7) ──────────
  console.log('\n=== SIGNATURES, ranked by DISTINCT AFFECTED USERS ===');
  console.log('users  events  ratio  top-user%  builds                signature');
  const rows = [];
  for (const iss of issues.slice(0, 25)) {
    const users = iss.userCount || 0;
    const events = parseInt(iss.count, 10) || 0;
    if (users === 0 && events === 0) continue;

    // Top-user share: before calling anything systemic, check whether one user
    // is most of it. A class dominated by a single user is that user's device
    // or their input, not an outage.
    let topShare = null;
    const ut = await getJSON(`/api/0/organizations/${ORG}/issues/${iss.id}/tags/user/values/?limit=5`, token);
    if (Array.isArray(ut.body) && ut.body.length) {
      const top = ut.body[0];
      if (top && typeof top.count === 'number' && events > 0) topShare = top.count / events;
    }

    const rels = releaseByIssue.get(iss.id) || [];
    const builds = [...new Set(rels.map((v) => parseBuild(v.value)).filter((b) => b !== null))].sort((a, b) => a - b);
    const inScope = builds.filter((b) => b >= SINCE_BUILD);

    rows.push({ iss, users, events, topShare, builds, inScope });
  }

  rows.sort((a, b) => b.users - a.users || b.events - a.events);
  for (const row of rows) {
    const title = (row.iss.title || row.iss.culprit || '(untitled)').replace(/\s+/g, ' ').slice(0, 58);
    const ratio = row.users > 0 ? (row.events / row.users).toFixed(1) : '—';
    const share = row.topShare === null ? '  ?  ' : `${(row.topShare * 100).toFixed(0)}%`.padStart(5);
    const bstr = (row.inScope.length ? row.inScope.join(',') : (row.builds.length ? `(all <${SINCE_BUILD})` : 'untagged')).slice(0, 20);
    console.log(
      `${String(row.users).padStart(5)}  ${String(row.events).padStart(6)}  ${ratio.padStart(5)}  ${share}      ${bstr.padEnd(20)}  ${title}`
    );
  }

  // ── 4. Rule 7 verdict, stated rather than left to the reader ─────────────
  console.log('\n=== RULE 7 READ ===');
  const concentrated = rows.filter((r2) => r2.topShare !== null && r2.topShare >= 0.5);
  const spread = rows.filter((r2) => r2.users >= 5 && (r2.topShare === null || r2.topShare < 0.5));
  console.log(`${rows.length} signatures. ${concentrated.length} are ≥50% one user — per-user, NOT systemic.`);
  if (spread.length) {
    console.log(`${spread.length} affect 5+ distinct users with no dominant user — these are the real candidates:`);
    for (const s of spread.slice(0, 5)) {
      console.log(`   ${String(s.users).padStart(4)} users  ${(s.iss.title || '').replace(/\s+/g, ' ').slice(0, 60)}`);
    }
  } else {
    console.log('NO signature affects 5+ distinct users without one user dominating it.');
  }
  const retryHeavy = rows.filter((r2) => r2.users > 0 && r2.events / r2.users >= 4);
  if (retryHeavy.length) {
    console.log(`\n${retryHeavy.length} signatures have a ≥4x event/user ratio — these are exactly the classes`);
    console.log('that per-job counting would have inflated. Ranked by events they would lead this table.');
  }

  // ── 5. The dark window, stated as absence not as health ──────────────────
  console.log('\n=== BUILD COVERAGE ===');
  const seen = new Set();
  for (const row of rows) for (const b of row.builds) seen.add(b);
  const darkBuilds = [];
  for (let b = 226; b <= 235; b++) if (!seen.has(b)) darkBuilds.push(b);
  if (darkBuilds.length) {
    console.log(`builds ${darkBuilds[0]}-${darkBuilds[darkBuilds.length - 1]}: NO DATA — shipped inside the`);
    console.log(`  ${new Date(DARK_START).toISOString().slice(0, 10)} → ${new Date(DARK_END).toISOString().slice(0, 10)} rate-limit outage.`);
    console.log('  Their zero is a failed read. Do NOT report them as crash-free.');
  }
  const live = [...seen].filter((b) => b >= SINCE_BUILD).sort((a, b) => a - b);
  console.log(`builds with real crash data ≥${SINCE_BUILD}: ${live.length ? live.join(', ') : 'NONE YET'}`);
  if (!live.length) {
    console.log('  Ingestion resumed only recently — post-outage builds have thin coverage.');
    console.log('  Treat an empty per-build row as "not yet observed", not as "clean".');
  }
  process.exit(0);
})();
