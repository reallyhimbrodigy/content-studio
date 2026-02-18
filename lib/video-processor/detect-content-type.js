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

    const prompt = `Analyze this video and determine its primary content type for optimal editing.

VIDEO CHARACTERISTICS:
- Duration: ${duration.toFixed(1)}s
- Has speech: ${transcript.length > 0 ? 'Yes' : 'No'}
- Speech ratio: ${speechRatio.toFixed(1)}%
- Audio beats detected: ${beats.length}
- Beat density: ${beatDensity.toFixed(2)} beats/second
- Scene changes: ${clipAnalysis?.video?.sceneChanges || 'unknown'}
- Video resolution: ${clipAnalysis?.dimensions?.width || 0}x${clipAnalysis?.dimensions?.height || 0}

CONTENT TYPE OPTIONS:

1. talking-head
2. music-video
3. automotive
4. cinematic
5. action-sports
6. product-showcase
7. gaming
8. travel-lifestyle
9. dance-performance
10. comedy-skit

Return ONLY valid JSON (no markdown, no code blocks):
{
  "primaryType": "music-video",
  "confidence": 0.85,
  "secondaryType": "cinematic",
  "characteristics": ["beat-heavy", "no-dialogue", "fast-paced", "high-energy"],
  "editingApproach": "Beat-sync every cut to the music. Color grade shifts on drops. Rapid cuts during high-energy sections. Motion blur for speed.",
  "recommendedPacing": "fast",
  "captionsNeeded": false,
  "musicEmphasis": true
}`;

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      thinking: { type: 'adaptive' },
      effort: 'high',
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
