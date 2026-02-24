const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
    temperature: 0.7,
    messages: [{ role: 'user', content: prompt }]
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

  // Validate and apply defaults
  if (!editPlan.color_grade) {
    editPlan.color_grade = {
      brightness: 0,
      contrast: 1,
      saturation: 1,
      gamma: 1,
      color_temperature: 'neutral'
    };
  }
  for (const cut of editPlan.cuts) {
    if (!cut.effect) cut.effect = 'none';
    if (!cut.transition_out) cut.transition_out = 'fade';
  }

  console.log(`  Created ${editPlan.cuts.length} cuts, color: brightness=${editPlan.color_grade.brightness} contrast=${editPlan.color_grade.contrast} sat=${editPlan.color_grade.saturation} temp=${editPlan.color_grade.color_temperature}`);
  onProgress?.(60, 'Edit plan complete');

  return editPlan;
}

async function expandVibeIntent(vibe) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 250,
    messages: [
      {
        role: 'user',
        content: `You are translating a video editing client's brief into clear, specific language for a professional editor.

The client said: "${vibe}"

Rewrite this as 2-3 sentences of specific editorial direction. Be vivid about what the final video should look and feel like. Expand vague words into their video editing meaning:

- "simple" in editing means smooth and polished, not absent or minimal
- "clean" means refined and professional
- "enhanced" or "quality" means the viewer should immediately see the difference — sharper, richer colors, more visual clarity
- "cinematic" means film-like color grading with intentional mood and atmosphere
- "fun" means energetic pacing with vibrant, saturated color
- "professional" means polished with consistent, high-end quality throughout
- "transitions" means visible blending between clips — fades, dissolves, or wipes
- Any mention of transitions means the editor should use them between most or all cuts

Respond with ONLY the rewritten direction.`
      }
    ]
  });

  const expanded = response.content[0]?.text?.trim();
  console.log(`[edit] Vibe expansion: "${vibe}" → "${expanded}"`);
  return expanded || vibe;
}

function buildPrompt(analysis, transcript, vibe) {
  const shotsBlock = analysis.shots.map((shot) =>
    `[${shot.start.toFixed(2)}s – ${shot.end.toFixed(2)}s]
  ${shot.visual || ''}
  ${shot.action || shot.description || ''}
  Energy: ${(shot.energy || shot.score || 0.5).toFixed(1)}${shot.editing_value ? `\n  Value: ${shot.editing_value}` : ''}`
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

  let boundariesBlock = '';
  if (analysis.speech?.sentence_boundaries?.length > 0) {
    boundariesBlock = `\nSentence endings:\n` +
      analysis.speech.sentence_boundaries
        .filter(b => b.is_safe_cut !== false)
        .map(b => {
          const time = b.time || b.end_time;
          let line = `  ${(time || 0).toFixed(2)}s`;
          const pause = b.pause_after || b.pause_duration;
          if (pause) line += ` (${pause.toFixed(2)}s pause)`;
          if (b.context) line += ` — ${b.context}`;
          return line;
        })
        .join('\n');
  }

  let cutPointsBlock = '';
  const cutPoints = analysis.safe_cut_points || [];
  if (cutPoints.length > 0) {
    cutPointsBlock = `\nCut points:\n` +
      cutPoints
        .sort((a, b) => (b.quality || 0) - (a.quality || 0))
        .map(cp => {
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
        .map(h => `  ${(h.time || 0).toFixed(2)}s — ${h.what || h.description || ''} (${(h.importance || 0.5).toFixed(1)})`)
        .join('\n');
  }

  let profileBlock = '';
  const vp = analysis.video_profile || {};
  const profileParts = [];
  if (vp.content_type) profileParts.push(`Type: ${vp.content_type}`);
  if (vp.energy_arc || vp.mood_arc) profileParts.push(`Arc: ${vp.energy_arc || vp.mood_arc}`);
  if (vp.visual_character || vp.visual_style) profileParts.push(`Look: ${vp.visual_character || vp.visual_style}`);
  if (vp.audio_character) profileParts.push(`Sound: ${vp.audio_character}`);
  if (vp.strongest_moments) profileParts.push(`Best parts: ${vp.strongest_moments}`);
  if (vp.weakest_moments) profileParts.push(`Weakest parts: ${vp.weakest_moments}`);
  if (vp.recommended_duration || vp.recommended_output_duration) profileParts.push(`Recommended length: ${vp.recommended_duration || vp.recommended_output_duration}s`);
  if (vp.editing_brief || vp.editing_recommendation) profileParts.push(`\nEditing brief:\n${vp.editing_brief || vp.editing_recommendation}`);
  if (profileParts.length > 0) profileBlock = `\n${profileParts.join('\n')}`;

  let audioBlock = '';
  if (analysis.audio) {
    const parts = [];
    if (analysis.audio.overall_quality || analysis.audio.audio_quality) parts.push(`Quality: ${analysis.audio.overall_quality || analysis.audio.audio_quality}`);
    if (analysis.audio.music || (analysis.audio.has_music && analysis.audio.music_description)) parts.push(`Music: ${analysis.audio.music || analysis.audio.music_description}`);
    if (analysis.audio.energy_arc) parts.push(`Energy: ${analysis.audio.energy_arc}`);
    if (parts.length > 0) audioBlock = `\nAudio:\n${parts.join('\n')}`;
  }

  let deepgramBlock = '';
  if (transcript?.text && transcript.text.length > 0) {
    deepgramBlock = `\nTranscript:\n"${transcript.text}"`;
  }

  return `You are a professional social media video editor. A client has hired you to edit their footage. Here is what they want:

"${vibe}"

This is the job. Every cut, transition, effect, and color decision you make should deliver on this direction. The client will watch the final video and judge whether you delivered what they asked for.

Study the footage below, then build an edit plan that fulfills the client's direction.

=== FOOTAGE ===
Source: ${analysis.duration}s
${profileBlock}
${audioBlock}

Shots:
${shotsBlock}

${speechBlock}
${boundariesBlock}
${deepgramBlock}
${cutPointsBlock}
${highlightsBlock}

=== YOUR TOOLS ===

Transitions (what the viewer experiences):
- "fade": smooth crossfade, one clip blends into the next over 0.3s. Polished and intentional.
- "dissolve": softer, slower blend. Dreamier or more reflective than a fade.
- "clean_cut": instant hard switch. No blending. Feels punchy and raw.
- "wipeleft" / "wiperight": one clip slides off revealing the next. Energetic and dynamic.

Effects (camera movement):
- "slow_zoom_in": slowly pushes in. Adds movement and focus to static shots.
- "slow_zoom_out": slowly pulls back. Creates a reveal or breathing feeling.
- "none": no added camera movement.

Color grade (what the viewer sees):
- brightness 0.03: imperceptible. 0.08: visible lift. 0.15: noticeably brighter.
- contrast 1.05: imperceptible. 1.15: visible pop. 1.25: dramatic punch.
- saturation 1.05: imperceptible. 1.15: colors visibly richer. 1.3: vivid and bold.
- gamma below 1.0: shadows get crushed darker. Above 1.0: shadows get lifted.
- "warm": golden/amber shift. "cool": blue shift. "neutral": no color shift.

- Use timestamps from the cut points and sentence boundaries above. These are where the editor identified safe places to cut.
- Clips must be contiguous — the source_start of each clip must equal the source_end of the previous clip, unless you are intentionally removing a section. If you remove content, state why in your strategy.
- Every cut must have a transition_out and an effect. Every field is required.
- All timestamps to 0.01s.

Respond with ONLY valid JSON:

{
  "target_duration": <number>,
  "strategy": "<describe your specific editorial approach for THIS video and THIS client direction>",
  "color_grade": {
    "brightness": <number>,
    "contrast": <number>,
    "saturation": <number>,
    "gamma": <number>,
    "color_temperature": "warm" | "cool" | "neutral"
  },
  "cuts": [
    {
      "source_start": <number to 0.01s>,
      "source_end": <number to 0.01s>,
      "effect": "slow_zoom_in" | "slow_zoom_out" | "none",
      "transition_out": "clean_cut" | "fade" | "dissolve" | "wipeleft" | "wiperight"
    }
  ]
}`;
}

module.exports = { generateEdit };
