// EVERY READ-MERGE-WRITE ON `result` MUST COMPARE-AND-SWAP [Law 2, Rule 1].
//
// Two of these existed. The lifecycle-push one sat harmless at 0.0% for twelve
// days across 2,687 completions and then produced 38-46% envelope loss the
// moment write ordering changed on Aug 11-12. The orphan-redispatch one has
// never fired at all. The lesson is not "fix the two" — it is that a dormant
// race is an UNEXERCISED race, and the thing that wakes it is a timing change
// somewhere else entirely, which no reviewer of the racing file will be looking
// at.
//
// So this is a CLASS gate, not a fix: any NEW `.update({ result: <spread of a
// previously-read value> })` must carry an updated_at CAS, or the deploy is
// blocked. It scans source rather than behaviour precisely because the failure
// is invisible at runtime until it is catastrophic — the erasing write succeeds,
// returns a row, and looks perfectly healthy.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname);

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.name === 'node_modules' || f.name.startsWith('.')) continue;
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out);
    else if (f.name.endsWith('.js') && !f.name.startsWith('__smoke_')) out.push(p);
  }
  return out;
}

const files = walk(LIB);
assert.ok(files.length > 5, `expected to scan the lib tree, saw ${files.length} files`);

// A read-merge-write is: an update whose `result` payload SPREADS a value that
// came from a prior read. Literal payloads (`result: { error_code: ... }`) are
// full replacements of a settled terminal and are not this class.
const RMW = /\.update\(\{[^}]*result:\s*([A-Za-z_$][\w$]*)\s*[,}]/g;
const offenders = [];
const guarded = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = RMW.exec(src)) !== null) {
    const varName = m[1];
    // Is that variable built by spreading something previously read?
    const decl = new RegExp(`(?:const|let)\\s+${varName}\\s*=\\s*\\{[\\s\\S]{0,400}?\\.\\.\\.`);
    if (!decl.test(src)) continue;                    // not a merge — skip
    // Look at the statement's filter chain for an updated_at CAS. The chain may
    // be built across several lines (query object reassigned), so scan a window.
    const at = m.index;
    const window = src.slice(at, at + 1400);
    const hasCas = /\.(eq|is)\(\s*['"]updated_at['"]/.test(window)
      || /(eq|is)\(\s*['"]updated_at['"]/.test(src.slice(Math.max(0, at - 800), at + 1400));
    const rel = path.relative(LIB, file);
    (hasCas ? guarded : offenders).push(`${rel} -> result: ${varName}`);
  }
}

assert.deepStrictEqual(offenders, [],
  'UNGUARDED read-merge-write on `result` — a concurrent worker envelope write '
  + 'landing between the read and this update is ERASED, silently, with the '
  + 'erasing update returning a row and looking healthy:\n  '
  + offenders.join('\n  ')
  + '\nAdd an updated_at compare-and-swap (see lib/lifecycle-push.js '
  + 'claimLifecyclePush) and re-read on a miss rather than overwriting.');

// And the two known ones must STILL be guarded — a gate that finds nothing
// because its pattern stopped matching is worse than no gate.
assert.ok(guarded.length >= 2,
  `expected to still SEE the two known read-merge-writes as guarded, saw ${guarded.length}: `
  + `${JSON.stringify(guarded)}. If they were refactored, this detector's pattern `
  + 'no longer matches reality and is silently passing.');
assert.ok(guarded.some((g) => g.includes('lifecycle-push')),
  `the lifecycle-push claim must be seen and guarded, saw: ${JSON.stringify(guarded)}`);
assert.ok(guarded.some((g) => g.includes('orphan-redispatch')),
  `the orphan-redispatch claim must be seen and guarded, saw: ${JSON.stringify(guarded)}`);

// The orphan sweep must actually READ updated_at, or its CAS degrades to
// `.is('updated_at', null)`, matches zero rows, and silently DISABLES the
// redispatch instead of guarding it. This is a real bug that was caught in
// review; the gate keeps it caught.
const orphan = fs.readFileSync(path.join(LIB, 'orphan-redispatch.js'), 'utf8');
const selectList = /\.select\(([\s\S]{0,600}?)\)\s*\n\s*\.in\(/.exec(orphan);
assert.ok(selectList, 'could not locate the orphan sweep select list');
// COMMENTS STRIPPED FIRST. Without this the assertion passes on the explanatory
// comment that sits inside the select list and happens to contain the word
// updated_at — a false green that survived deleting the actual column. Caught by
// running the RED proof; a check whose own negative case is untested is not a
// check.
const selectCols = selectList[1].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
assert.ok(/updated_at/.test(selectCols),
  'the orphan sweep must SELECT updated_at — without it the CAS compares against '
  + 'undefined, degrades to is(null), matches zero rows, and disables the redispatch');

console.log(`result read-merge-write audit: PASS (${files.length} files scanned, `
  + `${guarded.length} merge-writes found, all CAS-guarded, orphan sweep reads updated_at)`);
process.exit(0);
