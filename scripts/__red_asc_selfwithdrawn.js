'use strict';
// RED-prove for the withdraw-and-replace exception in asc-preflight.
//
// The exception lets a SELF-withdrawn version be resubmitted with a newer
// build. That is a hole by construction, so each condition guarding it gets a
// case here that must BLOCK, and the happy path gets one that must ALLOW —
// otherwise "everything blocks" would score as a pass and the guard could be
// wedged shut without anyone noticing.
//
// Run: node scripts/__red_asc_selfwithdrawn.js
const { decideSelfWithdrawn, readConfirmation } = require('./asc-preflight.js');

// The real, current facts — every case below is this with ONE field spoiled,
// so a case can only fail for the reason it names.
const BASE = {
  version: '1.3.38',
  buildNum: '259',
  state: 'DEVELOPER_REJECTED',
  attachedBuild: '258',
  itemState: 'REMOVED',
  confirmation: {
    status: 'confirmed',
    withdrawnBuild: '258',
    confirmedBy: 'Zac',
    confirmedDate: '2026-09-23',
  },
};

const cases = [
  // The POSITIVE control. Without this a guard that blocks everything passes.
  { name: 'happy path: our withdrawal, newer build, dated confirmation', f: BASE, allow: true },

  // (1) Apple's verdicts must block unconditionally — even with a perfect
  //     confirmation and a newer build sitting right there.
  { name: 'Apple REJECTED blocks', f: { ...BASE, state: 'REJECTED' }, allow: false, because: 'Apple verdict' },
  { name: 'METADATA_REJECTED blocks', f: { ...BASE, state: 'METADATA_REJECTED' }, allow: false, because: 'Apple verdict' },
  { name: 'INVALID_BINARY blocks', f: { ...BASE, state: 'INVALID_BINARY' }, allow: false, because: 'Apple verdict' },
  // A reviewer acting on the item is an Apple verdict wearing our state.
  { name: 'item REJECTED blocks even when the version says we withdrew it',
    f: { ...BASE, itemState: 'REJECTED' }, allow: false, because: 'reviewer acted on it' },

  // (2) The build must strictly advance.
  { name: 'same build number blocks', f: { ...BASE, buildNum: '258' }, allow: false, because: 'does not replace withdrawn build' },
  { name: 'lower build number blocks', f: { ...BASE, buildNum: '257' }, allow: false, because: 'does not replace withdrawn build' },
  { name: 'unreadable build blocks', f: { ...BASE, attachedBuild: null }, allow: false, because: 'build numbers unreadable' },
  { name: 'empty-string build blocks (Number(\'\') is 0)', f: { ...BASE, attachedBuild: '' }, allow: false, because: 'build numbers unreadable' },

  // (3) A dated human confirmation must be present, about THIS withdrawal.
  { name: 'missing confirmation blocks', f: { ...BASE, confirmation: null }, allow: false, because: 'no Resolution Center confirmation recorded' },
  { name: 'confirmation for a different build blocks',
    f: { ...BASE, confirmation: { ...BASE.confirmation, withdrawnBuild: '251' } }, allow: false, because: 'about build 251' },
  { name: 'confirmation with no date blocks',
    f: { ...BASE, confirmation: { ...BASE.confirmation, confirmedDate: '' } }, allow: false, because: 'no valid date' },
  { name: 'confirmation with a malformed date blocks',
    f: { ...BASE, confirmation: { ...BASE.confirmation, confirmedDate: 'yesterday' } }, allow: false, because: 'no valid date' },
  { name: 'a PENDING Resolution Center check blocks',
    f: { ...BASE, confirmation: { ...BASE.confirmation, status: 'pending', confirmedBy: '', confirmedDate: '' } },
    allow: false, because: 'not confirmed' },
  { name: 'a record with no status at all blocks (fails closed)',
    f: { ...BASE, confirmation: { withdrawnBuild: '258', confirmedBy: 'Zac', confirmedDate: '2026-09-23' } },
    allow: false, because: 'not confirmed' },
  { name: 'confirmation naming nobody blocks',
    f: { ...BASE, confirmation: { ...BASE.confirmation, confirmedBy: '  ' } }, allow: false, because: 'names nobody' },
];

let failed = 0;
for (const c of cases) {
  const got = decideSelfWithdrawn(c.f);
  // ASSERT THE REASON, NOT JUST THE VERDICT. Every case spoils one field, so a
  // block for any OTHER reason means the condition under test never ran and the
  // case is green by accident. That is not hypothetical: the unreadable-build
  // case first passed by tripping the confirmation check, because Number(null)
  // is 0 and the build test it was written for never fired.
  const ok = got.allow === c.allow && (c.allow || !c.because || new RegExp(c.because).test(got.reason));
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  if (!ok) console.log(`        expected allow=${c.allow}${c.because ? ` because /${c.because}/` : ''}, got allow=${got.allow} (${got.reason || got.line})`);
  else if (!c.allow) console.log(`        blocked because: ${got.reason}`);
}

// The confirmation on disk must actually be the one the live path will read —
// a green suite over inline fixtures says nothing about the real file.
const live = readConfirmation('1.3.38');
if (!live) { console.log('FAIL  live confirmation for 1.3.38 is missing from disk'); failed++; }
else {
  // THE ON-DISK RECORD IS PENDING BY DESIGN. Zac's personal Resolution Center
  // check has been asked for and not answered, so the live file must NOT
  // authorize anything — 259 went out on the relayed ruling ahead of it.
  // When he answers "clear", this flips to confirmed and this assertion
  // inverts; that is the point of asserting it either way rather than not at all.
  const d = decideSelfWithdrawn({ ...BASE, confirmation: live });
  const pending = live.status !== 'confirmed';
  console.log(`${d.allow === !pending ? 'PASS' : 'FAIL'}  the ON-DISK record (status=${live.status}) ${pending ? 'does NOT authorize' : 'authorizes'} 1.3.38/259`);
  if (d.allow !== !pending) { console.log(`        ${d.reason || d.line}`); failed++; }
  else if (pending) console.log(`        blocked because: ${d.reason}`);
  const stale = decideSelfWithdrawn({ ...BASE, buildNum: '260', attachedBuild: '259', confirmation: live });
  console.log(`${stale.allow ? 'FAIL' : 'PASS'}  the ON-DISK confirmation does NOT carry over to a future withdrawal`);
  if (stale.allow) failed++;
}

console.log(failed ? `\nRED: ${failed} case(s) failed.` : '\nAll cases behaved as specified.');
process.exit(failed ? 1 : 0);
