'use strict';
// THE RETRY LAW, GATED.
//
//   A retry that repeats the failing shape is not a retry.
//   A run that leaves any row unjudged THROWS rather than writing a file that
//   looks complete.
//
// Both were learned the expensive way in this lane. 12 rows went silently
// unjudged because a batch of long briefs exceeded max_tokens and the retry
// re-sent the SAME oversized chunk; the output file was written anyway and
// looked finished. A separate run died on ECONNRESET because the retry only
// covered HTTP 429/5xx, and a transport error THROWS rather than returning a
// status. Comments did not stop either. This does.
const fs = require('fs'), path = require('path'), ast = null;
const DIR = __dirname;
const TARGETS = ['classify.js', 'readjudicate.js'];
let fails = [];
const check = (n, c, why = '') => { console.log(`  [${c ? 'ok' : 'FAIL'}] ${n}`); if (!c) fails.push(`${n} :: ${why}`); };

for (const f of TARGETS) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  const hasBatching = /for \(let k = 0; k < \w+\.length; k \+= BATCH\)/.test(src);
  if (!hasBatching) { check(`${f}: batches rows`, false, 'no batch loop found — the law below is vacuous without one'); continue; }

  // 1. THE RETRY MUST SHRINK. A retry that re-sends the identical chunk hits
  //    the identical ceiling.
  // MATCH THE PROPERTY, NOT A SUBSTRING NEAR A WORD. The first version split
  // the source on the literal "miss" and looked for RETRY_BATCH in the tail,
  // which failed on a file that HAD the fix — a leg wrong for a reason
  // unrelated to the code it judges.
  const declares = /const .*RETRY_BATCH\s*=\s*\d+/.test(src);
  const slices = /\.slice\(m, m \+ RETRY_BATCH\)/.test(src);
  check(`${f}: the retry uses a SMALLER batch than the one that failed`,
    declares && slices,
    'a retry that repeats the failing shape is not a retry');

  // 2. UNPROCESSED ROWS MUST THROW. Not warn, not count, not write a file with
  //    a smaller number in it.
  const throwsOnUnprocessed = /throw new Error\([^)]*UNPROCESSED/.test(src)
    || /still\.length\)\s*throw/.test(src);
  check(`${f}: any row still unjudged after retry THROWS`,
    throwsOnUnprocessed,
    'a file that looks complete over missing rows is the absence-as-success class');

  // 3. THE WRITE MUST NOT PRECEDE THE CHECK. If the output file is written
  //    before the unprocessed-rows guard, the guard cannot stop a bad file.
  const iThrow = src.search(/throw new Error\([^)]*UNPROCESSED/);
  const iWrite = src.search(/fs\.writeFileSync/);
  check(`${f}: the unprocessed guard runs BEFORE the output is written`,
    iThrow !== -1 && iWrite !== -1 && iThrow < iWrite,
    'guarding after the write leaves the bad file on disk');

  // 4. TRANSPORT ERRORS MUST RETRY TOO. A status-only retry misses ECONNRESET,
  //    which throws instead of returning a response.
  check(`${f}: fetch is wrapped so a TRANSPORT error retries, not just 429/5xx`,
    /catch \(e\)/.test(src) && /ECONNRESET|transport/i.test(src),
    'a retry keyed only on r.status never sees a thrown socket error');
}

console.log();
if (fails.length) { console.log('RETRY LAW: FAIL'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('RETRY LAW: PASS — retries shrink, unjudged rows throw before any file is written');
