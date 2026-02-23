const Anthropic = require('@anthropic-ai/sdk');
const { VIBE_PRESETS } = require('./vibe-presets');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateEdit(analysis, transcript, vibe, onProgress) {
  console.log('🎨 Claude is creating edit recipe...');
  onProgress?.(45, 'Designing edit...');

  const prompt = buildPrompt(analysis, transcript, vibe);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    temperature: 0.3,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();

  const editPlan = JSON.parse(text);

  // Validate and apply defaults
  if (!editPlan.color_grade) {
    editPlan.color_grade = VIBE_PRESETS.clean_professional.color;
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
  const shotsBlock = analysis.shots.map((shot, i) =>
    `[${shot.start.toFixed(2)}s – ${shot.end.toFixed(2)}s]
  ${shot.description}
  Colors: ${shot.dominant_colors || 'not noted'} | Lighting: ${shot.lighting || 'not noted'}
  Camera: ${shot.camera || 'static'} | Composition: ${shot.composition || 'medium'}
  Energy: ${(shot.movement_energy || 0.5).toFixed(1)} | Interest: ${(shot.visual_interest || 0.5).toFixed(1)}${shot.whats_happening ? `\n  ${shot.whats_happening}` : ''}${shot.editing_notes ? `\n  Editor notes: ${shot.editing_notes}` : ''}`
  ).join('\n\n');

  let speechBlock = '';
  if (analysis.speech?.has_speech) {
    const parts = [];
    if (analysis.speech.overall_delivery) {
      parts.push(`Speaker: ${analysis.speech.overall_delivery}`);
    }
    if (analysis.speech.segments?.length > 0) {
      parts.push(`\nSpeech:`);
      for (const seg of analysis.speech.segments) {
        let segLine = `[${seg.start.toFixed(2)}s – ${seg.end.toFixed(2)}s] "${seg.text}"`;
        if (seg.emotion) segLine += ` (${seg.emotion})`;
        if (seg.delivery_notes) segLine += `\n    ${seg.delivery_notes}`;
        parts.push(segLine);
      }
    }
    speechBlock = parts.join('\n');
  }

  let sentenceBoundaries = '';
  if (analysis.speech?.sentence_boundaries?.length > 0) {
    sentenceBoundaries = `\nSentence boundaries:\n` +
      analysis.speech.sentence_boundaries
        .filter(b => b.is_safe_cut)
        .map(b => {
          let line = `  ${b.end_time.toFixed(2)}s`;
          if (b.pause_duration) line += ` (${b.pause_duration.toFixed(2)}s pause)`;
          if (b.context) line += ` — ${b.context}`;
          return line;
        })
        .join('\n');
  }

  let cutPointsBlock = '';
  if (analysis.safe_cut_points?.length > 0) {
    cutPointsBlock = `\nCut points:\n` +
      analysis.safe_cut_points
        .sort((a, b) => (b.quality || 0) - (a.quality || 0))
        .map(cp => {
          let line = `  ${cp.time.toFixed(2)}s — ${cp.reason} (${(cp.quality || 0.5).toFixed(1)})`;
          if (cp.what_precedes) line += ` | before: ${cp.what_precedes}`;
          if (cp.what_follows) line += ` | after: ${cp.what_follows}`;
          return line;
        })
        .join('\n');
  }

  let peakBlock = '';
  if (analysis.peak_moments?.length > 0) {
    peakBlock = `\nPeak moments:\n` +
      analysis.peak_moments
        .sort((a, b) => (b.importance || 0) - (a.importance || 0))
        .map(pm => {
          let line = `  ${pm.time.toFixed(2)}s — ${pm.type}: ${pm.description}`;
          if (pm.suggested_treatment) line += `\n    ${pm.suggested_treatment}`;
          return line;
        })
        .join('\n');
  }

  let profileBlock = '';
  if (analysis.video_profile) {
    const vp = analysis.video_profile;
    const parts = [];
    if (vp.content_type) parts.push(`Type: ${vp.content_type}`);
    if (vp.overall_energy) parts.push(`Energy: ${vp.overall_energy}`);
    if (vp.recommended_output_duration) parts.push(`Recommended length: ${vp.recommended_output_duration}s`);
    if (vp.key_takeaway) parts.push(`Content: ${vp.key_takeaway}`);
    if (vp.mood_arc) parts.push(`Mood: ${vp.mood_arc}`);
    if (vp.visual_style) parts.push(`Look: ${vp.visual_style}`);
    if (vp.editing_recommendation) parts.push(`\nEditing brief:\n${vp.editing_recommendation}`);
    if (parts.length > 0) profileBlock = `\n${parts.join('\n')}`;
  }

  let audioBlock = '';
  if (analysis.audio) {
    const parts = [];
    if (analysis.audio.has_music) parts.push(`Music: ${analysis.audio.music_description || 'present'}`);
    if (analysis.audio.energy_arc) parts.push(`Energy arc: ${analysis.audio.energy_arc}`);
    if (analysis.audio.ambient_description) parts.push(`Ambient: ${analysis.audio.ambient_description}`);
    if (analysis.audio.audio_quality) parts.push(`Quality: ${analysis.audio.audio_quality}`);
    if (parts.length > 0) audioBlock = `\nAudio:\n${parts.join('\n')}`;
  }

  let deepgramBlock = '';
  if (transcript?.text && transcript.text.length > 0) {
    deepgramBlock = `\nTranscript:\n"${transcript.text}"`;
  }

  return `You are a professional video editor. Below are detailed footage notes from an assistant who watched every frame of this video. Use everything in these notes to create an edit plan tailored to this specific footage.

Source: ${analysis.duration}s
${profileBlock}
${audioBlock}

Shots:
${shotsBlock}

${speechBlock}
${sentenceBoundaries}
${deepgramBlock}
${cutPointsBlock}
${peakBlock}

The user wants: "${vibe}"

Create an edit for social media (15-30 seconds). Study the footage notes, the lighting, the colors, the speaker's delivery, the energy arc, and the editing brief above. Design your color grade based on what this footage actually looks like. Place every cut at a precise moment that serves the content. Choose transitions that match what's happening at each specific moment.

All timestamps must be precise to 0.01s.

Respond with ONLY valid JSON:

{
  "target_duration": <number>,
  "strategy": "<your creative approach for this specific video>",
  "color_grade": {
    "preset": "<closest reference or 'custom'>",
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
