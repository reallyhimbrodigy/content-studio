#!/usr/bin/env node
'use strict';
/**
 * LANE 1 / JUDGE — Step 2: the fulfillment judge.
 *
 * For each completed job carrying an edit_recipe, one cheap LLM call that:
 *   1. decomposes vibe_input (+ change_request) into discrete asks
 *   2. verdicts each ask against RECIPE EVIDENCE (extracted in code, compact)
 *      + capability_notes:
 *        HONORED            — evidence in the recipe supports it
 *        DROPPED_WITH_NOTE  — absent from recipe, named in capability_notes
 *        DROPPED_SILENTLY   — absent from both  << the headline metric
 *        UNSUPPORTED        — matches the known unsupported list
 *   3. emits per-job honor fraction + flags
 *
 * Persistence: JSONL (out/fulfillment_scores.jsonl), resumable by job_id.
 * Table insert happens after TRUTH applies supabase/migrations/20260810_
 * fulfillment_scores.sql (non-interactive DDL is not possible from this
 * machine: pooler-url carries no password, pg module absent [MEASURED]).
 *
 * READ-ONLY against production tables. Zero Modal spend. LLM budget <= $10
 * pre-approved; actual spend is computed from usage and printed.
 *
 * Modes:
 *   node scripts/fulfillment-judge.js --sample 30     # stratified calibration sample
 *   node scripts/fulfillment-judge.js --full          # whole back catalog
 *   node scripts/fulfillment-judge.js --since <iso>   # incremental (scoreboard cron uses this)
 *   node scripts/fulfillment-judge.js --report        # aggregate JSONL -> report
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), quiet: true });
if (!process.env.SUPABASE_URL) require('dotenv').config({ path: '/Users/zaclibman/content-studio/.env.local', quiet: true });

const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const MODEL = 'claude-haiku-4-5-20251001';
const OUT_DIR = path.join(__dirname, '..', 'out');
const OUT = path.join(OUT_DIR, 'fulfillment_scores.jsonl');
const JUDGE_VERSION = 1;
// Haiku 4.5 list pricing (USD per Mtok). [CODE-EXTERNAL] anthropic pricing page.
const PRICE_IN = 1.0, PRICE_OUT = 5.0;

// ── data pulls ──────────────────────────────────────────────────────────
async function pageAll(pathq) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${URL_}/rest/v1/${pathq}&limit=1000&offset=${off}`, { headers: H });
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error(JSON.stringify(rows).slice(0, 300));
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function pullCohort(sinceIso) {
  const since = sinceIso ? `&created_at=gte.${sinceIso}` : '';
  return pageAll(
    `video_jobs?status=eq.completed&edit_recipe=not.is.null${since}` +
    `&select=id,created_at,vibe_input,change_request,edit_recipe,notes:result->capability_notes,route:result->>route&order=created_at.asc`
  );
}

// ── preset detection (code, not LLM): any vibe string used by >=20 jobs ──
function detectPresets(jobs) {
  const c = {};
  for (const j of jobs) { const v = (j.vibe_input || '').trim(); c[v] = (c[v] || 0) + 1; }
  return new Set(Object.entries(c).filter(([, n]) => n >= 20).map(([v]) => v));
}

// ── evidence extraction — BOTH recipe shapes, compact for the prompt ────
function extractEvidence(j) {
  const er = j.edit_recipe || {};
  const ev = { shape: 'full', route: j.route || 'standard_editorial' };
  const arr = (x) => (Array.isArray(x) ? x : []);
  if (er.plan && er.route) {                       // LEAN shape {plan, route, reason}
    const p = er.plan || {};
    ev.shape = 'lean';
    ev.route = er.route;
    ev.lean_reason = er.reason || null;
    ev.n_clips = arr(p.clips).length;
    ev.zoom_types = [...new Set(arr(p.clips).map(c => c && c.zoom).filter(Boolean))];
    ev.n_zooms = arr(p.clips).filter(c => c && c.zoom).length;
    ev.speed_changes = arr(p.clips).some(c => c && c.speed && c.speed !== 1);
    ev.n_transitions = arr(p.transitions).length;
    ev.transition_types = [...new Set(arr(p.transitions).map(t => t && (t.type || t.name)).filter(Boolean))];
    ev.n_motion_graphics = arr(p.motion_graphics).length;
    ev.mg_types = [...new Set(arr(p.motion_graphics).map(m => m && (m.type || m.name)).filter(Boolean))];
    ev.outro = p.outro || null;
    // lean routes render no captions/sfx/broll/text overlays by construction
    ev.caption_style = null; ev.n_sfx = 0; ev.n_broll = 0; ev.n_text_overlays = 0; ev.n_emphasis = 0;
  } else {                                          // FULL editorial shape
    ev.caption_style = er.caption_style || null;
    ev.n_cuts = arr(er.cuts).length;
    const em = arr(er.emphasis_moments).length ? arr(er.emphasis_moments) : arr(er._emphasis_moments);
    ev.n_emphasis = em.length;
    ev.zoom_types = [...new Set(em.map(e => e && (e.zoom || (e.layers || []).find?.(l => /zoom/i.test(String(l))))).flat().filter(Boolean).map(String))];
    ev.n_motion_graphics = arr(er.motion_graphics).length;
    ev.mg_types = [...new Set(arr(er.motion_graphics).map(m => m && (m.type || m.name || m.component)).filter(Boolean))];
    ev.n_text_overlays = arr(er.text_overlays).length;
    ev.n_transitions = arr(er.transitions).length;
    ev.transition_types = [...new Set(arr(er.transitions).map(t => t && (t.type || t.name)).filter(Boolean))];
    ev.n_broll = arr(er.broll_clips).length;
    ev.n_sfx = arr(er.sound_effects).length ? arr(er.sound_effects).length : arr(er._parsed_sound_effects).length;
    ev.n_generated_scenes = arr(er.generated_scenes).length;
    ev.outro = er.outro || null;
    ev.color_effect = er.color_effect ?? null;
    ev.aspect_ratio = er.aspect_ratio ?? null;
    ev.audio_denoise = er.audio_denoise ?? null;
    ev.pacing = er.pacing ?? null;
    ev.post_caption = er.post_caption ? String(er.post_caption).slice(0, 120) : null;
    ev.n_removed_words = arr(er._removed_word_indices).length;
    ev.notes_field = er.notes ? String(er.notes).slice(0, 200) : null;
  }
  return ev;
}

// ── the judge call ──────────────────────────────────────────────────────
const SYSTEM = `You are a strict fulfillment auditor for an AI video-editing app. A user typed a request; the pipeline produced an edit plan ("recipe evidence" below, extracted mechanically) and optionally "capability_notes" (an honesty channel shown to the user naming things it could not do).

Your job: decompose the request into discrete asks, then verdict each ask.

ASK CLASSES: style_preset, pacing_speed, captions, captions_language, zoom, sound_effects, motion_graphics, broll, text_overlay, end_card, cut_content (remove/keep specific moments or words), specific_moment_edit, color_grade, music, voiceover, aspect_ratio, logo_watermark, generative_ai (generate images/scenes/avatars), transitions, audio_cleanup, other.

VERDICTS:
- HONORED: the recipe evidence plausibly delivers the ask (e.g. ask "add zooms" + n_zooms>0; ask "captions" + caption_style set; a pure style ask like "viral engaging" is HONORED when the recipe shows active editing consistent with it: cuts/zooms/emphasis/sfx present).
- DROPPED_WITH_NOTE: the evidence does NOT deliver it, but a capability_note names that limitation.
- DROPPED_SILENTLY: the evidence does not deliver it AND no note mentions it. THE key failure.
- UNSUPPORTED: the ask is on the known-unsupported list: color grading/LUT looks, background music, voiceover/TTS, aspect-ratio change, logo/watermark, AI image/scene generation. Use UNSUPPORTED for these regardless of notes; set "noted" true/false for whether a note covered it.

RULES:
- Preset-style requests ("Viral engaging video", "Professional corporate style" etc.) decompose into ONE style-level ask (plus pacing if named, e.g. "Fast paced punchy" = style + pacing_speed).
- Specific, plain-language asks decompose fully: "add captions in Spanish and zoom on the word finally" = captions_language ask + specific zoom ask.
- Judge ONLY against the evidence given. Do not assume unlisted recipe content exists.
- Content descriptions (a user describing what the video shows, e.g. "King going to another palace") are NOT asks; ignore them. Non-English requests: translate, then decompose normally.
- Lean-route evidence (shape:"lean") renders NO captions/sfx/broll/text overlays by construction — asks for those on a lean recipe are DROPPED (with or without note as evidence shows).
- Be literal and conservative: when evidence is genuinely ambiguous for an ask, verdict DROPPED_SILENTLY rather than crediting HONORED.
- Resolution/quality-enhancement asks ("4k", "8k", "HD", "sharpen") are NOT on the unsupported list: verdict DROPPED_SILENTLY (class "other") unless evidence shows upscaling.
- If the request contains ONLY content description and no editing ask at all, emit ZERO asks (empty array) — never invent an ask to honor.
- Translation/caption-language requests (any phrasing: "in English", "translate", "captions in Hindi") are class captions_language.`;

const TOOL = {
  name: 'record_judgment',
  description: 'Record the fulfillment judgment for one job.',
  input_schema: {
    type: 'object',
    properties: {
      is_preset_style_only: { type: 'boolean', description: 'true if the request is only a generic style preset with no specific asks' },
      asks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'the ask, quoted or tightly paraphrased from the request' },
            class: { type: 'string' },
            verdict: { type: 'string', enum: ['HONORED', 'DROPPED_WITH_NOTE', 'DROPPED_SILENTLY', 'UNSUPPORTED'] },
            noted: { type: 'boolean', description: 'a capability_note covered this ask' },
            evidence: { type: 'string', description: 'one line: which evidence field(s) decided the verdict' },
          },
          required: ['text', 'class', 'verdict', 'noted', 'evidence'],
        },
      },
      flags: { type: 'array', items: { type: 'string' }, description: 'anomalies worth surfacing (e.g. request unintelligible, notes contradict recipe)' },
    },
    required: ['is_preset_style_only', 'asks'],
  },
};

let usageIn = 0, usageOut = 0;
async function judgeOne(job, evidence, isPreset) {
  const user = [
    `USER REQUEST (vibe_input): ${JSON.stringify(job.vibe_input || '')}`,
    job.change_request ? `RE-EDIT CHANGE REQUEST: ${JSON.stringify(job.change_request)}` : null,
    `PRESET-MATCH (exact string used by >=20 jobs): ${isPreset}`,
    `RECIPE EVIDENCE: ${JSON.stringify(evidence)}`,
    `CAPABILITY_NOTES: ${JSON.stringify(job.notes || [])}`,
  ].filter(Boolean).join('\n');
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1500, system: SYSTEM,
        tools: [TOOL], tool_choice: { type: 'tool', name: 'record_judgment' },
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, attempt * 2000)); continue; }
    const body = await r.json();
    if (body.error) throw new Error(`${job.id}: ${body.error.message}`);
    usageIn += (body.usage && body.usage.input_tokens) || 0;
    usageOut += (body.usage && body.usage.output_tokens) || 0;
    const tu = (body.content || []).find(c => c.type === 'tool_use');
    if (!tu) throw new Error(`${job.id}: no tool_use in response`);
    return tu.input;
  }
  throw new Error(`${job.id}: exhausted retries`);
}

function toRow(job, evidence, isPreset, jm) {
  const asks = Array.isArray(jm.asks) ? jm.asks : [];
  const n = (v) => asks.filter(a => a.verdict === v).length;
  return {
    job_id: job.id, judged_at: new Date().toISOString(), judge_model: MODEL, judge_version: JUDGE_VERSION,
    is_preset: !!isPreset, route: evidence.route,
    n_asks: asks.length, n_honored: n('HONORED'), n_dropped_with_note: n('DROPPED_WITH_NOTE'),
    n_dropped_silently: n('DROPPED_SILENTLY'), n_unsupported: n('UNSUPPORTED'),
    honor_rate: asks.length ? +(n('HONORED') / asks.length).toFixed(3) : null,
    asks, flags: jm.flags || [], is_preset_style_only: !!jm.is_preset_style_only,
    vibe_input: job.vibe_input, change_request: job.change_request, created_at: job.created_at,
  };
}

// ── aggregate report from JSONL ─────────────────────────────────────────
function report() {
  const rows = fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const dedup = new Map(rows.map(r => [r.job_id, r])); // last judgment wins
  const R = [...dedup.values()];
  const allAsks = R.flatMap(r => r.asks.map(a => ({ ...a, is_preset: r.is_preset, route: r.route })));
  const n = (p) => allAsks.filter(p).length;
  const pc = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : 'n/a');
  console.log(`jobs judged: ${R.length}   asks total: ${allAsks.length}`);
  console.log(`\nVERDICT MIX (all asks):`);
  for (const v of ['HONORED', 'DROPPED_WITH_NOTE', 'DROPPED_SILENTLY', 'UNSUPPORTED'])
    console.log(`  ${v.padEnd(20)} ${n(a => a.verdict === v)} (${pc(n(a => a.verdict === v), allAsks.length)})`);
  const custom = allAsks.filter(a => !a.is_preset);
  console.log(`\nCUSTOM-REQUEST asks only (n=${custom.length}):`);
  for (const v of ['HONORED', 'DROPPED_WITH_NOTE', 'DROPPED_SILENTLY', 'UNSUPPORTED'])
    console.log(`  ${v.padEnd(20)} ${custom.filter(a => a.verdict === v).length} (${pc(custom.filter(a => a.verdict === v).length, custom.length)})`);
  console.log(`\nHEADLINE dropped-silently rate: ALL ${pc(n(a => a.verdict === 'DROPPED_SILENTLY'), allAsks.length)} | CUSTOM ${pc(custom.filter(a => a.verdict === 'DROPPED_SILENTLY').length, custom.length)}`);
  // per class
  const byClass = {};
  for (const a of allAsks) {
    const c = (byClass[a.class] = byClass[a.class] || { n: 0, hon: 0, silent: 0, note: 0, unsup: 0 });
    c.n++; if (a.verdict === 'HONORED') c.hon++; if (a.verdict === 'DROPPED_SILENTLY') c.silent++;
    if (a.verdict === 'DROPPED_WITH_NOTE') c.note++; if (a.verdict === 'UNSUPPORTED') c.unsup++;
  }
  console.log('\nPER ASK-CLASS (sorted by dropped-silently count):');
  console.log('class                    n    honored  d-note  D-SILENT  unsup');
  for (const [c, v] of Object.entries(byClass).sort((a, z) => z[1].silent - a[1].silent))
    console.log(`${c.padEnd(24)}${String(v.n).padStart(4)}   ${String(v.hon).padStart(5)}   ${String(v.note).padStart(5)}   ${String(v.silent).padStart(6)}   ${String(v.unsup).padStart(4)}`);
  // top dropped ask texts
  const dropped = allAsks.filter(a => a.verdict === 'DROPPED_SILENTLY' || a.verdict === 'UNSUPPORTED');
  const dc = {};
  for (const a of dropped) { const k = `${a.class}: ${a.text.toLowerCase().slice(0, 60)}`; dc[k] = (dc[k] || 0) + 1; }
  console.log('\nTOP 20 DROPPED ASKS (silent + unsupported):');
  Object.entries(dc).sort((a, z) => z[1] - a[1]).slice(0, 20).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}x  ${k}`));
}

// ── main ────────────────────────────────────────────────────────────────
(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--report')) return report();
  if (!ANTHROPIC_KEY) throw new Error('no ANTHROPIC_API_KEY/CLAUDE_API_KEY in env');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sampleIx = args.indexOf('--sample');
  const sinceIx = args.indexOf('--since');
  const sinceIso = sinceIx >= 0 ? args[sinceIx + 1] : null;

  console.log('pulling cohort…');
  let jobs = await pullCohort(sinceIso);
  console.log(`cohort: ${jobs.length} completed recipe-bearing jobs${sinceIso ? ` since ${sinceIso}` : ''}`);
  const presets = detectPresets(await pullCohort(null));   // presets detected on the FULL corpus always
  console.log(`preset strings (>=20 uses): ${presets.size}`);

  const done = new Set(
    fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).job_id) : []
  );
  jobs = jobs.filter(j => !done.has(j.id));
  console.log(`remaining after resume-skip: ${jobs.length}`);

  if (sampleIx >= 0) {
    const nWant = parseInt(args[sampleIx + 1] || '30', 10);
    // stratified: half custom (non-preset), half preset; random within strata
    const custom = jobs.filter(j => !presets.has((j.vibe_input || '').trim()));
    const preset = jobs.filter(j => presets.has((j.vibe_input || '').trim()));
    const pick = (a, k) => a.sort(() => Math.random() - 0.5).slice(0, k);
    jobs = [...pick(custom, Math.ceil(nWant * 0.67)), ...pick(preset, Math.floor(nWant * 0.33))];
    console.log(`calibration sample: ${jobs.length} (custom-heavy 2:1)`);
  }

  let doneN = 0, errN = 0;
  const CONC = 6;
  const queue = [...jobs];
  const workers = Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const job = queue.shift();
      try {
        const isPreset = presets.has((job.vibe_input || '').trim());
        const ev = extractEvidence(job);
        const jm = await judgeOne(job, ev, isPreset);
        const row = toRow(job, ev, isPreset, jm);
        fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
        doneN++;
        if (doneN % 50 === 0) console.log(`  …${doneN} judged (in=${usageIn} out=${usageOut} tok, ~$${(usageIn / 1e6 * PRICE_IN + usageOut / 1e6 * PRICE_OUT).toFixed(2)})`);
      } catch (e) { errN++; console.error(`  ERR ${job.id.slice(0, 8)}: ${e.message.slice(0, 140)}`); }
    }
  });
  await Promise.all(workers);
  const cost = usageIn / 1e6 * PRICE_IN + usageOut / 1e6 * PRICE_OUT;
  console.log(`\nDONE: ${doneN} judged, ${errN} errors. Tokens in=${usageIn} out=${usageOut}. LLM COST THIS RUN: $${cost.toFixed(2)} (model ${MODEL})`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
