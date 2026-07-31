'use strict';
// GATE (2026-07-31, the allowlist-drift lesson → a check, not a memory).
//
// The /api/events SQL mirror silently DROPS any event not in server.js's ALLOWED
// set. But events are added on the CLIENT (Swift, on the app-* branch) while the
// allowlist lives on the SERVER (main) — so they drift, and a new instrument
// ships blind to the DB (PostHog keeps it; the SQL our analysis queries does not).
// That drift already dropped 9 events across two batches before this gate existed.
//
// Runs BOTH directions, like the dead-instruction pass:
//   • FAIL: every event a client/web surface EMITS must be allowlisted. (the one
//     that costs us data — an unallowlisted emit is a half-blind instrument.)
//   • WARN: every allowlisted event should still be emitted — a stale one is a
//     dead instrument, OR a legacy name an older shipped client still sends
//     (1.2.0 is live), so warn but never fail on it.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');

// 1) ALLOWED set from server.js
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const setMatch = server.match(/const ALLOWED = new Set\(\[([\s\S]*?)\]\);/);
if (!setMatch) {
  console.error('event-allowlist gate: could not locate the ALLOWED set in server.js');
  process.exit(1);
}
const allowed = new Set([...setMatch[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));

// 2) EMITTED events, from every surface that posts through /api/events.
const emitted = new Map(); // event -> where first seen
const addEmit = (ev, where) => { if (!emitted.has(ev)) emitted.set(ev, where); };

// 2a) working-tree Swift (whatever branch we're on)
const swiftFiles = [];
(function walk(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (e.name.endsWith('.swift')) swiftFiles.push(p);
  }
})(path.join(ROOT, 'ios'));
for (const f of swiftFiles) {
  const re = /Analytics\.track\(\s*"([a-z_]+)"/g;
  const src = fs.readFileSync(f, 'utf8');
  let mm; while ((mm = re.exec(src))) addEmit(mm[1], 'ios(working)');
}

// 2b) app-* branches via git — the client trunk usually diverges from main, which
//     is exactly how the drift hides. Best-effort: a shallow CI checkout without
//     those branches simply falls back to the working tree above.
try {
  const branches = cp.execSync("git for-each-ref --format='%(refname:short)' refs/heads/app-*", { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  for (const b of branches) {
    let out = '';
    try { out = cp.execSync(`git grep -hoE 'Analytics\\.track\\("[a-z_]+"' ${b} -- 'ios/**/*.swift'`, { cwd: ROOT, encoding: 'utf8' }); }
    catch (e) { continue; }
    for (const line of out.split('\n')) {
      const g = line.match(/track\("([a-z_]+)"/);
      if (g) addEmit(g[1], `ios(${b})`);
    }
  }
} catch (e) { /* no reachable app-* branches — working tree only */ }

// 2c) web surfaces (the /get landing module posts through /api/events too)
for (const rel of ['js/inapp-browser-escape.js']) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const re = /\btrack\(\s*'([a-z_]+)'/g;
  const src = fs.readFileSync(p, 'utf8');
  let mm; while ((mm = re.exec(src))) addEmit(mm[1], rel);
}

// 3) WARN: allowlisted but not emitted (stale / legacy older-client names)
const stale = [...allowed].filter((ev) => !emitted.has(ev)).sort();
if (stale.length) {
  console.warn(`event-allowlist: ${stale.length} allowlisted but NOT currently emitted (stale/dead, OR a legacy name an older shipped client still sends — verify before removing):`);
  console.warn('  ' + stale.join(', '));
}

// 4) FAIL: emitted but not allowlisted
const missing = [...emitted.keys()].filter((ev) => !allowed.has(ev)).sort();
if (missing.length) {
  console.error(`event-allowlist GATE FAILED — ${missing.length} event(s) EMITTED but NOT allowlisted → the SQL mirror silently drops them (half-blind instrument):`);
  for (const ev of missing) console.error(`  '${ev}'  (${emitted.get(ev)}) — add it to the ALLOWED set in server.js`);
  process.exit(1);
}

console.log(`event-allowlist gate OK — all ${emitted.size} emitted client/web events are allowlisted (${stale.length} stale allowlist entries warned above; kept for older shipped clients).`);
