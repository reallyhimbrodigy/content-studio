const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const COLOR_INTENTS = {
  none: { brightness: 0, contrast: 0, saturation: 0, gamma: 0, color_temperature: null },
  neutral: { brightness: 0, contrast: 0, saturation: 0, gamma: 0, color_temperature: 'neutral' },
  cinematic: { brightness: -0.02, contrast: 0.1, saturation: -0.1, gamma: -0.03, color_temperature: 'cool' },
  warm: { brightness: 0.01, contrast: 0.04, saturation: 0.06, gamma: 0, color_temperature: 'warm' },
  cozy: { brightness: 0.02, contrast: 0.03, saturation: 0.05, gamma: 0.02, color_temperature: 'warm' },
  cool: { brightness: 0, contrast: 0.04, saturation: -0.03, gamma: 0, color_temperature: 'cool' },
  moody: { brightness: -0.06, contrast: 0.14, saturation: -0.14, gamma: -0.08, color_temperature: 'cool' },
  vibrant: { brightness: 0.01, contrast: 0.08, saturation: 0.15, gamma: 0, color_temperature: null },
  punchy: { brightness: 0, contrast: 0.12, saturation: 0.1, gamma: -0.03, color_temperature: null },
  vivid: { brightness: 0.02, contrast: 0.08, saturation: 0.18, gamma: 0, color_temperature: null },
  clean: { brightness: 0, contrast: 0.05, saturation: 0.03, gamma: 0, color_temperature: 'neutral' },
  polished: { brightness: 0.01, contrast: 0.06, saturation: 0.04, gamma: 0, color_temperature: 'neutral' },
  enhanced: { brightness: 0, contrast: 0.08, saturation: 0.08, gamma: 0, color_temperature: null },
  faded: { brightness: 0.02, contrast: -0.08, saturation: -0.2, gamma: 0.04, color_temperature: 'warm' },
  vintage: { brightness: 0.01, contrast: -0.06, saturation: -0.16, gamma: 0.05, color_temperature: 'warm' },
  dramatic: { brightness: -0.04, contrast: 0.18, saturation: -0.05, gamma: -0.06, color_temperature: 'cool' },
  bold: { brightness: 0.01, contrast: 0.15, saturation: 0.14, gamma: -0.02, color_temperature: null },
  soft: { brightness: 0.03, contrast: -0.08, saturation: -0.05, gamma: 0.04, color_temperature: 'warm' },
  dreamy: { brightness: 0.04, contrast: -0.06, saturation: -0.08, gamma: 0.05, color_temperature: 'warm' },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeIntent(intentName) {
  const key = String(intentName || '').trim().toLowerCase();
  if (key && COLOR_INTENTS[key]) return key;
  if (key) console.warn(`[generate-edit] Unknown color_intent "${intentName}", falling back to "none"`);
  return 'none';
}

function buildColorGrade(baseline, intentName) {
  const safeBaseline = {
    brightness: typeof baseline?.brightness === 'number' ? baseline.brightness : 0,
    contrast: typeof baseline?.contrast === 'number' ? baseline.contrast : 1,
    saturation: typeof baseline?.saturation === 'number' ? baseline.saturation : 1,
    gamma: typeof baseline?.gamma === 'number' ? baseline.gamma : 1,
    color_temperature: ['warm', 'cool', 'neutral'].includes(baseline?.color_temperature)
      ? baseline.color_temperature
      : 'neutral',
  };

  const normalizedIntent = normalizeIntent(intentName);
  const delta = COLOR_INTENTS[normalizedIntent];

  return {
    brightness: clamp(safeBaseline.brightness + delta.brightness, -0.3, 0.3),
    contrast: clamp(safeBaseline.contrast + delta.contrast, 0.5, 2),
    saturation: clamp(safeBaseline.saturation + delta.saturation, 0.5, 2),
    gamma: clamp(safeBaseline.gamma + delta.gamma, 0.5, 2),
    color_temperature: delta.color_temperature || safeBaseline.color_temperature || 'neutral',
  };
}

function snapToNearest(value, points, maxDistance = 0.5) {
  if (typeof value !== 'number' || !Array.isArray(points) || points.length === 0) return value;
  let nearest = points[0];
  let bestDist = Math.abs(value - nearest);
  for (let i = 1; i < points.length; i++) {
    const dist = Math.abs(value - points[i]);
    if (dist < bestDist) {
      bestDist = dist;
      nearest = points[i];
    }
  }
  return bestDist <= maxDistance ? nearest : value;
}

async function generateEdit(analysis, transcript, vibe, onProgress) {
  console.log('🎨 Claude is creating edit recipe...');
  onProgress?.(45, 'Designing edit...');

  const expandedVibe = await expandVibeIntent(vibe);
  const prompt = buildPrompt(analysis, transcript, expandedVibe);
  console.log(`[generate-edit] ===== FULL PROMPT TO CLAUDE =====`);
  console.log(prompt);
  console.log(`[generate-edit] ===== END PROMPT (${prompt.length} chars) =====`);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    temperature: 0.3,
    messages: [{ role: 'user', content: prompt }],
  });

  const responseText = response.content[0].text;
  console.log(`[generate-edit] ===== CLAUDE RAW RESPONSE =====`);
  console.log(responseText);
  console.log(`[generate-edit] ===== END RESPONSE =====`);

  const text = responseText
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();

  const editPlan = JSON.parse(text);

  if (!Array.isArray(editPlan.cuts)) {
    throw new Error('Claude response missing cuts[]');
  }

  const baseline = analysis?.color_baseline || {};
  const intent = normalizeIntent(editPlan.color_intent || 'none');
  editPlan.color_intent = intent;
  editPlan.color_grade = buildColorGrade(baseline, intent);

  const snapCandidates = [
    ...(Array.isArray(analysis?.safe_cut_points) ? analysis.safe_cut_points.map((cp) => cp?.time).filter((t) => typeof t === 'number') : []),
    ...(Array.isArray(analysis?.speech?.sentence_boundaries) ? analysis.speech.sentence_boundaries.map((b) => b?.time ?? b?.end_time).filter((t) => typeof t === 'number') : []),
  ].sort((a, b) => a - b);

  for (const cut of editPlan.cuts) {
    if (!cut.transition_out) cut.transition_out = 'clean_cut';
    // Snap to nearest cut/sentence boundary first.
    if (typeof cut.source_start === 'number') cut.source_start = snapToNearest(cut.source_start, snapCandidates);
    if (typeof cut.source_end === 'number') cut.source_end = snapToNearest(cut.source_end, snapCandidates);
    // Round to millisecond precision to eliminate floating point noise
    if (typeof cut.source_start === 'number') cut.source_start = Math.round(cut.source_start * 1000) / 1000;
    if (typeof cut.source_end === 'number') cut.source_end = Math.round(cut.source_end * 1000) / 1000;
    // Strip editorial verification fields — these helped Claude think but aren't needed downstream
    delete cut.speech_before_cut;
    delete cut.speech_after_next_cut_starts;
  }

  console.log(
    `  Created ${editPlan.cuts.length} cuts, intent=${intent}, color: brightness=${editPlan.color_grade.brightness} contrast=${editPlan.color_grade.contrast} sat=${editPlan.color_grade.saturation} gamma=${editPlan.color_grade.gamma} temp=${editPlan.color_grade.color_temperature}`
  );
  onProgress?.(60, 'Edit plan complete');

  return editPlan;
}

async function expandVibeIntent(vibe) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 120,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: `Rewrite the client brief for an editor in 1 sentence.
Keep the exact intent and scope.
Do not add style requests, transitions, color direction, or embellishment.

Client brief: "${vibe}"

Return only the rewritten brief.`,
      },
    ],
  });

  const expanded = response.content[0]?.text?.trim();
  console.log(`[edit] Vibe expansion: "${vibe}" → "${expanded}"`);
  return expanded || vibe;
}

function buildPrompt(analysis, transcript, vibe) {
  const shotsBlock = analysis.shots.map((shot) =>
    `[${shot.start.toFixed(2)}s – ${shot.end.toFixed(2)}s]\n  ${shot.visual || ''}\n  ${shot.action || shot.description || ''}\n  Energy: ${(shot.energy || shot.score || 0.5).toFixed(1)}${shot.editing_value ? `\n  Value: ${shot.editing_value}` : ''}`
  ).join('\n\n');

  let speechBlock = '';
  if (analysis.speech?.has_speech) {
    const parts = [];
    if (analysis.speech.speaker_style || analysis.speech.overall_delivery) {
      parts.push(`Speaker: ${analysis.speech.speaker_style || analysis.speech.overall_delivery}`);
    }
    if (analysis.speech.segments?.length > 0) {
      for (const seg of analysis.speech.segments) {
        let segLine = `[${seg.start.toFixed(2)}s – ${seg.end.toFixed(2)}s] "${seg.text}" (${seg.emotion || 'neutral'}, energy ${(seg.energy_level || 0.5).toFixed(1)})`;
        if (seg.notes || seg.delivery_notes) segLine += `\n    ${seg.notes || seg.delivery_notes}`;
        parts.push(segLine);
      }
    }
    speechBlock = parts.join('\n');
  }

  let cutPointsBlock = '';
  const cutPoints = analysis.safe_cut_points || [];
  if (cutPoints.length > 0) {
    cutPointsBlock = `\nCuts:\n` +
      cutPoints
        .sort((a, b) => (b.quality || 0) - (a.quality || 0))
        .map((cp) => {
          const time = cp.time || 0;
          const reason = cp.why || cp.reason || '';
          return `  ${time.toFixed(2)}s (${(cp.quality || 0.5).toFixed(1)}) — ${reason}`;
        })
        .join('\n');
  }

  let highlightsBlock = '';
  const highlights = analysis.peak_moments || [];
  if (highlights.length > 0) {
    highlightsBlock = `\nHighlights:\n` +
      highlights
        .sort((a, b) => (b.importance || 0) - (a.importance || 0))
        .map((h) => `  ${(h.time || 0).toFixed(2)}s — ${h.what || h.description || ''} (${(h.importance || 0.5).toFixed(1)})`)
        .join('\n');
  }

  let profileBlock = '';
  const vp = analysis.video_profile || {};
  const profileParts = [];
  if (vp.content_type) profileParts.push(`Type: ${vp.content_type}`);
  if (vp.visual_character || vp.visual_style) profileParts.push(`Look: ${vp.visual_character || vp.visual_style}`);
  if (vp.strongest_moments) profileParts.push(`Best parts: ${vp.strongest_moments}`);
  if (vp.weakest_moments) profileParts.push(`Weakest parts: ${vp.weakest_moments}`);
  if (profileParts.length > 0) profileBlock = `\n${profileParts.join('\n')}`;

  let audioBlock = '';
  if (analysis.audio) {
    const musicInfo = analysis.audio.music || (analysis.audio.has_music && analysis.audio.music_description);
    if (musicInfo) {
      audioBlock = `\nMusic: ${musicInfo}`;
    }
  }

  let deepgramBlock = '';
  if (transcript?.text && transcript.text.length > 0) {
    deepgramBlock = `\nTranscript:\n"${transcript.text}"`;
  }

  const cb = analysis.color_baseline || {};
  const colorBaselineBlock = `\nColor baseline (measured from the footage):
  Assessment: ${cb.assessment || 'No major exposure or white-balance issues detected.'}
  Corrective values to make this footage look its best at neutral:
    brightness: ${typeof cb.brightness === 'number' ? cb.brightness : 0}
    contrast: ${typeof cb.contrast === 'number' ? cb.contrast : 1}
    saturation: ${typeof cb.saturation === 'number' ? cb.saturation : 1}
    gamma: ${typeof cb.gamma === 'number' ? cb.gamma : 1}
    color_temperature: ${cb.color_temperature || 'neutral'}`;

  const intents = Object.keys(COLOR_INTENTS).join(', ');

  return `You are a professional video editor cutting raw footage into a polished social media clip.

Brief: "${vibe}"

=== FOOTAGE ===
Duration: ${analysis.duration}s
${profileBlock}
${audioBlock}
${colorBaselineBlock}

Shots:
${shotsBlock}

${speechBlock}
${deepgramBlock}
${cutPointsBlock}
${highlightsBlock}

=== YOUR JOB ===

You are a professional social media video editor. Your edits should look like they came from CapCut or Premiere.

Take this raw footage and edit it into a polished social media video based on the client's brief.

Use all of the footage data above to make your editing decisions. Place your cuts at the timestamps listed in the cut points — those are the only frames where a cut will be clean. Every cut should flow naturally into the next.

The client brief is your creative direction. Every decision you make should deliver what the client described.

You have these transitions available: clean_cut, fade, fadeblack, fadewhite, dissolve, wipeleft, wiperight, wipeup, wipedown, smoothleft, smoothright, smoothup, smoothdown, circleclose, circleopen, horzclose, horzopen, radial, zoomin.
These are the transitions that look professional on social media content. The removed ones (pixelize, hblur, squeezeh, diagbl, hlslice, rectcrop, etc.) look gimmicky or dated on talking-head and screen-recording footage.

Color: Choose one color_intent from: ${intents}

Respond with ONLY valid JSON:

{
  "target_duration": <number>,
  "strategy": "<what you kept, what you cut, and why the speech still flows>",
  "color_intent": "<one word from the list>",
  "cuts": [
    {
      "source_start": <exact timestamp from the cut points list>,
      "source_end": <exact timestamp from the cut points list>,
      "speech_before_cut": "<last few words before this clip ends>",
      "speech_after_next_cut_starts": "<first few words when next clip begins — 'end' for last clip>",
      "transition_out": "<any transition from the list above>"
    }
  ]
}`;
}

module.exports = { generateEdit };
