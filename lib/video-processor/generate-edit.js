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

  return `You are a professional video editor working in social media. You understand pacing, rhythm, audience attention, emotional arc, color theory, and what makes someone stop scrolling. You've edited thousands of videos and you know what works.

You are editing a real video. Below are detailed footage notes from your eyes and ears — someone who watched every frame and listened to every sound. You also have the user's creative direction. Your job is to create an edit plan that makes this footage look and feel its best for social media.

Think like an editor:
- The first 1-2 seconds must hook the viewer. Lead with the strongest moment or most compelling visual.
- Pacing should match the content's natural energy. Talking heads need breathing room. High energy content needs momentum.
- Transitions create emotional texture. A fade gives the viewer a moment to absorb. A dissolve softens a mood shift. A clean cut maintains energy. Choose based on what's happening at that specific moment in the footage.
- Color grading should enhance what's already there. Read the visual character notes and complement the footage's natural look. Warm footage benefits from leaning into warmth. Flat footage needs contrast and life. The grade should be visible but not overprocessed.
- Every cut should land at a moment that serves the content — between complete thoughts, during natural pauses, at energy shifts. The timing data below is precise to the hundredth of a second. Use that precision.

The user's creative direction is the goal. Everything you do should serve their vision for this video.

=== FOOTAGE NOTES ===

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

=== USER'S DIRECTION ===
"${vibe}"

=== OUTPUT ===

Design your edit. All timestamps to 0.01 seconds.

FFmpeg rendering engine parameter reference:
- brightness: -1.0 to 1.0 (0.0 = no change. 0.05 is subtle, 0.1 is noticeable)
- contrast: 0.0 to 2.0 (1.0 = no change. 1.1 is a subtle lift, 1.3 is strong)
- saturation: 0.0 to 3.0 (1.0 = no change. 1.15 is vibrant, 0.8 is desaturated)
- gamma: 0.1 to 3.0 (1.0 = no change. Below 1.0 deepens shadows, above lifts midtones)
- color_temperature: "warm" shifts toward golden tones, "cool" toward blue, "neutral" no shift

Respond with ONLY valid JSON:

{
  "target_duration": <number>,
  "strategy": "<your editorial approach for this specific video — what you're doing and why>",
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
      "source_start": <number to 0.01s>,
      "source_end": <number to 0.01s>,
      "effect": "slow_zoom_in" | "slow_zoom_out" | "none",
      "transition_out": "clean_cut" | "fade" | "dissolve" | "wipeleft" | "wiperight"
    }
  ]
}`;
}

module.exports = { generateEdit };
