const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateEdit(analysis, transcript, vibe, onProgress) {
  console.log('🎨 Claude is creating edit recipe...');
  onProgress?.(45, 'Designing edit...');

  const prompt = buildPrompt(analysis, transcript, vibe);
  console.log(`[generate-edit] ===== FULL PROMPT TO CLAUDE =====`);
  console.log(prompt);
  console.log(`[generate-edit] ===== END PROMPT (${prompt.length} chars) =====`);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    temperature: 0.3,
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
    if (!cut.transition_out) cut.transition_out = 'clean_cut';
  }

  console.log(`  Created ${editPlan.cuts.length} cuts, color: ${editPlan.color_grade.preset || 'custom'}`);
  onProgress?.(60, 'Edit plan complete');

  return editPlan;
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

  return `You are a professional social media video editor. You're editing real footage for a real client.

=== CLIENT DIRECTION ===
"${vibe}"

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

=== YOUR EDIT ===

Study the footage notes. Serve the client's direction. Design an edit for social media (15-30 seconds).

Available transitions: "fade" (crossfade), "dissolve" (soft blend), "clean_cut" (instant), "wipeleft", "wiperight"
Available effects: "slow_zoom_in", "slow_zoom_out", "none"

FFmpeg rendering parameters:
- brightness: -1.0 to 1.0 (0.0 = no change)
- contrast: 0.0 to 2.0 (1.0 = no change)
- saturation: 0.0 to 3.0 (1.0 = no change)
- gamma: 0.1 to 3.0 (1.0 = no change)
- color_temperature: "warm" | "cool" | "neutral"

All timestamps to 0.01s. Respond with ONLY valid JSON:

{
  "target_duration": <number>,
  "strategy": "<your approach for this specific video>",
  "color_grade": {
    "brightness": <number>,
    "contrast": <number>,
    "saturation": <number>,
    "gamma": <number>,
    "color_temperature": "warm" | "cool" | "neutral"
  },
  "cuts": [
    {
      "source_start": <number>,
      "source_end": <number>,
      "effect": "slow_zoom_in" | "slow_zoom_out" | "none",
      "transition_out": "clean_cut" | "fade" | "dissolve" | "wipeleft" | "wiperight"
    }
  ]
}`;
}

module.exports = { generateEdit };
