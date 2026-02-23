// lib/video-processor/generate-edit.js
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
    messages: [{
      role: 'user',
      content: prompt
    }]
  });
  
  const text = response.content[0].text
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();
  
  const recipe = JSON.parse(text);
  
  console.log(`  Created ${recipe.cuts.length} cuts with effects`);
  onProgress?.(60, 'Edit recipe complete');
  
  return recipe;
}

function buildPrompt(analysis, transcript, vibe) {
  // Format shots
  const shotsBlock = analysis.shots.map((shot, i) => 
    `[${shot.start.toFixed(1)}s – ${shot.end.toFixed(1)}s] ${shot.description}
     Camera: ${shot.camera || 'static'} | Composition: ${shot.composition || 'medium'} | Energy: ${(shot.movement_energy || 0.5).toFixed(1)} | Interest: ${(shot.visual_interest || shot.score || 0.5).toFixed(1)} | Lighting: ${shot.lighting || 'natural'}`
  ).join('\n\n');

  // Format speech segments
  let speechBlock = 'NO SPEECH DETECTED.';
  if (analysis.speech?.has_speech && analysis.speech.segments?.length > 0) {
    speechBlock = `SPEECH SEGMENTS (timestamps are PRECISE — do NOT cut during speech):\n` +
      analysis.speech.segments.map(seg =>
        `[${seg.start.toFixed(1)}s – ${seg.end.toFixed(1)}s] "${seg.text}"${seg.emotion ? ` (${seg.emotion})` : ''}`
      ).join('\n');
  }

  // Format sentence boundaries
  let sentenceBoundaries = '';
  if (analysis.speech?.sentence_boundaries?.length > 0) {
    sentenceBoundaries = `\nSENTENCE BOUNDARIES (safe to cut AFTER these timestamps):\n` +
      analysis.speech.sentence_boundaries
        .filter(b => b.is_safe_cut)
        .map(b => `  ✓ ${b.end_time.toFixed(1)}s`)
        .join('\n');
  }

  // Format safe cut points
  let cutPointsBlock = '';
  if (analysis.safe_cut_points?.length > 0) {
    cutPointsBlock = `\nSAFE CUT POINTS (ranked by quality):\n` +
      analysis.safe_cut_points
        .sort((a, b) => (b.quality || 0) - (a.quality || 0))
        .map(cp => `  ${cp.time.toFixed(1)}s — ${cp.reason} (quality: ${(cp.quality || 0.5).toFixed(1)})`)
        .join('\n');
  }

  // Format peak moments
  let peakBlock = '';
  if (analysis.peak_moments?.length > 0) {
    peakBlock = `\nPEAK MOMENTS (must include in final edit):\n` +
      analysis.peak_moments
        .sort((a, b) => (b.importance || 0) - (a.importance || 0))
        .map(pm => `  ⭐ ${pm.time.toFixed(1)}s — ${pm.type}: ${pm.description} (importance: ${(pm.importance || 0.5).toFixed(1)})`)
        .join('\n');
  }

  // Format audio info
  let audioBlock = '';
  if (analysis.audio) {
    const parts = [];
    if (analysis.audio.has_music) parts.push(`Music: ${analysis.audio.music_description || 'yes'}`);
    if (analysis.audio.beat_moments?.length > 0) parts.push(`Beat drops at: ${analysis.audio.beat_moments.map(t => t.toFixed(1) + 's').join(', ')}`);
    if (analysis.audio.energy_arc) parts.push(`Energy arc: ${analysis.audio.energy_arc}`);
    if (parts.length > 0) audioBlock = `\nAUDIO:\n${parts.join('\n')}`;
  }

  // Video profile summary
  let profileBlock = '';
  if (analysis.video_profile) {
    const vp = analysis.video_profile;
    const parts = [];
    if (vp.content_type) parts.push(`Type: ${vp.content_type}`);
    if (vp.mood_arc) parts.push(`Mood: ${vp.mood_arc}`);
    if (vp.overall_energy) parts.push(`Energy: ${vp.overall_energy}`);
    if (vp.recommended_output_duration) parts.push(`Recommended length: ${vp.recommended_output_duration}s`);
    if (vp.key_takeaway) parts.push(`Content: ${vp.key_takeaway}`);
    if (parts.length > 0) profileBlock = `\nVIDEO PROFILE:\n${parts.join('\n')}`;
  }

  // Deepgram transcript as backup
  let deepgramBlock = '';
  if (transcript?.text && transcript.text.length > 0) {
    deepgramBlock = `\nDEEPGRAM TRANSCRIPT (high-accuracy speech-to-text):\n"${transcript.text}"`;
  }

  return `You are a top-tier social media video editor who creates polished, scroll-stopping TikTok/Reels content. Your edits are CLEAN and PROFESSIONAL — not gimmicky.

SOURCE VIDEO: ${analysis.duration}s
${profileBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VISUAL ANALYSIS:

${shotsBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${speechBlock}
${sentenceBoundaries}
${deepgramBlock}
${audioBlock}
${cutPointsBlock}
${peakBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
USER'S DIRECTION: "${vibe}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EDITING RULES — FOLLOW EXACTLY:

1. NEVER CUT DURING SPEECH. Your cuts must land on safe cut points or sentence boundaries. If someone is talking, the cut MUST happen after they finish a sentence. This is the #1 rule.

2. USE THE SAFE CUT POINTS. You have been given a list of timestamps where cuts feel natural. Use them. Do not invent your own cut points that fall during speech.

3. KEEP PEAK MOMENTS. The peak moments identified above are the highlights. Your edit must include them.

4. LESS IS MORE. Clean cuts are professional. Flashy transitions are amateur.

5. PACING MATTERS. Vary your cut lengths — mix 2-3s quick cuts with 4-5s breathing room cuts. Don't make every cut the same length.

6. RESPECT THE CONTENT. If this is a talking head video, the speech IS the content. Don't cut it up. Keep complete thoughts together.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AVAILABLE TOOLS:

EFFECTS (apply 0-1 per cut — most cuts should have "none" or "slow_zoom_in"):
- "slow_zoom_in" — subtle push-in, feels cinematic (default for static shots)
- "slow_zoom_out" — gentle pull-out, good for reveals or endings
- "none" — no effect, clean static shot

TRANSITIONS (between cuts — default to "clean_cut"):
- "clean_cut" — hard cut, no transition. Professional default. Use 80%+ of the time.
- "smooth_fade" — gentle crossfade, 0.3s. Use for mood/scene changes only.
- "soft_slide" — subtle directional slide. Use sparingly.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Return ONLY valid JSON:

{
  "target_duration": <planned output length in seconds>,
  "pacing_notes": "<one sentence about your editing strategy>",
  "cuts": [
    {
      "start": <source timestamp to begin — MUST align with a safe cut point or sentence boundary>,
      "duration": <how long this cut lasts in the output>,
      "effects": ["slow_zoom_in"],
      "transition_out": "clean_cut"
    }
  ]
}

FINAL CHECK before responding:
- Does every cut start AFTER a sentence boundary or at a safe cut point?
- Does every cut end BEFORE the next sentence starts, or at another safe cut point?
- Are all peak moments included?
- Are 80%+ of transitions "clean_cut"?`;
}

module.exports = { generateEdit };
