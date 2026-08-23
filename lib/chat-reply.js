'use strict';

// Decode one Gemini chat candidate into {text, attachments}.
//
// TWO DEFECTS IN ONE LINE. `/api/chat` read `candidates[0].content.parts[0].text`
// and 502'd on `!reply.trim()`:
//
//   1. LIVE BUG, today, with no media anywhere. A thinking model emits a THOUGHT
//      part alongside the answer part in the same candidate. If the thought
//      lands at parts[0], `reply` is '' and a perfectly good answer becomes
//      `502 empty_ai_reply`. The STREAMING path already fixed exactly this
//      (server.js: "reading only parts[0] would drop the answer") — the one-shot
//      path never got the same treatment. Two entrances, one fix, applied once.
//
//   2. It defines "empty" as "no text", so an image-only reply is an error by
//      construction. That blocks every later part of the multimodal work.
//
// SCOPE: this module DECODES. It does not persist, upload, or mint URLs —
// attachments are returned as the raw inline parts so the caller decides. The
// image-persistence half is deliberately held until the CloudFront signing
// question is answered (an unsigned-mode presign returns a permanent public
// link, byte-identical to a public URL).
//
// INERT TODAY: nothing sends media IN yet, so the model cannot send an image
// OUT, so `attachments` is always []. The predicate is correct now and stays
// correct when media starts flowing — it is pre-positioned, not speculative.

/**
 * @param {object} candidate - candidates[0] from a Gemini response
 * @returns {{text: string, attachments: Array<object>, thoughtOnly: boolean}}
 */
function decodeChatCandidate(candidate) {
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return { text: '', attachments: [], thoughtOnly: false };

  let sawThought = false;
  const textPieces = [];
  const attachments = [];

  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    // A thought part is the model's reasoning, never the user's answer. Same
    // filter the streaming path uses; kept identical on purpose so the two
    // entrances cannot drift again.
    if (p.thought) { sawThought = true; continue; }
    if (typeof p.text === 'string' && p.text) { textPieces.push(p.text); continue; }
    const inline = p.inlineData || p.inline_data;
    if (inline && (inline.data || inline.mimeType || inline.mime_type)) {
      attachments.push(inline);
    }
  }
  return {
    text: textPieces.join(''),
    attachments,
    // Distinguishes "the model said nothing" from "the model only thought" —
    // the second is a real failure mode worth counting separately rather than
    // folding into one opaque 502.
    thoughtOnly: sawThought && textPieces.length === 0 && attachments.length === 0,
  };
}

/**
 * TRUE only when the candidate carries neither text nor an attachment.
 * The 502 must survive for a genuinely-empty candidate — a safety block or a
 * model hiccup has to throw so the client's retry handler fires.
 */
function isEmptyReply(decoded) {
  if (!decoded || typeof decoded !== 'object') return true;
  const text = typeof decoded.text === 'string' ? decoded.text : '';
  const atts = Array.isArray(decoded.attachments) ? decoded.attachments : [];
  return text.trim().length === 0 && atts.length === 0;
}

module.exports = { decodeChatCandidate, isEmptyReply };
