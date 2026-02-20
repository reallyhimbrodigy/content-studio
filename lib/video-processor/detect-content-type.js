const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

function buildFallbackContentType() {
  return {
    primaryType: 'talking-head',
    confidence: 0.5,
    secondaryType: null,
    characteristics: ['unknown'],
    editingApproach: 'Generic editing approach with balanced pacing.',
    recommendedPacing: 'medium',
    captionsNeeded: true,
    musicEmphasis: false,
  };
}

function normalizeContentType(raw) {
  const fallback = buildFallbackContentType();
  const safe = raw && typeof raw === 'object' ? raw : {};
  return {
    primaryType: String(safe.primaryType || fallback.primaryType),
    confidence: Math.max(0, Math.min(1, Number(safe.confidence) || fallback.confidence)),
    secondaryType: safe.secondaryType ? String(safe.secondaryType) : null,
    characteristics: Array.isArray(safe.characteristics) && safe.characteristics.length
      ? safe.characteristics.map((item) => String(item))
      : fallback.characteristics,
    editingApproach: String(safe.editingApproach || fallback.editingApproach),
    recommendedPacing: String(safe.recommendedPacing || fallback.recommendedPacing),
    captionsNeeded: typeof safe.captionsNeeded === 'boolean' ? safe.captionsNeeded : fallback.captionsNeeded,
    musicEmphasis: typeof safe.musicEmphasis === 'boolean' ? safe.musicEmphasis : fallback.musicEmphasis,
  };
}

function stripMarkdownJson(text) {
  return String(text || '')
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();
}

/**
 * Detect the primary content type for a clip so editing logic can adapt to non-talking-head formats.
 * @param {object} clipAnalysis
 * @returns {Promise<{
 * primaryType: string,
 * confidence: number,
 * secondaryType: string|null,
 * characteristics: string[],
 * editingApproach: string,
 * recommendedPacing: string,
 * captionsNeeded: boolean,
 * musicEmphasis: boolean
 * }>}
 */
async function detectContentType(clipAnalysis) {
  try {
    if (!process.env.CLAUDE_API_KEY) {
      throw new Error('detectContentType: missing CLAUDE_API_KEY');
    }
    if (!clipAnalysis || typeof clipAnalysis !== 'object') {
      throw new Error('detectContentType: clipAnalysis is required');
    }

    const duration = Number(clipAnalysis.duration) || 0;
    const transcript = Array.isArray(clipAnalysis?.audio?.transcript) ? clipAnalysis.audio.transcript : [];
    const beats = Array.isArray(clipAnalysis?.audio?.beats) ? clipAnalysis.audio.beats : [];
    const speechDuration = transcript.reduce((sum, segment) => {
      const start = Number(segment?.start) || 0;
      const end = Number(segment?.end) || 0;
      if (end > start) return sum + (end - start);
      return sum;
    }, 0);
    const speechRatio = duration > 0 ? (speechDuration / duration) * 100 : 0;
    const beatDensity = duration > 0 ? beats.length / duration : 0;

    const prompt = `Analyze this video and determine its primary content type.

VIDEO CHARACTERISTICS:
- Duration: ${duration.toFixed(1)}s
- Speech present: ${clipAnalysis?.audio?.transcript?.length > 0 ? 'Yes' : 'No'}
- Speech to total duration ratio: ${speechRatio.toFixed(1)}%
- Detected audio beats: ${clipAnalysis?.audio?.beats?.length || 0}
- Beats per second: ${beatDensity.toFixed(2)}
- Scene changes detected: ${clipAnalysis?.video?.sceneChanges || 'unknown'}
- Resolution: ${clipAnalysis?.dimensions?.width || 0}x${clipAnalysis?.dimensions?.height || 0}

CONTENT TYPE DEFINITIONS:

talking-head
When to choose: Person speaking directly to camera. Speech is the primary driver.
Key indicators: Speech ratio above 40%, face-focused framing, dialogue throughout.
Examples: Vlog, tutorial, reaction video, interview, product review with commentary.

music-video
When to choose: Music drives the content. Rhythm and beats are the focus.
Key indicators: Speech ratio below 20%, beat density above 1.5 per second, rhythmic structure.
Examples: Music video, AMV, lyric video, dance video focused on music.

automotive
When to choose: Cars/vehicles are the primary subject.
Key indicators: Engine sounds, road/vehicle visuals, motion-heavy footage.
Examples: POV driving, car showcase, drifting, racing footage.

cinematic
When to choose: Composed, film-like footage with intentional framing.
Key indicators: Slow pacing, deliberate composition, atmospheric mood, low beat density.
Examples: Short film, cinematic travel, narrative storytelling, artistic piece.

action-sports
When to choose: High-energy physical activity is the focus.
Key indicators: Rapid motion, tricks/stunts, impact moments, athletic performance.
Examples: Skateboarding, skiing, parkour, BMX, surfing.

product-showcase
When to choose: Demonstrating or highlighting a product.
Key indicators: Clear product shots, explanatory speech, slower deliberate pacing.
Examples: Unboxing, product review, demonstration, how-to.

gaming
When to choose: Video game footage or gaming commentary.
Key indicators: Game UI visible, gameplay audio, action sequences from games.
Examples: Gameplay highlights, walkthroughs, gaming montages.

travel-lifestyle
When to choose: Showcasing places, experiences, or daily life.
Key indicators: Mix of narration and scenery, varied locations, lifestyle moments.
Examples: Travel vlog, day-in-the-life, location showcase.

dance-performance
When to choose: Choreography or dance is the primary focus.
Key indicators: Music-driven, body movement emphasis, continuous performance.
Examples: Dance video, choreography showcase, performance piece.

comedy-skit
When to choose: Comedic content with scripted dialogue or bits.
Key indicators: Dialogue-heavy, punchlines, reaction shots, comedic timing.
Examples: Sketch comedy, comedic skit, funny scenario.

DECISION PROCESS:
1. Calculate speech ratio and beat density from the characteristics above
2. Match these numbers against the indicators for each type
3. Choose the type where the most indicators align
4. If multiple types could fit, choose the one where the PRIMARY focus belongs
5. Set confidence high (0.8-0.95) when indicators clearly match one type
6. Set confidence medium (0.6-0.8) when some overlap exists
7. Set confidence low (0.4-0.6) if uncertain or mixed content

Return valid JSON with no markdown:
{
  "primaryType": "music-video",
  "confidence": 0.87,
  "secondaryType": "cinematic",
  "characteristics": ["beat-heavy", "no-dialogue", "high-motion", "rhythmic"],
  "editingApproach": "Sync cuts to detected beats. Match visual pace to musical energy. Prioritize rhythm over other elements. Keep captions minimal unless lyrics are focal.",
  "recommendedPacing": "fast",
  "captionsNeeded": false,
  "musicEmphasis": true
}

The editingApproach field should be a 2-3 sentence description of how to approach editing this specific content type.`;

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: prompt }],
    });

    const responseText = Array.isArray(response?.content)
      ? response.content
          .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
          .map((item) => item.text)
          .join('\n')
      : '';

    const parsed = JSON.parse(stripMarkdownJson(responseText));
    const contentType = normalizeContentType(parsed);
    console.log('[detectContentType] Content type detected', {
      primaryType: contentType.primaryType,
      confidencePct: Math.round(contentType.confidence * 100),
      recommendedPacing: contentType.recommendedPacing,
      captionsNeeded: contentType.captionsNeeded,
      musicEmphasis: contentType.musicEmphasis,
    });
    return contentType;
  } catch (error) {
    console.error('[detectContentType] Detection error, using fallback', error);
    return buildFallbackContentType();
  }
}

module.exports = {
  detectContentType,
};
