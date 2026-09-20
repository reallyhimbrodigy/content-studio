'use strict';
// A DELIBERATE 404 IS NOT A FAILURE — AND STOPS BEING DELIBERATE THE DAY THE
// FLAG COMES ON.
//
// /api/chat/actions returns 404 before auth while PROMPTLY_CHAT_ACTIONS is
// unset. The client maps it to .notFound and falls through to streaming chat,
// which is the dark design working. Counted as a failure it already cost one
// full investigation: 2,039 of these across 1,620 users made the primary chat
// endpoint read as broken for a quarter of the user base.
//
// The exemption is therefore CONDITIONAL. With the flag ON, a 404 there is a
// real failure — the route should be answering and is not — and an
// unconditional exemption would be permanent cover arriving silently on the day
// the feature ships. This smoke exercises the REAL record()/drain() rather than
// reading the source, because the property under test is behavioural: what does
// the ledger book, under each flag state.
//
// Exit 0 = clean. Exit 1 = a real failure is being hidden, or a no-op counted.
const assert = require('assert');
const L = require('./api-outcome-ledger');
const bad = [];
const R = '/api/chat/actions';

function bookedFor(route, code, flag) {
  if (flag === null) delete process.env.PROMPTLY_CHAT_ACTIONS;
  else process.env.PROMPTLY_CHAT_ACTIONS = flag;
  L.drain();                                   // start clean
  L.record('POST', route, code, 'user-a');
  const rows = L.drain();
  return rows.filter((r) => r.route === route && r.code === code).length;
}

// 1. DARK: the deliberate 404 is not booked as a failure.
if (bookedFor(R, 404, null) !== 0) {
  bad.push('with PROMPTLY_CHAT_ACTIONS dark, the deliberate 404 on /api/chat/actions is still '
         + 'booked as a failure — this is what made /api/chat read as broken for 1,620 users');
}

// 2. ARMED: the SAME 404 is a real failure and must be booked.
if (bookedFor(R, 404, '1') !== 1) {
  bad.push('with PROMPTLY_CHAT_ACTIONS ON, a 404 on /api/chat/actions is NOT booked — the route '
         + 'should be answering, so the exemption has become permanent cover for a real bug');
}

// 3. the exemption is narrow: only 404, only that route.
if (bookedFor(R, 500, null) !== 1) {
  bad.push('a 500 on /api/chat/actions is being swallowed — only the deliberate 404 is exempt');
}
if (bookedFor('/api/chat', 404, null) !== 1) {
  bad.push('a 404 on /api/chat is being swallowed — the exemption has widened beyond its route');
}

// 4. and the ledger still records ordinary failures at all (positive control:
//    a smoke whose every assertion is "did not record" passes on a dead instrument).
if (bookedFor('/api/health', 500, null) !== 1) {
  bad.push('the ledger records nothing at all — the instrument is dead and every '
         + '"not booked" assertion above is meaningless');
}

if (bad.length) {
  console.log('api-ledger-noop: FAIL');
  for (const b of bad) console.log('  -', b);
  process.exit(1);
}
console.log('  the deliberate 404 is exempt only while the flag is dark; armed, it books as a '
  + 'failure; 500s and other routes unaffected; the ledger still records.');
console.log('api-ledger-noop: PASS');
