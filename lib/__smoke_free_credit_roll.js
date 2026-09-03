'use strict';
// SMOKE 2/2 — the LAZY ROLL is wired at BOTH sites, in the right order, and
// gated on the device claim (2026-09-02).
//
// WHY LAZY AND NOT A CRON. Granting monthly to every free profile is
// O(registered): 19,478 free accounts against 5,480 that rendered in the last 30
// days, growing ~14k/month, and RevenueCat rate-limits virtual-currency
// endpoints to 480 req/min. Lazy is O(active), needs no scheduler, and
// self-heals a missed month on next use. A cron that fails silently leaves
// users at zero — and there is no cron service running to host one.
//
// THE THREE THINGS THAT MAKE IT CORRECT, each independently losable:
//   1. It runs at BOTH the debit site and the balance read. Only the debit site
//      and a user's balance is stale until they render; only the balance read
//      and a user whose month just turned over is 402'd mid-render.
//   2. At the debit site it runs BEFORE the debit. After it, the user is
//      refused for lacking credits they are owed in the same request that
//      would have granted them.
//   3. It requires a DEVICE CLAIM. Without that, the allowance is available to
//      any account that simply never calls the claim endpoint — which is every
//      account an abuser makes, and the install guard becomes decorative.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const flat = SRC.replace(/\s+/g, ' ');
const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); };

// ── 1. wired at BOTH sites ─────────────────────────────────────────────────
const calls = (SRC.match(/await ensureFreePeriodGrant\(/g) || []).length;
ok(calls >= 3,
  `ensureFreePeriodGrant is called ${calls}x — expected 3 (debit site, balance `
  + 'read, free-grant endpoint). Losing the balance-read call leaves a stale '
  + 'number on screen; losing the debit-site call 402s a user who is owed credits');

ok(/LAZY ROLL \(write side\)[\s\S]{0,400}?await ensureFreePeriodGrant/.test(flat),
  'the debit-site roll is missing');
ok(/LAZY ROLL \(read side\)[\s\S]{0,200}?await ensureFreePeriodGrant/.test(flat),
  'the balance-read roll is missing');

// ── 2. ORDER: grant before debit, grant before the balance is read ─────────
const rollIdx = SRC.indexOf('LAZY ROLL (write side)');
const debitIdx = SRC.indexOf('await _credits.debit(authUser.id, _credits.COST_PER_RENDER)');
ok(rollIdx > 0 && debitIdx > 0 && rollIdx < debitIdx,
  'the lazy roll does not run BEFORE the debit — a user whose month just rolled '
  + 'gets a 402 in the very request that should have granted their allowance');

const readRollIdx = SRC.indexOf('LAZY ROLL (read side)');
const getBalIdx = SRC.indexOf('const b = await _credits.getBalance(authUser.id);');
ok(readRollIdx > 0 && getBalIdx > 0 && readRollIdx < getBalIdx,
  'the balance is read BEFORE the roll — the caller gets a number that was '
  + 'already stale when it was computed');

// ── 3. the device claim is a PRECONDITION of the allowance ────────────────
ok(/from\('free_credit_grants'\)\.select\('device_id'\)\.eq\('user_id', userId\)[\s\S]{0,600}?return skip\('no_device_claim'\)/.test(flat),
  'the lazy roll does not require a device claim — the free allowance would be '
  + 'available to any account that never calls the claim endpoint, which makes '
  + 'the install guard decorative');

// ── paid tiers must not be topped up to the FREE allowance ────────────────
ok(/if \(isPaid\) return skip\('paid_tier'\)/.test(flat),
  'the roll does not skip paid tiers — a spent-down Pro user would be topped up '
  + "to the FREE 30, replacing the 200 allowance RevenueCat grants them");

// ── never write to a project we have not reached ──────────────────────────
ok(/_rcHealthProbe\.value !== 'ok'\) return skip\('rc_unreachable'\)/.test(flat),
  'the roll is not gated on the RC probe — isConfigured() is presence-only and '
  + 'cannot tell a working project from a 404ing one');

// ── it must never fail a render ───────────────────────────────────────────
ok(/async function ensureFreePeriodGrant[\s\S]{0,300}?try \{/.test(flat),
  'ensureFreePeriodGrant has no top-level try — a credits failure must never '
  + 'take down a render; both call sites are on the render path');
ok(/catch \(e\) \{[\s\S]{0,300}?\[free-credits\] grant failed \(non-fatal\)/.test(flat),
  'ensureFreePeriodGrant does not swallow-and-log its own failure');

// ── the period is claimed BEFORE the credit, not after ────────────────────
const claimIdx = flat.indexOf("from('free_credit_periods') .insert({ user_id: userId, period, amount: 0, provider_ok: false })");
const creditIdx = flat.indexOf('await _credits.credit(userId, delta)');
ok(claimIdx > 0 && creditIdx > 0 && claimIdx < creditIdx,
  'the period row is written AFTER the RevenueCat credit — a crash between them '
  + 'would leave money granted with no record, and the next render would grant '
  + 'again. Ledger first, provider_ok:false, exactly as the referral grant does');

// ── THE DEBIT BUILD FLOOR ──────────────────────────────────────────────────
// Credits can only be GRANTED to a build that can claim a device, so charging a
// build that cannot be granted charges against a balance that can never exist.
// Without this, CREDITS_DEBIT_ENABLED=1 would 402 nearly every free user until
// they happened to upgrade — recent renders span builds 224-243.
ok(/const creditsAreTheLimiter = CREDITS_DEBIT_ENABLED && _debitApplies && _credits\.isConfigured\(\) && _credits\.shouldDebit\(\{ mode: 'full' \}\) && !isCompAccount\(entitlement\.row\)/.test(flat),
  'the debit is not gated on the build floor + comp exemption — arming it would '
  + 'charge builds that cannot receive credits, or meter a comped account that '
  + 'has no way to be granted any');

// ── THE COMP EXEMPTION IS comp_pro ONLY ────────────────────────────────────
// A comped account has no subscription, so RevenueCat's recurring grant has
// nothing to hang on, and the free monthly roll skips it as a paid tier. Metered
// without any source of credits it renders down its balance and is then refused
// forever — the one population for which the debit is a permanent lockout.
//
// IT MUST NOT WIDEN TO pro_until. UPDATE on profiles is granted to
// `authenticated` at TABLE level and the RLS policy is `auth.uid() = id` with NO
// column restriction, so the only thing stopping a user writing their own
// pro_until is a trigger — protect_entitlement_columns_trg, which was drafted
// 2026-06-23 and only APPLIED 2026-09-03, ten weeks later. For those ten weeks
// a bypass keyed on pro_until would have been self-serve free renders.
//
// The trigger is applied now, and this assertion still stands: keying the money
// decision on comp_pro means it does not depend on a database object staying
// applied — and that object has already been missing once. It is also the
// intuitive way to phrase this, which is exactly why it needs an assertion
// rather than a comment.
ok(/function isCompAccount\(profile\) \{ return Boolean\(profile\) && profile\.comp_pro === true; \}/
  .test(require('fs').readFileSync(path.join(__dirname, 'entitlement.js'), 'utf8').replace(/\s+/g, ' ')),
  'isCompAccount is not strictly comp_pro === true — if it has widened to '
  + 'pro_until / rc_app_user_id, any user who can PATCH their own profile row '
  + 'can exempt themselves from the credit debit permanently');

// ── AT MOST ONE LIMITER PER REQUEST ────────────────────────────────────────
// (Was "exactly one" until 2026-09-03. The comp exemption below deliberately
// creates a NEITHER case, so the old wording described a rule the code no
// longer follows — a smoke whose prose is false is worse than no prose, because
// the next reader trusts it.)
//
// The daily cap and credits answer the same question in different units: 30
// credits is 3 renders a MONTH; the daily cap is 3/day knob-off, 1/day knob-on.
// BOTH live and a credit-holding user gets `daily_limit_reached` — a refusal
// naming the wrong limit and pointing at an upgrade they may not need. One
// predicate governs both, which is what makes BOTH unreachable.
//
// NEITHER is now reachable, for exactly one population: comped accounts, on
// purpose. They are uncapped by `renderLimit === Infinity` and unmetered by the
// comp conjunct. Every other account still gets exactly one limiter.
ok(/\} else if \(wallCaps\.renderLimit === Infinity \|\| creditsAreTheLimiter\) \{/.test(flat),
  'the daily cap is not retired for credit-limited requests — credits and the '
  + 'daily gate would both run, and the daily 402 would win with the wrong message');
ok(/if \(creditsAreTheLimiter\) \{[\s\S]{0,900}?await _credits\.debit\(authUser\.id/.test(flat),
  'the debit is not driven by the SAME predicate that retires the daily cap — '
  + 'two independent conditions can drift into "neither runs" (uncapped) or '
  + '"both run" (wrong 402)');

// The predicate must be defined ABOVE the daily-cap branch. It used to be
// computed at the debit site ~60 lines below, which is AFTER the daily gate has
// already decided — so the cap could 402 a user the credits path was about to
// meter.
{
  const defIdx = SRC.indexOf('const creditsAreTheLimiter =');
  const capIdx = SRC.indexOf('} else if (wallCaps.renderLimit === Infinity || creditsAreTheLimiter)');
  ok(defIdx > 0 && capIdx > 0 && defIdx < capIdx,
    'creditsAreTheLimiter is defined AFTER the daily-cap branch that reads it');
}
// Safe to ship before the debit arms: with CREDITS_DEBIT_ENABLED off the
// predicate is false, so every request takes the cap exactly as it does today.
ok(/const creditsAreTheLimiter = CREDITS_DEBIT_ENABLED &&/.test(flat),
  'creditsAreTheLimiter does not lead with CREDITS_DEBIT_ENABLED — the '
  + 'retirement must be inert until the debit is armed');
ok(/_freeCredits\.debitApplies\( \{ build: _debitBuild, minBuild: _debitFloor \}\)/.test(flat),
  'the debit floor decision does not go through debitApplies() — that helper is '
  + 'where the fail-open behaviour is tested');
// ONE env var governs grant and charge, so a build can never be chargeable
// while being ungrantable.
ok(/_debitFloor = parseInt\(process\.env\.FREE_CREDITS_MIN_BUILD/.test(flat),
  'the debit floor reads an env var OTHER than FREE_CREDITS_MIN_BUILD — the '
  + 'grant side and the charge side must not be able to drift apart');

if (fail.length) {
  console.error('free-credit lazy-roll smoke: FAIL');
  for (const f of fail) console.error(`   ✗ ${f}`);
  process.exit(1);
}
console.log('free-credit lazy-roll smoke: PASS (both sites wired, grant precedes '
  + 'debit and balance read, device claim required, paid tiers skipped, RC probe '
  + 'gated, non-fatal, ledger-first)');
