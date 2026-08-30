'use strict';
// CANONICAL JOINED READ — funnel wall-views joined to purchase outcomes.
//
// CORRECTION TO THE BRIEF, stated up front because it changes the join:
// `rc_webhook_received` is NOT a table. It is an EVENT NAME inside
// analytics_events, written by server.js:4735 with platform='server'. So both
// sides of this join live in one table and the "shared UUID" is the auth user
// id — but the webhook rows carry user_id=NULL and territory=NULL, so the UUID
// has to come out of props (app_user_id / aliases) and the territory can only
// come from the client-side events.
//
// SECOND CORRECTION: rc_webhook_received carries NO price. Revenue exists only
// on the client's purchase_completed (props.price + props.currency). So
// purchases/view is server-authoritative and revenue/view is not — they are
// computed from different sources and reported as such rather than blended.
// Read creds without dotenv (this script runs outside any node_modules).
const fs = require('fs');
for (const l of fs.readFileSync(process.env.PROMPTLY_ENV_FILE || '/Users/zaclibman/content-studio/.env.local','utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'').trim();
}
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: key, Authorization: `Bearer ${key}` };

// Frozen P0 baseline, per the standing ruling.
const P0_PURCH_PER_VIEW = 0.00350;
const P0_REV_PER_VIEW = 0.01609;

// Approximate USD rates. STATED, not hidden: no FX source exists in the repo,
// so a single blended USD figure is an ESTIMATE and is labelled as one. The
// purchases/view line below needs no FX and is exact.
const FX = {
  USD: 1, GBP: 1.27, EUR: 1.08, BRL: 0.18, INR: 0.0120, IDR: 0.000062,
  PHP: 0.0175, MXN: 0.050, CAD: 0.73, AUD: 0.65, JPY: 0.0064, ZAR: 0.055,
  NGN: 0.00065, PKR: 0.0036, BDT: 0.0084, VND: 0.000039, TRY: 0.029,
  EGP: 0.021, KES: 0.0077, COP: 0.00024, ARS: 0.0010, CLP: 0.0011,
  PEN: 0.27, THB: 0.029, MYR: 0.22, SGD: 0.74, AED: 0.27, SAR: 0.27,
  PLN: 0.25, RUB: 0.011, UAH: 0.024, NZD: 0.60, CHF: 1.12, SEK: 0.095,
  NOK: 0.093, DKK: 0.145, HUF: 0.0028, CZK: 0.043, RON: 0.22, ILS: 0.27,
  KRW: 0.00072, TWD: 0.031, HKD: 0.128, NPR: 0.0075, LKR: 0.0034,
};

async function page(path) {
  let all = [], from = 0;
  for (;;) {
    const r = await fetch(`${url}/rest/v1/${path}&limit=1000&offset=${from}`, { headers: H });
    if (!r.ok) { console.error('READ FAILED', r.status, path.slice(0, 80)); process.exit(1); }
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) break;
    all.push(...j); from += j.length;
    if (j.length < 1000) break;
  }
  return all;
}

(async () => {
  const SINCE = process.argv[2] || '2026-08-29T17:36:00Z';   // frozen arming boundary
  const q = `created_at=gte.${SINCE}`;
  console.log(`READ BOUNDARY: ${SINCE}  (frozen funnel-arming timestamp)\n`);

  const views = await page(`analytics_events?select=created_at,user_id,territory,app_version,props&event=eq.upgrade_wall_viewed&${q}&order=created_at.asc`);
  const purch = await page(`analytics_events?select=created_at,user_id,territory,app_version,props&event=eq.purchase_completed&${q}&order=created_at.asc`);
  const hooks = await page(`analytics_events?select=created_at,props&event=eq.rc_webhook_received&${q}&order=created_at.asc`);

  console.log(`wall views            : ${views.length}`);
  console.log(`purchase_completed    : ${purch.length}  (client, has price)`);
  console.log(`rc_webhook_received   : ${hooks.length}  (server, no price)\n`);

  // ── THE $RCAnonymousID QUESTION ────────────────────────────────────────────
  // A webhook whose original_app_user_id is anonymous is only joinable if the
  // alias chain also carries the auth UUID. Measure that directly rather than
  // assuming either way.
  const isAnon = (s) => typeof s === 'string' && s.startsWith('$RCAnonymousID:');
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let anonOriginal = 0, anonResolved = 0, anonUnresolved = 0, directUuid = 0;
  const hookUsers = new Map();          // resolved auth uuid -> [rc_type,…]
  for (const h of hooks) {
    const p = h.props || {};
    const aliases = Array.isArray(p.aliases) ? p.aliases : [];
    const resolved = [p.app_user_id, ...aliases].find((a) => uuidRe.test(String(a || '')));
    if (isAnon(p.original_app_user_id)) {
      anonOriginal++;
      if (resolved) anonResolved++; else anonUnresolved++;
    } else if (uuidRe.test(String(p.original_app_user_id || ''))) directUuid++;
    if (resolved) {
      if (!hookUsers.has(resolved)) hookUsers.set(resolved, []);
      hookUsers.get(resolved).push(p.rc_type);
    }
  }
  console.log('── $RCAnonymousID coverage ──');
  console.log(`  webhooks with an ANONYMOUS original_app_user_id : ${anonOriginal}`);
  console.log(`     of those, RESOLVED to an auth UUID via alias : ${anonResolved}`);
  console.log(`     of those, still UNRESOLVABLE                 : ${anonUnresolved}`);
  console.log(`  webhooks already keyed on a real UUID           : ${directUuid}`);
  console.log(`  distinct auth users reachable from webhooks     : ${hookUsers.size}\n`);

  // ── Per-surface and per-territory ─────────────────────────────────────────
  const bySurface = new Map(), byTerr = new Map();
  const bump = (m, k) => { if (!m.has(k)) m.set(k, { views: 0, purch: 0, usd: 0, local: new Map() }); return m.get(k); };
  for (const v of views) {
    bump(bySurface, (v.props && v.props.context) || 'unknown').views++;
    bump(byTerr, v.territory || 'unknown').views++;
  }
  // Attribute a purchase to the surface of that user's LAST wall view before it —
  // the surface that actually preceded the buy, not an arbitrary one.
  const viewsByUser = new Map();
  for (const v of views) {
    if (!v.user_id) continue;
    if (!viewsByUser.has(v.user_id)) viewsByUser.set(v.user_id, []);
    viewsByUser.get(v.user_id).push(v);
  }
  let unattributed = 0;
  for (const p of purch) {
    const price = Number((p.props && p.props.price) || 0);
    const cur = (p.props && p.props.currency) || 'USD';
    const rate = FX[cur];
    const usd = rate === undefined ? null : price * rate;
    const t = bump(byTerr, p.territory || 'unknown');
    t.purch++; if (usd !== null) t.usd += usd;
    t.local.set(cur, (t.local.get(cur) || 0) + price);

    const prior = (viewsByUser.get(p.user_id) || []).filter((v) => v.created_at <= p.created_at);
    const surface = prior.length ? (prior[prior.length - 1].props || {}).context || 'unknown' : null;
    if (surface) {
      const s = bump(bySurface, surface);
      s.purch++; if (usd !== null) s.usd += usd;
    } else unattributed++;
    if (rate === undefined) console.log(`  !! no FX rate for ${cur} — excluded from the USD total`);
  }

  const line = (name, d) => {
    const ppv = d.views ? d.purch / d.views : 0;
    const rpv = d.views ? d.usd / d.views : 0;
    const dp = P0_PURCH_PER_VIEW ? ((ppv / P0_PURCH_PER_VIEW - 1) * 100) : 0;
    const dr = P0_REV_PER_VIEW ? ((rpv / P0_REV_PER_VIEW - 1) * 100) : 0;
    return `  ${name.padEnd(16)} views ${String(d.views).padStart(6)}  buys ${String(d.purch).padStart(3)}` +
           `  p/v ${ppv.toFixed(5)} (${dp >= 0 ? '+' : ''}${dp.toFixed(0)}%)` +
           `  $/v ${rpv.toFixed(5)} (${dr >= 0 ? '+' : ''}${dr.toFixed(0)}%)`;
  };

  const tot = { views: views.length, purch: 0, usd: 0 };
  for (const d of byTerr.values()) { tot.purch += d.purch; tot.usd += d.usd; }
  console.log('── TOTAL vs frozen P0 (0.00350 p/v, $0.01609 $/v) ──');
  console.log(line('ALL', tot));
  if (unattributed) console.log(`  (${unattributed} purchase(s) had no preceding wall view — not attributed to a surface)`);

  console.log('\n── BY SURFACE (wall context) ──');
  for (const [k, d] of [...bySurface].sort((a, b) => b[1].views - a[1].views)) console.log(line(k, d));

  console.log('\n── BY TERRITORY (top 12 by views) ──');
  for (const [k, d] of [...byTerr].sort((a, b) => b[1].views - a[1].views).slice(0, 12)) {
    const loc = [...d.local].map(([c, v]) => `${c} ${v.toFixed(2)}`).join(', ');
    console.log(line(k, d) + (loc ? `   [${loc}]` : ''));
  }
})();
