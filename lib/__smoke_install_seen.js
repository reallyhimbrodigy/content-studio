'use strict';
// SMOKE — /api/install/seen answers from BOTH sources and never invents a false.
//
// WHY BOTH BRANCHES ARE ASSERTED SEPARATELY. free_credit_grants held 5 devices
// on 2026-09-06; analytics_events held 37,407. A build that consulted only the
// grants table would answer `seen:false` for essentially every real device and
// still look green — the funnel would read ~100% first-installs, which is the
// same "tidy zero" failure that produced four bogus zeros in one day.
//
// AND WHY THE FAILURE PATHS ARE ASSERTED AT ALL. `seen:false` is the answer a
// broken lookup most naturally produces: no DB handle, a timeout, a throttled
// request. Each of those must be an ERROR, because a false negative here is
// indistinguishable downstream from a genuine new install.
const { installSeen, validDeviceId, MAX_INFLIGHT } = require('./install-seen');
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const fail = [];
const ok = (c, m) => { if (!c) fail.push(m); };
// FIXTURES SAMPLED FROM PRODUCTION, not invented. Both shapes are real and
// both are the majority of something: see the counts in install-seen.js.
const DEV = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';           // bare uuid, 44.4%
const DEV_RC = '$RCAnonymousID:0a9c140dbe224e14a7f89ca2bca66eb8'; // 55.6%

// A fake matching the supabase-js shape actually used: from().select().eq().limit()
function fakeDb({ grants = [], analytics = [], hang = null, err = null }) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(table);
      const rows = table === 'free_credit_grants' ? grants : analytics;
      const q = {
        select() { return q; },
        eq() { return q; },
        limit() {
          if (err === table) return Promise.resolve({ data: null, error: { message: 'boom' } });
          if (hang === table) return new Promise(() => {});   // never settles
          return Promise.resolve({ data: rows, error: null });
        },
      };
      return q;
    },
  };
}

(async () => {
  // ── branch 1: the grants table (PK, cheap) ───────────────────────────────
  installSeen._reset();
  let r = await installSeen(DEV, fakeDb({ grants: [{ device_id: DEV }] }));
  ok(r.status === 200 && r.body.seen === true && r.body.source === 'grant',
     'a device present in free_credit_grants is not reported seen');

  // ── branch 2: analytics fallback — the branch that carries the volume ────
  installSeen._reset();
  const db2 = fakeDb({ grants: [], analytics: [{ anon_user_id: DEV }] });
  r = await installSeen(DEV, db2);
  ok(r.status === 200 && r.body.seen === true && r.body.source === 'analytics',
     'a device present ONLY in analytics_events is not reported seen — the '
     + 'endpoint would call 37,407 known devices first-installs');
  ok(db2.calls.includes('analytics_events'),
     'analytics_events was never queried');

  // ── a genuinely unknown device: the ONLY legitimate false ────────────────
  installSeen._reset();
  r = await installSeen(DEV, fakeDb({ grants: [], analytics: [] }));
  ok(r.status === 200 && r.body.seen === false,
     'an unknown device is not reported unseen');

  // ── ordering: grants first, so the cheap index hit short-circuits ────────
  installSeen._reset();
  const db3 = fakeDb({ grants: [{ device_id: DEV }], analytics: [] });
  await installSeen(DEV, db3);
  ok(!db3.calls.includes('analytics_events'),
     'a grants hit still ran the UNINDEXED analytics scan (5.3s measured) — '
     + 'the cheap source must short-circuit');

  // ── NEVER A FABRICATED FALSE ─────────────────────────────────────────────
  installSeen._reset();
  r = await installSeen(DEV, null);
  ok(r.status === 503 && r.body.seen === undefined,
     'a MISSING DB HANDLE answers seen:false — a config defect rendered as a '
     + 'clean negative');

  installSeen._reset();
  r = await installSeen(DEV, fakeDb({ err: 'analytics_events' }));
  ok(r.status === 503 && r.body.seen === undefined,
     'a QUERY ERROR answers seen:false instead of failing loudly');

  installSeen._reset();
  r = await installSeen(DEV, fakeDb({ err: 'free_credit_grants' }));
  ok(r.status === 503 && r.body.seen === undefined,
     'a GRANTS query error answers seen:false');

  // ── the throttle, driven to its cap ──────────────────────────────────────
  // Without this the DoS bound is a comment, not a behaviour.
  installSeen._reset();
  const hanging = fakeDb({ grants: [], hang: 'analytics_events' });
  const held = [];
  for (let i = 0; i < MAX_INFLIGHT; i++) held.push(installSeen(DEV + i, hanging));
  await new Promise((r2) => setImmediate(r2));
  ok(installSeen._state().inflight === MAX_INFLIGHT,
     'in-flight analytics lookups are not counted — the cap cannot bind');
  const over = await installSeen(DEV + 'X', hanging);
  ok(over.status === 503 && over.body.error === 'lookup_busy'
     && over.body.seen === undefined,
     'past the concurrency cap the endpoint does NOT shed load — an '
     + 'unauthenticated caller could exhaust the DB pool with 5.3s scans');
  ok(over.retryAfter > 0, 'a shed request carries no Retry-After');

  // ── device-id shape bound ────────────────────────────────────────────────
  ok(validDeviceId(DEV) === true, 'a bare-uuid device id is rejected');
  // The regression that shipped and was caught only by querying production:
  // this shape is 55.6% of all devices and the original bound rejected it.
  ok(validDeviceId(DEV_RC) === true,
     'the $RCAnonymousID device id is rejected — 20,782 of 37,410 real devices '
     + '(55.6%) would 400 on the endpoint');
  installSeen._reset();
  {
    const r2 = await installSeen(DEV_RC, fakeDb({ grants: [], analytics: [{ anon_user_id: DEV_RC }] }));
    ok(r2.status === 200 && r2.body.seen === true,
       'an $RCAnonymousID device is not resolved end-to-end');
  }
  ok(validDeviceId('x') === false, 'a too-short device id is accepted');
  ok(validDeviceId('a'.repeat(129)) === false,
     'an over-long device id is accepted — unbounded text reaches the query');
  ok(validDeviceId("a' or 1=1--") === false,
     'a device id with quote/space characters is accepted');
  installSeen._reset();
  r = await installSeen('', fakeDb({}));
  ok(r.status === 400, 'an empty device_id is not a 400');

  // ── the route exists and is unauthenticated ──────────────────────────────
  ok(/pathname === '\/api\/install\/seen' && req\.method === 'GET'/.test(SRC),
     'the /api/install/seen route is not wired in server.js');
  const ri = SRC.indexOf("'/api/install/seen'");
  const seg = SRC.slice(ri, ri + 700);
  ok(!/requireAuth|authUser|getUser\(/.test(seg),
     'the route requires auth — it is asked BEFORE signup by design');
  ok(/parsed\.query/.test(seg),
     'the route reads searchParams, but `parsed` is url.parse(req.url, true) — '
     + 'device_id would always be undefined');

  if (fail.length) {
    console.error('FAIL __smoke_install_seen:');
    for (const f of fail) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('ok __smoke_install_seen — both sources, grants short-circuits, '
    + '4 failure paths never fabricate a false, throttle binds at cap, route unauthenticated');
})();
