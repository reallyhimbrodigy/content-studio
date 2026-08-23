'use strict';
// GATE SMOKE — empty means neither text NOR attachment, and parts[0] is never
// the whole answer.
//
// `/api/chat` read parts[0].text and 502'd on !reply.trim(). That carried two
// defects: a thinking model's THOUGHT part landing at parts[0] turned a good
// answer into `502 empty_ai_reply` (live, no media required), and defining
// empty as "no text" made an image-only reply an error by construction.
//
// The streaming path had ALREADY fixed the parts walk and said why in a comment.
// The one-shot path never got it. Two entrances, one behaviour — this asserts
// they agree, because they have drifted before.
const assert = require('assert');
const { decodeChatCandidate, isEmptyReply } = require('./chat-reply');
const fs = require('fs');
const path = require('path');
const c = (parts) => ({ content: { parts } });

// 1. THE RE-SCOPE. An attachment with no text is NOT empty.
assert.strictEqual(
  isEmptyReply(decodeChatCandidate(c([{ inlineData: { data: 'x', mimeType: 'image/png' } }]))),
  false,
  'an image-only candidate was treated as EMPTY — that is the defect: it makes '
  + 'every later multimodal part impossible, because the reply 502s before it '
  + 'can be returned');

// 2. THE 502 SURVIVES for a genuinely empty candidate — a safety block must
//    still throw so the client retry handler fires.
assert.strictEqual(isEmptyReply(decodeChatCandidate(c([]))), true,
  'a genuinely empty candidate must still be an error, never a 200 with a blank reply');
assert.strictEqual(isEmptyReply(decodeChatCandidate(null)), true,
  'a missing candidate must be an error');
assert.strictEqual(isEmptyReply(decodeChatCandidate(c([{ text: '   ' }]))), true,
  'whitespace-only text is empty');

// 3. THE LIVE BUG: a thought part must not eat the answer.
const d = decodeChatCandidate(c([{ thought: true, text: 'reasoning' }, { text: 'the answer' }]));
assert.strictEqual(d.text, 'the answer',
  'a THOUGHT part at parts[0] swallowed the real answer — this is the live '
  + '502-on-a-good-reply bug the streaming path already fixed');
assert.strictEqual(isEmptyReply(d), false);

// 4. Thought-only is empty, but DISTINGUISHABLE — it is a real failure mode
//    ("the model reasoned and never answered") and folding it into one opaque
//    502 is how it stays invisible.
const t = decodeChatCandidate(c([{ thought: true, text: 'reasoning' }]));
assert.strictEqual(isEmptyReply(t), true);
assert.strictEqual(t.thoughtOnly, true, 'thought-only must be countable separately');

// 5. Text is CONCATENATED across parts, not taken from the first.
assert.strictEqual(decodeChatCandidate(c([{ text: 'a' }, { text: 'b' }])).text, 'ab',
  'text must join across all parts');

// 6. THE TWO ENTRANCES MUST NOT DRIFT. The one-shot path must use the shared
//    decoder rather than re-reading parts[0] inline.
const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.ok(/decodeChatCandidate\(geminiData\?\.candidates\?\.\[0\]\)/.test(srv),
  'the one-shot chat path is not using the shared decoder');
assert.ok(!/const reply = geminiData\?\.candidates\?\.\[0\]\?\.content\?\.parts\?\.\[0\]\?\.text/.test(srv),
  'the old parts[0].text read is back on the one-shot path');

console.log('chat-reply smoke: 6/6 OK');
