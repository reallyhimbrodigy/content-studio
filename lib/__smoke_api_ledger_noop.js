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

function book(route, code, flag) {
  if (flag === null) delete process.env.PROMPTLY_CHAT_ACTIONS;
  else process.env.PROMPTLY_CHAT_ACTIONS = flag;
  L.drain();                                   // start clean
  L.record('POST', route, code, 'user-a');
  const rows = L.drain();
  return rows.filter((r) => r.route === route && r.code === code)[0] || null;
}

// 1. DARK: the deliberate 404 is STILL COUNTED — it stays in the failure total —
//    and it is TAGGED so a reader can separate it on purpose.
//    Subtracting it instead was the bug: __smoke_api_ledger's cap probe caught
//    13197 against 13200 the moment the total stopped meaning what it says.
{
  const r = book(R, 404, null);
  if (!r) bad.push('the deliberate 404 is no longer counted at all — a total that silently '
                 + 'excludes some failures is worse than one that includes a no-op');
  else {
    if (r.n !== 1) bad.push(`the deliberate 404 counted ${r.n}, expected 1`);
    if (!r.noop) bad.push('the deliberate 404 is counted but NOT tagged `noop` — indistinguishable '
                        + 'from a real failure, which is what cost a full investigation');
  }
}

// 2. ARMED: the SAME 404 is a real failure. Counted, and NOT tagged.
{
  const r = book(R, 404, '1');
  if (!r) bad.push('with PROMPTLY_CHAT_ACTIONS ON, a 404 on /api/chat/actions is not counted');
  else if (r.noop) bad.push('with the flag ON, a 404 there is still tagged as a no-op — the route '
                          + 'should be answering, so the tag has become permanent cover for a real bug');
}

// 3. the tag is narrow: only that route, only 404.
{
  const r = book(R, 500, null);
  if (!r || r.noop) bad.push('a 500 on /api/chat/actions is being tagged as a no-op — only the '
                           + 'deliberate 404 qualifies');
}
{
  const r = book('/api/chat', 404, null);
  if (!r || r.noop) bad.push('a 404 on /api/chat is being tagged — the tag has widened beyond its route');
}

// 4. positive control: the ledger still records ordinary failures. Without this,
//    every assertion above could pass against a dead instrument.
{
  const r = book('/api/health', 500, null);
  if (!r) bad.push('the ledger records nothing at all — the instrument is dead and every '
                 + 'assertion above is meaningless');
}

if (bad.length) {
  console.log('api-ledger-noop: FAIL');
  for (const b of bad) console.log('  -', b);
  process.exit(1);
}
console.log('  the deliberate 404 stays IN the total and carries `noop` while the flag is dark; '
  + 'armed it is an untagged failure; 500s and other routes untagged; the ledger still records.');
console.log('api-ledger-noop: PASS');
