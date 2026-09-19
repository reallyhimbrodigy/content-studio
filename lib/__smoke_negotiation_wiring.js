'use strict';
// SMOKE — the negotiation classifier is WIRED DARK, and dark means inert.
//
// The module's own behaviour is covered by __smoke_negotiation_classifier.js.
// This covers the thing that module cannot: that its presence in server.js
// changes nothing while the flag is off. A dark feature that alters the live
// path is not dark, and this is the only property whose failure is invisible
// in testing and expensive in production.
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
let fails = [];
const check = (n, c, why = '') => { console.log(`  [${c ? 'ok' : 'FAIL'}] ${n}`); if (!c) fails.push(`${n} :: ${why}`); };

check('the classifier is required by the server', /require\('\.\/lib\/negotiation-classifier'\)/.test(src));

// 0. UNSAFE IS NEVER REGEX-ONLY — the server must use the adjudicated path.
check('the server calls classifyWithSafety, not the bare regex classify',
  /await negotiation\.classifyWithSafety\(/.test(src)
  && !/negotiationDecision = negotiation\.classify\(/.test(src),
  'the sync classify() is regex-only and is blind to 15.2% of briefs by construction');
check('the recorded decision carries the safety verdict and WHO made it',
  /safety: negotiationDecision\.safety/.test(src) && /by: negotiationDecision\.safety\.by/.test(src),
  'a refusal whose author is unrecorded cannot be audited for false positives');

// 1. THE LIVE BRANCH IS GUARDED BY THE FLAG. Nothing else may park a job.
const parkIdx = src.indexOf("parked.negotiation = negotiationDecision");
check('the parking branch exists', parkIdx > 0);
const before = src.slice(Math.max(0, parkIdx - 700), parkIdx);
check('the parking branch is guarded by negotiation.flagOn()',
  /if \(negotiation\.flagOn\(\)/.test(before),
  'an unguarded park would stop real jobs the moment this merges');

// 2. THE CLASSIFY CALL CANNOT COST A RENDER. Any throw is swallowed.
// NAMED BY PROPERTY, NOT BY SPELLING. These three legs were pinned to
// `negotiation.classify(vibeInput` and went red on CORRECT code the moment the
// call became classifyWithSafety — a check defending a spelling, not a
// behaviour. It now matches any invocation of the classifier.
const classifyIdx = src.search(/negotiation\.classify\w*\(vibeInput/);
check('the classifier is invoked on the brief', classifyIdx > 0);
// the window must hold the whole try/catch, comments included — 300 chars was
// narrower than the comment block above the call, so the leg failed on correct
// code for the second time in one edit.
// BOUND BY THE BLOCK, NOT BY A CHARACTER COUNT. A fixed window was outgrown
// twice by legitimate additions to the block it was measuring — a check that
// has to be re-tuned every time correct code grows is a check that will
// eventually be silenced instead of fixed.
const _bs = src.indexOf('// ── D4: THE NEGOTIATION CLASSIFIER, DARK');
const around = src.slice(_bs, src.indexOf('const insertRow = {', _bs));
check('the classifier call is inside a try/catch',
  /try \{[\s\S]*negotiation\.classify\w*\(vibeInput[\s\S]*\} catch/.test(around),
  'a classifier fault must never cost a render');
check('the catch proceeds unchanged rather than rethrowing',
  /catch \(err\) \{[\s\S]{0,260}negotiationDecision = null;/.test(around),
  'swallowing the error but leaving a partial decision would be worse than throwing');

// 3. IT RUNS BEFORE THE INSERT — the point is no job row, no charge.
check('the classifier runs BEFORE the job row is built',
  classifyIdx < src.indexOf('const insertRow = {'),
  'classifying after the insert would charge the user for a request we then park');

// 4. IT DOES NOT TOUCH THE ROW. The dark path writes a log line and nothing else.
const blockStart = src.indexOf('// ── D4: THE NEGOTIATION CLASSIFIER, DARK');
const blockEnd = src.indexOf('const insertRow = {', blockStart);
const block = src.slice(blockStart, blockEnd);
check('the dark block never mutates insertRow', !/insertRow/.test(block),
  'a dark feature that edits the dispatched row is not dark');
// REVERSED BY RULING, and replaced rather than deleted. This asserted the dark
// block wrote nothing to the database — correct when written, wrong once the
// shadow table was ruled in. The PROPERTY that survives is narrower and is the
// one that actually protects the dispatch path: it may write to the shadow
// table and to NOTHING ELSE.
check('the dark block writes ONLY to the shadow table',
  /from\('negotiation_decisions'\)/.test(block)
  // `.update(` alone also matched createHash(...).update() — the HASH call, not
  // a database write. Pinned to a supabase chain: from(<not the shadow table>)
  // or an update that follows a from().
  && !/from\('(?!negotiation_decisions)[a-z_]+'\)/.test(block)
  && !/from\([^)]*\)\s*\.update\(/.test(block),
  'a dark feature touching the jobs table is not dark');
check('the dark block records the sentence it WOULD have shown',
  /would_say/.test(block),
  'the shadow rate is the whole point of dark: without the sentence there is nothing to review');
check('...and records which state the flag was in',
  /flagOn\(\) \? 'ON' : 'DARK'/.test(block),
  'a log line that does not say whether the flag was on cannot be read later');

// 5. BEHAVIOURAL: with the flag off, an out-of-scope brief still classifies but
//    the module never instructs a park.
const m = require('./negotiation-classifier.js');
const d = m.classify('Add background music and turn it into anime', { hasInScopeAsks: false });
check('an out-of-scope brief still yields a decision while dark', d.verdict === 'NEGOTIATE');
check('...and the flag is independently OFF by default', !m.flagOn({}),
  'the decision is computed either way; only the ACTION is gated');

// 6. THE SHADOW ROW AND THE ALERT — ruled additions, both must be wired.
check('decisions are written to the shadow table',
  /from\('negotiation_decisions'\)\.insert\(/.test(src),
  'the 24-hour read needs a queryable record, not log retention');
check('...hashed, never the brief text',
  /createHash\('sha256'\)\.update\(String\(vibeInput\)\)/.test(src)
  && !/vibe_input: vibeInput[\s\S]{0,400}negotiation_decisions/.test(src),
  'the shadow table must not become a second copy of user content');
check('...and a shadow-write failure never costs a render',
  /shadow insert failed[\s\S]{0,200}\)\s*\.catch\(/.test(src)
  || /\.then\(\(\{ error \}\)[\s\S]{0,260}\.catch\(/.test(src),
  'an insert error must be logged and dropped, never thrown into the dispatch path');
check('the outage alert fires on a degraded read',
  /negotiationDecision\.alert[\s\S]{0,300}sendOwnerAlert\(/.test(src),
  'a classifier outage that pages nobody is a silent one');

console.log();
if (fails.length) { console.log('NEGOTIATION WIRING: FAIL'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('NEGOTIATION WIRING: PASS — computed and logged, inert while dark');
