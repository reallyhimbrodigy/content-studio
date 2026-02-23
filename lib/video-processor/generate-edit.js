const Anthropic = require('@anthropic-ai/sdk');

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

  console.log(`  Created ${editPlan.cuts.length} cuts`);
  onProgress?.(60, 'Edit plan complete');

  return editPlan;
}

function buildPrompt(analysis, transcript, vibe) {
  const shotsBlock = analysis.shots.map((shot, i) =>
    `[${shot.start.toFixed(1)}s – ${shot.end.toFixed(1)}s] ${shot.description}
     Camera: ${shot.camera || 'static'} | Energy: ${(shot.movement_energy || shot.score || 0.5).toFixed(1)} | Interest: ${(shot.visual_interest || shot.score || 0.5).toFixed(1)}`
  ).join('\n\n');

  let speechBlock = 'NO SPEECH DETECTED.';
  if (analysis.speech?.has_speech && analysis.speech.segments?.length > 0) {
    speechBlock = `SPEECH SEGMENTS (do NOT cut during speech):\n` +
      analysis.speech.segments.map(seg =>
        `[${seg.start.toFixed(1)}s – ${seg.end.toFixed(1)}s] "${seg.text}"${seg.emotion ? ` (${seg.emotion})` : ''}`
      ).join('\n');
  }

  let sentenceBoundaries = '';
  if (analysis.speech?.sentence_boundaries?.length > 0) {
    sentenceBoundaries = `\nSENTENCE BOUNDARIES (safe to cut AFTER these timestamps):\n` +
      analysis.speech.sentence_boundaries
        .filter(b => b.is_safe_cut)
        .map(b => `  ✓ ${b.end_time.toFixed(1)}s`)
        .join('\n');
  }

  let cutPointsBlock = '';
  if (analysis.safe_cut_points?.length > 0) {
    cutPointsBlock = `\nSAFE CUT POINTS:\n` +
      analysis.safe_cut_points
        .sort((a, b) => (b.quality || 0) - (a.quality || 0))
        .map(cp => `  ${cp.time.toFixed(1)}s — ${cp.reason} (quality: ${(cp.quality || 0.5).toFixed(1)})`)
        .join('\n');
  }

  let peakBlock = '';
  if (analysis.peak_moments?.length > 0) {
    peakBlock = `\nPEAK MOMENTS (must include):\n` +
      analysis.peak_moments
        .sort((a, b) => (b.importance || 0) - (a.importance || 0))
        .map(pm => `  ⭐ ${pm.time.toFixed(1)}s — ${pm.type}: ${pm.description}`)
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
    if (parts.length > 0) profileBlock = `\nVIDEO PROFILE:\n${parts.join('\n')}`;
  }

  let deepgramBlock = '';
  if (transcript?.text && transcript.text.length > 0) {
    deepgramBlock = `\nDEEPGRAM TRANSCRIPT:\n"${transcript.text}"`;
  }

  return `You are a professional video editor creating a polished social media edit.

SOURCE VIDEO: ${analysis.duration}s
${profileBlock}

VISUAL ANALYSIS:
${shotsBlock}

${speechBlock}
${sentenceBoundaries}
${deepgramBlock}
${cutPointsBlock}
${peakBlock}

USER'S DIRECTION: "${vibe}"

RULES:
1. NEVER cut during speech. Cuts must land on safe cut points or sentence boundaries.
2. Keep peak moments.
3. Clean cuts are the default. Only use crossfade for mood/scene changes.
4. Output should be 15-30 seconds for social media.
5. Keep between 3-8 cuts.

Return ONLY valid JSON:

{
  "target_duration": <number>,
  "strategy": "<one sentence about your editing approach>",
  "cuts": [
    {
      "source_start": <start timestamp in source video>,
      "source_end": <end timestamp in source video>,
      "effect": "slow_zoom_in",
      "transition_out": "clean_cut"
    }
  ]
}

Effects: "slow_zoom_in", "slow_zoom_out", "none"
Transitions: "clean_cut", "crossfade"`;
}

module.exports = { generateEdit };
