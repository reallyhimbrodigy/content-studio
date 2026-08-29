#!/usr/bin/env node
'use strict';
// SENTRY DEAD-PIPE CHECK (2026-08-28).
//
// WHY: crash reporting was dark for TWO WEEKS and nothing said so. Sentry
// accepted its last event on 2026-08-15; every event since has been
// rate-limited away. Ten consecutive builds shipped with no crash visibility,
// and the only reason it surfaced was someone asking for a signature list and
// noticing every result topped out at build 224.
//
// The trap this exists to break: "zero crashes" and "crash reporting is broken"
// produce the IDENTICAL reading — an empty issue list. Silence is
// indistinguishable from health unless you check the pipe itself. So this does
// not ask "are there crashes?"; it asks "is the pipe carrying anything, and if
// not, is the app actually being used?" Those two together are what make a zero
// interpretable.
//
// FAILS when Sentry has accepted nothing for over a day WHILE our own analytics
// show live sessions. Either condition alone is unremarkable — an app with no
// users legitimately sends no crashes.
//
// Also names the CAUSE rather than reporting a bare zero: rate_limited (quota
// exhausted), filtered (inbound filters), invalid (malformed/bad DSN) and
// dropped are different failures with different fixes, and a bare "no data"
// would send the next person hunting in the wrong place.
//
// Usage:  node scripts/sentry-pipe-health.js
// Needs:  ~/.sentryclirc  (auth token)  and  .env.local  (SUPABASE_*)
// Exit 0 = pipe healthy or legitimately idle. Exit 1 = dead pipe. Exit 2 = the
// check itself could not read, which is NOT the same as healthy.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const ORG = 'promptly-s9';
const PROJECT = 'promptly-ios';
const PROJECT_ID = '4511288247320576';
const STALE_HOURS = 24;

function sentryToken() {
  const p = path.join(os.homedir(), '.sentryclirc');
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, 'utf8').match(/^\s*token\s*=\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

function getJSON(host, pathname, headers) {
  return new Promise((resolve) => {
    https.get({ host, path: pathname, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d || '{}'), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: null, raw: d.slice(0, 300) }); }
      });
    }).on('error', (e) => resolve({ status: 0, body: null, error: e.message }));
  });
}

function loadEnvLocal() {
  const p = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

(async () => {
  const token = sentryToken();
  if (!token) {
    console.error('sentry-pipe: CANNOT READ — no token in ~/.sentryclirc. Not a pass.');
    process.exit(2);
  }

  // ── 1. Sentry outcomes by day ────────────────────────────────────────────
  const qs = new URLSearchParams({
    field: 'sum(quantity)', category: 'error', groupBy: 'outcome',
    statsPeriod: '30d', interval: '1d', project: PROJECT_ID,
  });
  const r = await getJSON('sentry.io', `/api/0/organizations/${ORG}/stats_v2/?${qs}`,
                          { Authorization: `Bearer ${token}` });
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.intervals)) {
    console.error(`sentry-pipe: CANNOT READ — stats_v2 HTTP ${r.status}. Not a pass.`);
    process.exit(2);
  }
  const intervals = r.body.intervals;
  const byOutcome = {};
  for (const g of r.body.groups || []) {
    byOutcome[g.by.outcome] = g.series['sum(quantity)'] || [];
  }
  if (!Object.keys(byOutcome).length) {
    console.error('sentry-pipe: CANNOT READ — zero outcome groups returned. An empty parse is a failed read.');
    process.exit(2);
  }

  const lastNonZero = (series) => {
    for (let i = series.length - 1; i >= 0; i--) if (series[i] > 0) return intervals[i];
    return null;
  };
  const accepted = byOutcome.accepted || [];
  const lastAccepted = lastNonZero(accepted);
  let hoursSince = lastAccepted
    ? (Date.now() - new Date(lastAccepted).getTime()) / 36e5
    : Infinity;

  const totals = {};
  for (const [k, s] of Object.entries(byOutcome)) totals[k] = s.reduce((a, b) => a + b, 0);

  console.log('sentry-pipe: 30d outcome totals');
  for (const [k, v] of Object.entries(totals)) {
    const ln = lastNonZero(byOutcome[k]);
    console.log(`   ${k.padEnd(16)} ${String(v).padStart(8)}   last non-zero: ${ln ? ln.slice(0, 10) : 'never'}`);
  }
  console.log(`   -> hours since Sentry last ACCEPTED an event: ${hoursSince === Infinity ? 'never in window' : hoursSince.toFixed(1)}`);

  // ACCEPTANCE RATIO, not mere presence.
  //
  // Caught by this check's own first run (2026-08-28): exactly ONE event was
  // accepted in 24h while 58 were refused in the same window, and "hours since
  // last accepted" duly dropped to 16 — so a rule of "at least one accepted
  // event" reported a healthy pipe while 98% of traffic was still being thrown
  // away. A trickle through a closed gate is not an open gate. Health is the
  // SHARE that gets through, which is also what makes recovery unambiguous:
  // when the quota genuinely frees, acceptance goes to ~100%, not to one.
  // Fetch a real 24h window. The series above is DAILY over 30 days, so
  // slicing 24 elements off it would measure 24 DAYS — which is exactly the
  // mistake that first made this ratio read 29% instead of 2%.
  const qs24 = new URLSearchParams({
    field: 'sum(quantity)', category: 'error', groupBy: 'outcome',
    statsPeriod: '24h', interval: '1h', project: PROJECT_ID,
  });
  const r24 = await getJSON('sentry.io', `/api/0/organizations/${ORG}/stats_v2/?${qs24}`,
                            { Authorization: `Bearer ${token}` });
  const day = {};
  for (const g of (r24.body && r24.body.groups) || []) {
    day[g.by.outcome] = (g.series['sum(quantity)'] || []).reduce((a, b) => a + b, 0);
  }
  const acc24 = day.accepted || 0;
  const rl24 = day.rate_limited || 0;
  const ratio = (acc24 + rl24) > 0 ? acc24 / (acc24 + rl24) : 1;
  console.log(`   -> last 24h: accepted=${acc24} rate_limited=${rl24} acceptance=${(ratio * 100).toFixed(1)}%`);

  if (hoursSince <= STALE_HOURS && ratio >= 0.5) {
    console.log(`sentry-pipe: PASS — events accepted within the last ${STALE_HOURS}h ` +
                `(${(ratio * 100).toFixed(0)}% acceptance).`);
    process.exit(0);
  }
  // Refine "hours since accepted" from the HOURLY series. The 30d series is
  // daily, so it can only ever say "sometime today" — which printed as
  // "accepted NOTHING for 19h" on a day that had already accepted 7 events.
  // A number that contradicts the line above it teaches the reader to trust
  // neither.
  const accHourly = (r24.body && r24.body.groups || [])
    .find((g) => g.by.outcome === 'accepted');
  const ivH = (r24.body && r24.body.intervals) || [];
  if (accHourly && ivH.length) {
    const ser = accHourly.series['sum(quantity)'] || [];
    for (let i = ser.length - 1; i >= 0; i--) {
      if (ser[i] > 0) {
        hoursSince = (Date.now() - new Date(ivH[i]).getTime()) / 36e5;
        break;
      }
    }
    console.log(`   -> refined from hourly data: ${hoursSince.toFixed(1)}h since an accepted event`);
  }

  if (acc24 > 0) {
    console.log(`   -> ${acc24} event(s) DID get through, but only ${acc24} of ${acc24 + rl24}.`);
    console.log('      Treating that as dark: a trickle through a closed gate is not an open gate.');
  }

  // ── 2. Is the app actually being used? A quiet app is not a dead pipe. ────
  const env = loadEnvLocal();
  const supaUrl = env.SUPABASE_URL;
  const supaKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !supaKey) {
    console.error('sentry-pipe: CANNOT CONFIRM — Sentry looks stale but SUPABASE creds are missing,');
    console.error('  so "is anyone using the app?" is unanswerable. Not a pass.');
    process.exit(2);
  }
  const host = supaUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const since = new Date(Date.now() - STALE_HOURS * 36e5).toISOString();
  const sr = await getJSON(host,
    `/rest/v1/analytics_events?select=id&created_at=gte.${encodeURIComponent(since)}&limit=1`,
    { apikey: supaKey, Authorization: `Bearer ${supaKey}`, Prefer: 'count=exact' });
  const range = (sr.headers && sr.headers['content-range']) || '';
  const liveEvents = Number((range.split('/')[1] || '0')) || 0;
  console.log(`   -> our own analytics events in the last ${STALE_HOURS}h: ${liveEvents}`);

  if (liveEvents === 0) {
    console.log('sentry-pipe: PASS (idle) — no crashes accepted, but no app activity either.');
    console.log('  A silent pipe over a silent app is not evidence of a broken pipe.');
    process.exit(0);
  }

  // ── 3. Dead pipe. Name the cause. ────────────────────────────────────────
  const suspects = Object.entries(totals)
    .filter(([k, v]) => k !== 'accepted' && v > 0)
    .sort((a, b) => b[1] - a[1]);
  console.error('');
  console.error('sentry-pipe: FAILED — DEAD PIPE.');
  console.error(`  Sentry has accepted NOTHING for ${hoursSince.toFixed(0)}h while the app served`);
  console.error(`  ${liveEvents} analytics events in the last ${STALE_HOURS}h. Crash reporting is dark.`);
  if (suspects.length) {
    const [cause, n] = suspects[0];
    console.error(`  Dominant non-accepted outcome: ${cause} (${n} in 30d).`);
    if (cause === 'rate_limited') {
      console.error('  -> Events are reaching Sentry and being REFUSED.');
      // Name WHICH refusal. "rate_limited" spans three different problems with
      // three different owners, and the 2026-08-15 outage was the third one --
      // which the first two diagnoses would have missed entirely.
      const kr = await getJSON('sentry.io', `/api/0/projects/${ORG}/${PROJECT}/keys/`,
                               { Authorization: `Bearer ${token}` });
      const keyLimited = (kr.body || []).filter((k) => k.rateLimit);
      if (keyLimited.length) {
        console.error(`     CAUSE: a DSN-level rate limit on client key '${keyLimited[0].name}':`);
        console.error(`     ${JSON.stringify(keyLimited[0].rateLimit)}. Raise or remove it in project settings.`);
      } else {
        const cr = await getJSON('sentry.io', `/api/0/customers/${ORG}/`,
                                 { Authorization: `Bearer ${token}` });
        const errs = ((cr.body || {}).categories || {}).errors || {};
        console.error(`     Not a key-level limit (no client key carries one).`);
        console.error(`     errors quota: reserved=${errs.reserved} usage=${errs.usage} ` +
                      `usageExceeded=${errs.usageExceeded} onDemandBudget=${errs.onDemandBudget}`);
        // NOTE (corrected 2026-08-28): do NOT read errs.onDemandBudget === 0 as
        // "no allocation". Under budgetMode "shared" EVERY category reports 0,
        // including categories with zero usage — the shared pool is what
        // applies. Reading that field as a per-category allocation produced a
        // confident, wrong diagnosis once already.
        const od = (cr.body || {}).onDemandBudgets || {};
        console.error(`     on-demand: mode=${od.budgetMode} enabled=${od.enabled} ` +
                      `max=${od.sharedMaxBudget ?? (cr.body || {}).onDemandMaxSpend} used=${od.onDemandSpendUsed}`);
        if (od.enabled && Number(errs.usage) < Number(errs.reserved) && errs.usageExceeded === false) {
          console.error('     CONTRADICTION: Sentry is refusing with a usage-exceeded reason while its');
          console.error('     own quota readout says usage is UNDER the reserve and not exceeded.');
          console.error('     Nothing in the account explains the refusal — this needs the Sentry');
          console.error('     dashboard or support, not a config change on our side. If the billing');
          console.error('     period reset recently, enforcement may simply lag; re-check before escalating.');
        } else if (!od.enabled) {
          console.error('     CAUSE: on-demand/pay-as-you-go is DISABLED, so a spent reserve has no');
          console.error('     overflow. Owner action: enable it.');
        } else {
          console.error('     CAUSE: reserved quota spent and on-demand did not absorb it.');
        }
      }
    } else if (cause === 'filtered') {
      console.error('  -> Inbound filters are discarding events. Check project filter settings.');
    } else if (cause === 'invalid') {
      console.error('  -> Events are malformed or the DSN/key is wrong.');
    }
  } else {
    console.error('  Nothing is arriving at all -> the SDK is not initialising, or the DSN is absent');
    console.error('  from the shipped Info.plist. Check SENTRY_DSN in the build.');
  }
  process.exit(1);
})();
