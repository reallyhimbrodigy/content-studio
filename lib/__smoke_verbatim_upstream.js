// A CLASSIFIED ERROR MUST CARRY ITS UPSTREAM MESSAGE VERBATIM. [Rule 1, Rule 4]
//
// STANDING POLICY, and it is written from two same-day incidents where the
// PARSED fields said nothing and the RAW message carried the whole answer:
//
//  1. 05:37Z  429, quota_metric=null, violations=null, retryDelay=null.
//     Looked exactly like a broken parser. The message said
//     "Your prepayment credits are depleted" — a BILLING wall, fixed from a
//     dashboard. Nine days of dead chat, answered by one string.
//
//  2. 06:14Z  429, quota_metric=null, violations=null, retryDelay=null —
//     IDENTICAL parsed shape. The message said "This model is currently
//     experiencing high demand... usually temporary" — TRANSIENT, resolves
//     itself. Without the raw text, both read as "chat still 429ing" and the
//     obvious conclusion, that the top-up had failed, would have been WRONG.
//
// The lesson is not "parse better". It is that a classifier can only sort into
// the categories it already knows, and the categories it does not know are
// exactly where the incidents live. The verbatim message is the escape hatch
// from your own taxonomy.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const QF = fs.readFileSync(path.join(__dirname, 'quota-failure.js'), 'utf8');

// 1. THE RAW MESSAGE IS PERSISTED, not merely logged. A log line scrolls; a row
//    can be queried a day later by someone who was not there.
assert.ok(/upstream_message:/.test(QF),
  'upstream_message is no longer persisted — the parsed fields were null in BOTH '
  + 'same-day incidents and the raw text was the entire answer');

// 2. IT IS NOT TRUNCATED TO UNUSABILITY. "Your prepayment credits are depleted.
//    Please go to AI Studio at ..." is 150+ chars and the actionable half is at
//    the end.
const m = QF.match(/message:\s*String\(err\.message\s*\|\|\s*''\)\.slice\(0,\s*(\d+)\)/);
assert.ok(m, 'the message is no longer captured from the error body');
assert.ok(Number(m[1]) >= 200,
  `upstream message truncated to ${m[1]} chars — the billing message's actionable `
  + 'half (the dashboard URL) sits past 150 chars');

// 3. AN UNPARSEABLE BODY STILL SURVIVES. A shape we do not recognise is exactly
//    the case worth keeping, not the case worth dropping.
const { parseQuotaFailure } = require('./quota-failure');
const junk = parseQuotaFailure('<html>502 Bad Gateway</html>');
assert.ok(junk && junk.parse_failed && junk.raw,
  'an unparseable upstream body must still reach the row');

// 4. EVERY CLASSIFICATION HAS AN ACTION. A label with no action is a label that
//    sends someone to read the code instead of fixing the problem.
for (const [body, cls] of [
  [{ error: { code: 429, message: 'prepayment credits are depleted' } }, 'billing_depleted'],
  [{ error: { code: 429, message: 'experiencing high demand, try again later' } }, 'transient_capacity'],
  [{ error: { code: 429, message: 'something nobody has seen before' } }, 'unclassified_429'],
]) {
  const q = parseQuotaFailure(JSON.stringify(body));
  assert.strictEqual(q.classification, cls, `${cls} misclassified`);
  assert.ok(q.action && q.action.length > 10,
    `${cls} has no action — a classification without an action is a label, and a `
    + 'label does not tell anyone what to do next');
  assert.ok(q.message && q.message.length,
    `${cls} dropped the verbatim message — the classification is a SUMMARY of it, `
    + 'never a replacement for it');
}

console.log('verbatim upstream smoke: PASS (raw message persisted untruncated, '
  + 'unparseable bodies survive, every classification carries an action AND its '
  + 'original text)');
process.exit(0);
