// A 429 MUST NAME ITS OWN QUOTA. [Rule 1]
//
// Chat is 502 on 100% of requests from a Gemini 429, and the ledger recorded
// `{code:502}` and nothing else — so "which quota, at what limit" meant hunting
// a Render log line before it scrolled. Google puts the answer in a structured
// QuotaFailure detail and we were discarding it.
const assert = require('assert');
const { parseQuotaFailure } = require('./quota-failure');

// A REAL Google 429 body, shape-for-shape.
const BODY = JSON.stringify({
  error: {
    code: 429,
    message: 'Quota exceeded for quota metric ...',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          { quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateContentRequestsPerMinutePerProjectPerModel-FreeTier',
            quotaValue: '10',
            quotaDimensions: { model: 'gemini-flash-latest', location: 'global' } },
          { quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count',
            quotaValue: '250000' },
        ] },
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'RATE_LIMIT_EXCEEDED',
        metadata: { service: 'generativelanguage.googleapis.com', quota_limit_value: '10' } },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '31s' },
    ],
  },
});

const q = parseQuotaFailure(BODY);

// 1. THE TWO FIELDS THAT END THE INVESTIGATION.
assert.strictEqual(q.violations[0].metric,
  'generativelanguage.googleapis.com/generate_content_free_tier_requests',
  'the quota METRIC must survive — it is the only thing that says which ceiling was hit, '
  + 'and whether a Vertex grant on a DIFFERENT service could ever have covered it');
assert.strictEqual(q.violations[0].value, '10', 'the LIMIT must survive');

// 2. FREE-TIER IS READABLE FROM IT. That distinction decides whether the fix is a
//    dashboard billing link or a quota request — completely different actions.
assert.ok(/free_tier/.test(q.violations[0].metric),
  'a free-tier metric must be visible as such; free-vs-paid is the difference between '
  + 'linking a billing account and filing a quota increase');

// 3. EVERY violation, not just the first — a request can breach several ceilings
//    at once and reporting only [0] is how you fix the wrong one.
assert.strictEqual(q.violations.length, 2, 'all violations must be captured');

// 4. The service must be named, because chat and Lumen sit on DIFFERENT services
//    and that is exactly the question being argued.
assert.strictEqual(q.service, 'generativelanguage.googleapis.com');
assert.strictEqual(q.reason, 'RATE_LIMIT_EXCEEDED');
assert.strictEqual(q.retry_delay, '31s');

// 5. AN UNPARSEABLE BODY IS ITS OWN FINDING, never a silent null — a changed
//    shape must survive to the row rather than be dropped for being awkward.
const bad = parseQuotaFailure('<html>502 Bad Gateway</html>');
assert.ok(bad && bad.parse_failed === true && bad.raw, 'unparseable bodies must be reported');
assert.strictEqual(parseQuotaFailure(''), null, 'empty body is distinguishable from a failure');

// 6. A NON-QUOTA error still parses without inventing violations.
const auth = parseQuotaFailure(JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'bad creds' } }));
assert.strictEqual(auth.status, 'UNAUTHENTICATED');
assert.ok(!auth.violations, 'no violations invented for a non-quota error');


// 8. A 429 IS NOT ALWAYS A RATE LIMIT — and this is the one that actually
//    happened. Google returns 429 RESOURCE_EXHAUSTED for BILLING depletion with
//    NO QuotaFailure block: no metric, no violations, no retryDelay. Chat's real
//    cause was "Your prepayment credits are depleted." The null metric WAS the
//    signal, but it presents as a parser failure — I nearly reported my own
//    instrument as broken. The row must SAY which kind it is.
const billing = parseQuotaFailure(JSON.stringify({
  error: { code: 429, status: 'RESOURCE_EXHAUSTED',
    message: 'Your prepayment credits are depleted. Please go to AI Studio at '
      + 'https://ai.studio/projects to manage your project and billing.' },
}));
assert.strictEqual(billing.classification, 'billing_depleted',
  'a prepay-depletion 429 must be classified as BILLING, not left as a null metric — '
  + 'billing is a DASHBOARD action and a quota ceiling is a code/quota action, and '
  + 'naming the wrong one sends the fix to the wrong place');
assert.ok(/DASHBOARD/.test(billing.action), 'the action must name the dashboard');
assert.ok(!billing.violations, 'a billing 429 carries no violations — that is the tell');
assert.strictEqual(q.classification, 'quota_exceeded',
  'a real QuotaFailure must still classify as a quota ceiling');
assert.strictEqual(
  parseQuotaFailure(JSON.stringify({ error: { code: 429, message: 'something new' } })).classification,
  'unclassified_429',
  'an unrecognised 429 must be labelled as such, never silently bucketed');


// 9. THE THIRD CLASS — a REAL message, captured live at 06:14Z one hour after
//    the billing class shipped. Same 429, same null metric, OPPOSITE response.
const transient = parseQuotaFailure(JSON.stringify({
  error: { code: 429, status: 'RESOURCE_EXHAUSTED',
    message: 'This model is currently experiencing high demand. Spikes in demand '
      + 'are usually temporary. Please try again later.' },
}));
assert.strictEqual(transient.classification, 'transient_capacity',
  'a high-demand 429 must be TRANSIENT, not billing and not unclassified — billing '
  + 'is permanent until a human acts, this resolves itself, and confusing them means '
  + 'either paging a human for nothing or waiting forever for a spike to clear');
assert.ok(/RETRY/.test(transient.action), 'the action must say retry');
assert.notStrictEqual(transient.classification, billing.classification,
  'transient and billing must never collapse into one bucket — that is the exact '
  + 'mistake that would have read a successful top-up as a failed one');

// 7. BOTH chat surfaces must persist it — instrumenting one leaves half the
//    evidence in a log, and both are 429ing at 100%.
const srv = require('fs').readFileSync(require('path').join(__dirname, '../server.js'), 'utf8');
assert.ok(/recordQuotaFailure\([\s\S]{0,200}route: '\/api\/chat'/.test(srv),
  '/api/chat does not persist the quota failure');
assert.ok(/recordQuotaFailure\([\s\S]{0,200}route: '\/api\/chat\/stream'/.test(srv),
  '/api/chat/stream does not persist the quota failure');

console.log('quota failure smoke: PASS (metric + limit survive, free-tier readable, all '
  + 'violations kept, service named, unparseable bodies reported, both surfaces wired)');
process.exit(0);
