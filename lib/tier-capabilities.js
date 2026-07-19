'use strict';

// The tier × capability truth table (Wall Correctness Package, item 1) as CODE —
// the single source of truth for the server gates. Mirrored cell-for-cell in
// EntitlementTier.swift on the client. Every cell here has a test in
// tests/tier-capabilities.test.js: a cell without a green test does not exist.
//
//   tier ∈ {'none','trial','paid'}  (from entitlementTier(profile))
//
// | Capability      | none      | trial     | paid      |
// |-----------------|-----------|-----------|-----------|
// | app usable      | ❌ → wall | ✅        | ✅        |
// | upload (max)    | 0         | 1         | 10        |
// | renders/day     | 0         | 3         | ∞         |
// | chats/day       | 0         | 50        | ∞         |
// | re-edit         | ❌        | ❌        | ✅        |
// | lumen           | ❌        | ❌        | ✅        |
// | limit-hit route | wall      | paywall   | —         |

const TRIAL_DAILY_RENDERS = 3; // trial tier limits == today's free-tier limits
const TRIAL_DAILY_CHATS = 50;
const TRIAL_UPLOAD_MAX = 1;
const PAID_UPLOAD_MAX = 10;

/** The full capability row for a tier. `none` (and any unknown value) fails
 *  closed to the wall — no capability leaks to an unrecognized tier. */
function capabilities(tier) {
  switch (tier) {
    case 'paid':
      return {
        appUsable: true, uploadMax: PAID_UPLOAD_MAX,
        renderLimit: Infinity, chatLimit: Infinity,
        reedit: true, lumen: true, limitHitRouting: null,
      };
    case 'trial':
      return {
        appUsable: true, uploadMax: TRIAL_UPLOAD_MAX,
        renderLimit: TRIAL_DAILY_RENDERS, chatLimit: TRIAL_DAILY_CHATS,
        reedit: false, lumen: false, limitHitRouting: 'paywall',
      };
    default: // 'none' + anything unrecognized
      return {
        appUsable: false, uploadMax: 0,
        renderLimit: 0, chatLimit: 0,
        reedit: false, lumen: false, limitHitRouting: 'wall',
      };
  }
}

// Gate predicates the render/chat/upload endpoints call. Each ANDs appUsable so
// `.none` is denied on every action regardless of counts (the wall holds).
const appUsable = (tier) => capabilities(tier).appUsable;
const canReedit = (tier) => capabilities(tier).reedit;
const canUseLumen = (tier) => capabilities(tier).lumen;

function canRender(tier, todayRenders) {
  const c = capabilities(tier);
  return c.appUsable && todayRenders < c.renderLimit;
}
function canChat(tier, todayChats) {
  const c = capabilities(tier);
  return c.appUsable && todayChats < c.chatLimit;
}
function canUpload(tier, count) {
  const c = capabilities(tier);
  return c.appUsable && count >= 1 && count <= c.uploadMax;
}

/** Where a DENIED action should route the client: the pre-trial wall (`.none`)
 *  or the upgrade paywall (`.trial` hitting a cap). `paid` never routes. */
function denialRouting(tier) {
  return capabilities(tier).limitHitRouting;
}

module.exports = {
  capabilities,
  appUsable, canReedit, canUseLumen, canRender, canChat, canUpload, denialRouting,
  TRIAL_DAILY_RENDERS, TRIAL_DAILY_CHATS, TRIAL_UPLOAD_MAX, PAID_UPLOAD_MAX,
};
