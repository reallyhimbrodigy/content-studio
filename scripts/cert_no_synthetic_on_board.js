#!/usr/bin/env node
'use strict';

/**
 * CERT — no fixture row may reach a board, and the NAIVE predicate may never ship.
 *
 * WHY. A synthetic fixture landed in `video_jobs` on 2026-08-23. One row today,
 * but "one row" is how every contaminated denominator on this board started.
 *
 * THE TRAP THIS EXISTS TO PREVENT is not forgetting the filter — it is writing
 * the OBVIOUS one. `result->>synthetic=neq.true` returns ZERO ROWS, because a row
 * without the key has NULL there and SQL's `NULL != 'true'` is NULL, not true.
 * Measured live, not reasoned about:
 *     <none>                          1000 rows
 *     neq.true             (NAIVE)       0 rows   <- EMPTIES THE ENTIRE BOARD
 *     or(is.null,neq.true) (SAFE)     1000 rows
 *     eq.true              (fixture)     1 row
 * A board reporting zero everywhere looks like a clean run and reads as "no
 * failures". That is strictly worse than the contamination it was meant to fix.
 *
 * Offline. No network, no spend.
 */
const fs = require('fs');
const path = require('path');

const BOARD = path.join(__dirname, 'bleeds.js');
const src = fs.readFileSync(BOARD, 'utf8');
const fails = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fails.push(label);
};

console.log('CERT no-synthetic-on-board\n');

// 1. The predicate exists, in exactly one place.
const defs = src.match(/const NOT_SYNTHETIC = '([^']+)'/g) || [];
check('NOT_SYNTHETIC defined exactly once', defs.length === 1, `${defs.length} definition(s)`);
const pred = (src.match(/const NOT_SYNTHETIC = '([^']+)'/) || [])[1] || '';

// 2. It is the SAFE form — null-tolerant. This is the whole cert.
check('predicate tolerates rows WITHOUT the key (is.null present)',
  pred.includes('is.null'),
  pred || '<none>');
check('predicate is not the bare naive form',
  !/^result->>synthetic=neq\.true$/.test(pred));

// 3. The naive form appears nowhere in the board.
const naive = /result->>synthetic\s*=\s*neq\.true/.test(src.replace(/^\s*\/\/.*$/gm, ''));
check('the NAIVE predicate appears nowhere in live code', !naive,
  naive ? 'found outside comments — this returns ZERO ROWS' : '');

// 4. Applied by CONSTRUCTION, not per-query.
check('exclusion is applied inside pageAll, not appended per query',
  /async function pageAll\(q0\)/.test(src) && /excludeSynthetic\(q0\)/.test(src));

// 5. NO video_jobs fetch may bypass pageAll.
const fetches = (src.match(/fetch\(`?\$\{URL_\}\/rest\/v1\//g) || []).length;
check('exactly ONE rest/v1 fetch site (no bypass path)', fetches === 1, `${fetches} fetch site(s)`);

// 6. Behavioural — run the real transform against real query shapes.
const fn = src.match(/function excludeSynthetic\(q\) \{[\s\S]*?\n\}/);
if (!fn) { check('excludeSynthetic is extractable', false); }
else {
  // `eval` under 'use strict' keeps declarations in its own scope, so the
  // function never escaped and the cert crashed instead of judging. Build it
  // with the closure variable passed in explicitly.
  const excludeSynthetic = new Function('NOT_SYNTHETIC',
    `${fn[0]}\nreturn excludeSynthetic;`)(pred);
  const q = 'video_jobs?select=id&created_at=gte.2026-08-15';
  check('video_jobs query gains the exclusion', excludeSynthetic(q).includes('is.null'));
  check('non-video_jobs table is left untouched',
    excludeSynthetic('analytics_events?select=event') === 'analytics_events?select=event');
  check('an EXPLICIT fixture query is not double-filtered',
    excludeSynthetic('video_jobs?select=id&result->>synthetic=eq.true')
      === 'video_jobs?select=id&result->>synthetic=eq.true');
}

console.log(`\nRESULT: ${fails.length ? `FAIL — ${fails.join(', ')}` : 'PASS'}`);
process.exit(fails.length ? 1 : 0);
