const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateEdit(analysis, transcript, vibe, onProgress) {
  console.log('🎨 Claude is creating edit recipe...');
  onProgress?.(45, 'Designing edit...');
  
  const prompt = buildPrompt(analysis, transcript, vibe);
  
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    temperature: 1.0,
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
  return `You're a professional video editor creating a ${analysis.duration}s ${vibe} edit for TikTok/Instagram.

VIDEO CONTENT:

${analysis.shots.map((shot, i) => 
  `Shot ${i + 1} (${shot.start.toFixed(1)}-${shot.end.toFixed(1)}s):
${shot.description}`
).join('\n\n')}

${transcript.text ? `\nSPEECH:\n"${transcript.text}"\n` : ''}

USER WANTS: "${vibe}"

Create an edit that feels ${vibe}. Choose:
- Which moments to keep
- What effects to apply (zoom_in, zoom_out, speed_ramp, shake, flash)
- Which transitions (quick_cut, glitch, whip, fade)
- Where to add sound effects (whoosh, impact, riser)

Return JSON:
{
  "cuts": [
    {
      "start": 0,
      "duration": 2.5,
      "effects": ["zoom_in"],
      "transition_out": "quick_cut",
      "sound_effects": ["whoosh"]
    }
  ]
}`;
}

module.exports = { generateEdit };
