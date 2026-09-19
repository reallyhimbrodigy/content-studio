'use strict';
// D3 — FULFILMENT JUDGE v2, for the agentic (ChatCut) lane's run records.
//
// OFFLINE ONLY. Reads stored run records; never invokes the pipeline, never
// writes to Supabase. Haiku, budgeted at <= $0.01 per run.
//
// It answers ONE question per ask: did the user get it, was the user TOLD, or
// did it vanish. The last is the failure this lane exists to drive to zero.
//
// INHERITED from the Aug-10 fulfilment judge (scripts/fulfillment-judge.js):
// tool-use decomposition with a forced schema, the ask-class vocabulary, and
// the discipline of judging ONLY against supplied evidence. CHANGED: the
// verdict set. The old judge's DROPPED_WITH_NOTE described a note attached
// AFTER a render was already spent. NEGOTIATED here means the user was told
// BEFORE the render — a different event, so it gets a different name rather
// than the old name quietly widened.
const fs = require('fs');
const ENV = require('./env.js')();
const KEY = ENV.ANTHROPIC_API_KEY || ENV.CLAUDE_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';
const PRICE_IN = 1.0, PRICE_OUT = 5.0;
const JUDGE_VERSION = 'agentic-v2';

// ── EVIDENCE EXTRACTION ────────────────────────────────────────────────────
// A missing field is ABSENT, never an empty result. The v1 judge read zoom
// evidence off a key that full-editorial recipes do not carry and reported an
// 88% drop rate that was an artifact; 823 jobs had to be re-judged. The fix
// there was to coalesce both locations AND to say when neither exists.
const REQUIRED = ['brief', 'ops', 'timeline'];

function extractEvidence(rec) {
  const missing = REQUIRED.filter(k => rec[k] === undefined || rec[k] === null);
  if (missing.length) {
    return { state: 'ABSENT', missing, why: `run record lacks ${missing.join(', ')} — a judgment built on this would be a guess wearing a verdict's clothes` };
  }
  const ops = Array.isArray(rec.ops) ? rec.ops : [];
  const tl = rec.timeline || {};
  return {
    state: 'MEASURED',
    n_ops: ops.length,
    op_tools: [...new Set(ops.map(o => o.tool).filter(Boolean))],
    // THE `why` IS THE NEGOTIATION CHANNEL. An op that says "cannot add music,
    // proceeding without" is the difference between NEGOTIATED and DROPPED,
    // and it is the only place the agent can say so.
    op_whys: ops.map(o => o.why).filter(Boolean),
    agent_reply: typeof rec.agent_reply === 'string' ? rec.agent_reply : null,
    caption_track: tl.caption_track === undefined ? 'ABSENT' : tl.caption_track,
    caption_language: tl.caption_language === undefined ? 'ABSENT' : tl.caption_language,
    components: Array.isArray(tl.components) ? tl.components : [],
    items: Array.isArray(tl.items) ? tl.items.length : 'ABSENT',
    duration_s: tl.duration_s === undefined ? 'ABSENT' : tl.duration_s,
    audio_tracks: Array.isArray(tl.audio_tracks) ? tl.audio_tracks : 'ABSENT',
    rewatch: Array.isArray(rec.rewatch) ? rec.rewatch : 'ABSENT',
  };
}

const SYSTEM = `You audit whether an AI video editor delivered what a user asked for. You see the user's brief, the operations the agent performed (each with the agent's own "why"), the final timeline state, and any rewatch verdicts.

Decompose the brief into discrete asks, then verdict each one.

ASK CLASSES: style_preset, pacing_speed, captions, captions_language, zoom, sound_effects, motion_graphics, broll, text_overlay, end_card, cut_content, specific_moment_edit, color_grade, music, voiceover, aspect_ratio, logo_watermark, generative_ai, transitions, audio_cleanup, other.

VERDICTS — exactly one per ask:
- HONORED: the timeline evidence delivers it. Captions asked and caption_track is present; "add zooms" and zoom components are placed; a cut asked and the duration changed.
- NEGOTIATED: the evidence does NOT deliver it AND the agent SAID SO — an op "why" or the agent_reply names this specific limitation ("cannot add music, proceeding without"). The user was told. This is a success of honesty, not of delivery.
- DROPPED_SILENTLY: the evidence does not deliver it and NOTHING told the user. THE failure this audit exists to find.
- UNSUPPORTED_NAMED: the ask is for something the pipeline categorically cannot do (music, generative VFX, upscale, stock b-roll, voiceover/TTS, aspect-ratio change, colour grade) AND the agent named it as unsupported. If it is categorically impossible and the agent did NOT name it, that is DROPPED_SILENTLY, not this.

RULES
- Judge ONLY against the evidence shown. Never assume a timeline contains something not listed.
- A CONSTRAINT is honored by ABSENCE. "no captions" + caption_track absent = HONORED. "no captions" + a caption track present = DROPPED_SILENTLY, because the user's instruction was overridden. Constraints are the easiest ask to mis-score: read them backwards from the usual direction.
- A LANGUAGE ask is honored only if the language matches. "captions in Hinglish" + caption_track present but caption_language "en" = DROPPED_SILENTLY. A caption track alone does NOT honor a language ask.
- Content description with no ask contributes no asks.
- When evidence is genuinely ambiguous, prefer DROPPED_SILENTLY over HONORED. An audit that flatters the pipeline is worth nothing.
- "noted_where" must quote the words that did the telling, or be null. A NEGOTIATED verdict with nothing quoted is not negotiated.`;

const TOOL = {
  name: 'record_fulfilment',
  input_schema: {
    type: 'object',
    properties: {
      asks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            class: { type: 'string' },
            verdict: { type: 'string', enum: ['HONORED', 'NEGOTIATED', 'DROPPED_SILENTLY', 'UNSUPPORTED_NAMED'] },
            evidence: { type: 'string', description: 'which evidence field decided it' },
            noted_where: { type: ['string', 'null'], description: 'the words that told the user, quoted; null if nothing did' },
          },
          required: ['text', 'class', 'verdict', 'evidence', 'noted_where'],
        },
      },
    },
    required: ['asks'],
  },
};

let uIn = 0, uOut = 0;
async function judgeRun(rec) {
  const ev = extractEvidence(rec);
  if (ev.state === 'ABSENT') return { state: 'ABSENT', evidence: ev, asks: [] };
  const user = [
    `BRIEF: ${JSON.stringify(rec.brief)}`,
    `OPS (${ev.n_ops}): ${JSON.stringify(rec.ops)}`,
    `TIMELINE: ${JSON.stringify(ev)}`,
    rec.agent_reply ? `AGENT REPLY TO USER: ${JSON.stringify(rec.agent_reply)}` : 'AGENT REPLY TO USER: (none recorded)',
  ].join('\n');
  for (let a = 1; a <= 4; a++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 2000, system: SYSTEM,
        tools: [TOOL], tool_choice: { type: 'tool', name: 'record_fulfilment' },
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, a * 2000)); continue; }
    const b = await r.json();
    if (b.error) throw new Error(b.error.message);
    uIn += (b.usage || {}).input_tokens || 0; uOut += (b.usage || {}).output_tokens || 0;
    const tu = (b.content || []).find(c => c.type === 'tool_use');
    if (!tu) throw new Error('no tool_use');
    const asks = tu.input.asks || [];
    // A NEGOTIATED VERDICT WITH NOTHING QUOTED IS NOT NEGOTIATED. Demoted here
    // rather than trusted, because this is the one verdict that turns a
    // failure into a success and so is the one worth policing.
    for (const k of asks) {
      if ((k.verdict === 'NEGOTIATED' || k.verdict === 'UNSUPPORTED_NAMED') && !k.noted_where) {
        k.verdict = 'DROPPED_SILENTLY';
        k.evidence = (k.evidence || '') + ' [demoted: claimed the user was told, quoted nothing]';
      }
    }
    const n = asks.length || 1;
    return {
      state: 'MEASURED', judge_version: JUDGE_VERSION, evidence: ev, asks,
      honor_rate: +(asks.filter(k => k.verdict === 'HONORED').length / n).toFixed(3),
      silent_drop_rate: +(asks.filter(k => k.verdict === 'DROPPED_SILENTLY').length / n).toFixed(3),
    };
  }
  throw new Error('exhausted retries');
}

function cost() { return uIn * PRICE_IN / 1e6 + uOut * PRICE_OUT / 1e6; }
module.exports = { judgeRun, extractEvidence, cost, JUDGE_VERSION };

if (require.main === module) {
  (async () => {
    const recs = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
    const out = [];
    for (const r of recs) out.push({ id: r.id, ...(await judgeRun(r)) });
    console.log(JSON.stringify(out, null, 1));
    console.error(`cost $${cost().toFixed(4)} over ${recs.length} run(s) = $${(cost() / recs.length).toFixed(4)}/run`);
  })();
}
