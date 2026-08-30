'use strict';
// GATE: the referral copy bans, applied to the WEB assets.
//
// WHY THIS EXISTS AS A SEPARATE GATE
// The iOS gate (ios/Promptly/trial-copy-gate.sh) enforces two-sided and quota
// bans on every Swift file, and it works. It is also blind to everything
// outside `Promptly/*.swift` — so js/referral-landing.js, which is the FIRST
// referral surface a new recipient ever sees and the only one on the
// fresh-install path, was never covered by any check at all.
//
// It shipped, live, with:
//   "Invite 3 friends who make a video and get a week of Pro."
//
// Three separate faults in one sentence. It is an invite QUOTA, the exact
// framing the ladder was rebuilt to remove. It promises a reward — a week at
// three friends — that the ladder no longer grants, so the copy was describing
// a scheme that had been replaced. And it says it to the RECIPIENT, who under
// referrer-only is promised nothing; telling the person being invited what
// they must do to earn Pro is the two-sided shape guideline 3.2.2 rejects.
//
// The iOS bans could not catch it because a translation of the rule into a
// second language (JavaScript) never happened. This is that translation.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

// Every web asset a referral recipient or sharer can read. Enumerated by
// CONTENT, not by directory: a new file that mentions the invite loop must be
// added here, and the last assertion makes forgetting visible.
const WEB_ASSETS = [
  'js/referral-landing.js',
  'index.html',
];

// Mirrors ios/Promptly/trial-copy-gate.sh so one rule cannot drift into two.
const TWO_SIDED_RE =
  /(they|your friend|the person you invite|whoever you invite|you both|both of you) (get|gets|receive|receives|earn|earns)|gift (them|your friend)|free .{0,20}for (them|your friend)/i;
const INVITE_QUOTA_RE =
  /invite [0-9]+ friends?|[0-9]+ (friends?|people) (to|who)|refer [0-9]+/i;
// A reward stated to the reader of the LANDING page is referee-directed by
// definition — that page is only ever read by the person being invited.
const REFEREE_REWARD_RE =
  /\b(get|earn|receive|claim)\b[^.]{0,40}\b(a week|[0-9]+ days?|free pro|pro free)\b/i;

let failures = 0;
function check(file, body) {
  // Strip // line comments and /* */ blocks: these files deliberately QUOTE
  // the banned sentence to document why it was removed, exactly as the Swift
  // gate excludes comments for the same reason.
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

  for (const [name, re] of [
    ['TWO-SIDED', TWO_SIDED_RE],
    ['INVITE QUOTA', INVITE_QUOTA_RE],
    ['REFEREE REWARD', REFEREE_REWARD_RE],
  ]) {
    const m = code.match(re);
    if (m) {
      failures++;
      console.error(`  ✗ ${name.padEnd(15)} ${file}: ${JSON.stringify(m[0])}`);
    }
  }
}

for (const rel of WEB_ASSETS) {
  const p = path.join(ROOT, rel);
  assert.ok(fs.existsSync(p), `${rel} is missing — the gate is reading a tree that does not match the deploy`);
  check(rel, fs.readFileSync(p, 'utf8'));
}

// The landing overlay must not hardcode a single-theme palette. The site is
// light by default (css/theme.css --bg-body #ffffff, dark only under
// prefers-color-scheme), so a fixed #000 panel is a black slab on a white page.
const landing = fs.readFileSync(path.join(ROOT, 'js/referral-landing.js'), 'utf8');
const overlayDecl = landing.match(/position:fixed;inset:0;z-index:99999;background:([^;]+);/);
assert.ok(overlayDecl, 'could not find the overlay background declaration — did the overlay move?');
assert.ok(
  overlayDecl[1].startsWith('var(--'),
  `the overlay background must be a theme token, got ${JSON.stringify(overlayDecl[1])} — ` +
  'a hardcoded colour renders one theme correctly and the other wrongly'
);
assert.ok(
  /@media \(prefers-color-scheme: dark\)/.test(landing),
  'the overlay defines theme tokens but no dark variant — it would render light-only'
);

// Coverage assertion: if a new referral web surface appears, it must be listed
// above. Silent non-coverage is how the landing page went unchecked for weeks.
const referralish = fs
  .readdirSync(path.join(ROOT, 'js'))
  .filter((f) => /referral|invite/i.test(f))
  .map((f) => `js/${f}`);
for (const f of referralish) {
  assert.ok(
    WEB_ASSETS.includes(f),
    `${f} looks like a referral surface but is not in WEB_ASSETS — add it, or the bans do not apply to it`
  );
}

if (failures) {
  console.error(`\n__smoke_referral_web_copy: FAILED — ${failures} banned-copy hit(s) in web assets.`);
  process.exit(1);
}
console.log(
  '__smoke_referral_web_copy: PASS — no two-sided, quota or referee-reward copy in the web assets; ' +
  'overlay is theme-token driven with a dark variant.'
);
