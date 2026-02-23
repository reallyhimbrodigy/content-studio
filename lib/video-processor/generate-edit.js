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
  return `You are a top-tier social media video editor who creates polished, scroll-stopping TikTok/Reels content. Your edits are CLEAN and PROFESSIONAL — not gimmicky.

SOURCE VIDEO: ${analysis.duration}s

SHOT BREAKDOWN:
${analysis.shots.map((shot, i) => 
  `[${shot.start.toFixed(1)}s – ${shot.end.toFixed(1)}s] ${shot.description} (interest: ${(shot.score || 0.5).toFixed(1)})`
).join('\n')}

${transcript.text ? `SPEECH TRANSCRIPT:\n"${transcript.text}"\n` : 'NO SPEECH DETECTED.\n'}

USER'S DIRECTION: "${vibe}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EDITING PHILOSOPHY — READ CAREFULLY:

1. LESS IS MORE. The best edits feel effortless. Don't add effects just because you can.
2. PACING IS EVERYTHING. Cut on action, on beats, on natural pauses. Dead air kills engagement.
3. KEEP THE BEST MOMENTS. Use the interest scores — high-scoring shots stay longer, low-scoring shots get trimmed or cut.
4. TRANSITIONS SHOULD BE INVISIBLE. Clean cuts (no transition) are almost always best. Use a subtle fade only when the mood changes. Never use flashy transitions unless the user explicitly asks.
5. SUBTLE MOTION > FLASHY EFFECTS. A gentle slow zoom (like Ken Burns) keeps the eye engaged without being distracting. That's your go-to.
6. RESPECT THE CONTENT. If there's speech, never cut mid-sentence. Let the story breathe.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AVAILABLE TOOLS:

EFFECTS (apply 0-1 per cut — most cuts should have 0 or just "slow_zoom_in"):
- "slow_zoom_in" — subtle push-in, feels cinematic (USE THIS AS YOUR DEFAULT)
- "slow_zoom_out" — gentle pull-out, good for reveals or endings
- "none" — no effect, clean static shot

TRANSITIONS (between cuts — default to "clean_cut"):
- "clean_cut" — hard cut, no transition. Professional default. Use 80%+ of the time.
- "smooth_fade" — gentle crossfade, 0.3s. Use for mood/scene changes only.
- "soft_slide" — subtle directional slide. Use sparingly for energy.

The output video should be 15-30 seconds for maximum social media engagement.
If the source is longer, select only the most compelling 15-30 seconds.
If the source is already 15-30 seconds, keep most of it but tighten the pacing.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Return ONLY valid JSON, no commentary:

{
  "target_duration": <planned output length in seconds>,
  "pacing_notes": "<one sentence about your editing strategy>",
  "cuts": [
    {
      "start": <source timestamp to begin this cut>,
      "duration": <how long this cut lasts in the output>,
      "effects": ["slow_zoom_in"],
      "transition_out": "clean_cut"
    }
  ]
}

RULES:
- Each cut's "start" is a timestamp in the SOURCE video
- Each cut's "duration" is how long that clip plays in the OUTPUT
- Cuts are ordered sequentially for the output timeline
- Keep between 3-8 cuts total
- Most cuts should be 2-5 seconds long
- At least 60% of cuts should have NO effect or just "slow_zoom_in"
- At least 70% of transitions should be "clean_cut"
- Never have two flashy transitions back-to-back`;
}

module.exports = { generateEdit };
