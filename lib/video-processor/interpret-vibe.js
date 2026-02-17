import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Clamp a numeric value to a range.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Build safe fallback vibe params if model call fails.
 * @returns {object}
 */
function buildFallbackVibeParams() {
  return {
    pacing: {
      profile: 'dynamic',
      avgCutDuration: 1.2,
      cutVariance: 0.35,
      beatSync: true,
      microCuts: false,
    },
    transitions: {
      family: 'snappy',
      allowedTypes: ['cut', 'zoom', 'whip', 'fade'],
      transitionFrequency: 0.45,
    },
    animations: {
      intensity: 'moderate',
      types: ['zoom_in', 'zoom_out', 'bounce'],
      frequency: 0.5,
      syncToBeats: true,
    },
    sfx: {
      palette: 'minimal',
      density: 'low',
      types: ['whoosh', 'pop'],
    },
    captions: {
      style: 'dynamic_animated',
      positioning: 'bottom_third',
      colorScheme: 'high_contrast_pop',
      wordByWord: true,
    },
    colorGrading: {
      mood: 'natural',
      contrast: 1.05,
      saturation: 1.1,
      warmth: 0.05,
    },
    retention: {
      patternInterrupts: true,
      interruptFrequency: 3.5,
      interruptTypes: ['sudden_zoom', 'freeze_frame'],
    },
  };
}

/**
 * Normalize/validate model output into expected vibe param shape.
 * @param {any} raw
 * @returns {object}
 */
function normalizeVibeParams(raw) {
  const fallback = buildFallbackVibeParams();
  const safe = raw && typeof raw === 'object' ? raw : {};
  const pacing = safe.pacing || {};
  const transitions = safe.transitions || {};
  const animations = safe.animations || {};
  const sfx = safe.sfx || {};
  const captions = safe.captions || {};
  const colorGrading = safe.colorGrading || {};
  const retention = safe.retention || {};

  return {
    pacing: {
      profile: pacing.profile || fallback.pacing.profile,
      avgCutDuration: clamp(Number(pacing.avgCutDuration) || fallback.pacing.avgCutDuration, 0.3, 5.0),
      cutVariance: clamp(Number(pacing.cutVariance) || fallback.pacing.cutVariance, 0.0, 1.0),
      beatSync: typeof pacing.beatSync === 'boolean' ? pacing.beatSync : fallback.pacing.beatSync,
      microCuts: typeof pacing.microCuts === 'boolean' ? pacing.microCuts : fallback.pacing.microCuts,
    },
    transitions: {
      family: transitions.family || fallback.transitions.family,
      allowedTypes: Array.isArray(transitions.allowedTypes) && transitions.allowedTypes.length
        ? transitions.allowedTypes.map((x) => String(x))
        : fallback.transitions.allowedTypes,
      transitionFrequency: clamp(
        Number(transitions.transitionFrequency) || fallback.transitions.transitionFrequency,
        0.0,
        1.0
      ),
    },
    animations: {
      intensity: animations.intensity || fallback.animations.intensity,
      types: Array.isArray(animations.types) && animations.types.length
        ? animations.types.map((x) => String(x))
        : fallback.animations.types,
      frequency: clamp(Number(animations.frequency) || fallback.animations.frequency, 0.0, 1.0),
      syncToBeats: typeof animations.syncToBeats === 'boolean'
        ? animations.syncToBeats
        : fallback.animations.syncToBeats,
    },
    sfx: {
      palette: sfx.palette || fallback.sfx.palette,
      density: sfx.density || fallback.sfx.density,
      types: Array.isArray(sfx.types) && sfx.types.length ? sfx.types.map((x) => String(x)) : fallback.sfx.types,
    },
    captions: {
      style: captions.style || fallback.captions.style,
      positioning: captions.positioning || fallback.captions.positioning,
      colorScheme: captions.colorScheme || fallback.captions.colorScheme,
      wordByWord: typeof captions.wordByWord === 'boolean' ? captions.wordByWord : fallback.captions.wordByWord,
    },
    colorGrading: {
      mood: colorGrading.mood || fallback.colorGrading.mood,
      contrast: clamp(Number(colorGrading.contrast) || fallback.colorGrading.contrast, 0.5, 2.0),
      saturation: clamp(Number(colorGrading.saturation) || fallback.colorGrading.saturation, 0.5, 2.0),
      warmth: clamp(Number(colorGrading.warmth) || fallback.colorGrading.warmth, -1.0, 1.0),
    },
    retention: {
      patternInterrupts: typeof retention.patternInterrupts === 'boolean'
        ? retention.patternInterrupts
        : fallback.retention.patternInterrupts,
      interruptFrequency: clamp(
        Number(retention.interruptFrequency) || fallback.retention.interruptFrequency,
        2.0,
        6.0
      ),
      interruptTypes: Array.isArray(retention.interruptTypes) && retention.interruptTypes.length
        ? retention.interruptTypes.map((x) => String(x))
        : fallback.retention.interruptTypes,
    },
  };
}

/**
 * Convert user vibe text and clip analysis into concrete edit parameters with GPT-4o.
 * @param {string} vibeInput
 * @param {object} clipAnalysis
 * @returns {Promise<object>}
 */
export async function interpretVibe(vibeInput, clipAnalysis) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('interpretVibe: missing OPENAI_API_KEY');
  }
  if (!vibeInput || typeof vibeInput !== 'string') {
    throw new Error('interpretVibe: vibeInput must be a non-empty string');
  }
  if (!clipAnalysis || typeof clipAnalysis !== 'object') {
    throw new Error('interpretVibe: clipAnalysis is required');
  }

  const duration = Number(clipAnalysis.duration) || 0;
  const width = Number(clipAnalysis?.dimensions?.width) || 0;
  const height = Number(clipAnalysis?.dimensions?.height) || 0;
  const fps = Number(clipAnalysis.fps) || 0;
  const beats = Array.isArray(clipAnalysis?.audio?.beats) ? clipAnalysis.audio.beats : [];
  const utterances = Array.isArray(clipAnalysis?.audio?.transcript) ? clipAnalysis.audio.transcript : [];
  const words = Array.isArray(clipAnalysis?.audio?.words) ? clipAnalysis.audio.words : [];

  console.log('[interpretVibe] Starting vibe interpretation', {
    vibeInput,
    duration,
    resolution: `${width}x${height}`,
    fps,
    beatCount: beats.length,
    utteranceCount: utterances.length,
    wordCount: words.length,
  });

  const prompt = [
    'You are an expert short-form video editing director.',
    `User vibe request: "${vibeInput}"`,
    '',
    'Clip analysis:',
    `- Duration: ${duration.toFixed(2)}s`,
    `- Resolution: ${width}x${height}`,
    `- FPS: ${fps}`,
    `- Beat count: ${beats.length}`,
    `- Speech segments: ${utterances.length}`,
    `- Word count: ${words.length}`,
    '',
    'Generate editing parameters as JSON with this exact top-level structure:',
    '{ pacing, transitions, animations, sfx, captions, colorGrading, retention }',
    '',
    'Hard requirements:',
    '- Return ONLY valid JSON (no markdown).',
    '- Keep values in realistic ranges for production editing.',
    '- Be distinctive and specific; avoid repetitive template outputs.',
    '- Vary output based on vibe and clip characteristics.',
    '',
    'Reference interpretation examples:',
    '- "punchy TikTok with fast cuts and meme SFX" -> rapid_fire pacing, chaotic transitions, meme_comedy SFX, dynamic_animated captions',
    '- "smooth cinematic Instagram Reels" -> smooth pacing, cinematic transitions, low SFX density, static captions',
    '- "chaotic comedy with zooms and shake effects" -> dynamic pacing, high animation intensity, high pattern interrupts',
  ].join('\n');

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      throw new Error('interpretVibe: empty response from OpenAI');
    }

    const parsed = JSON.parse(content);
    const vibeParams = normalizeVibeParams(parsed);
    console.log('[interpretVibe] Vibe parameters created successfully', {
      profile: vibeParams?.pacing?.profile,
      transitionFamily: vibeParams?.transitions?.family,
      captionStyle: vibeParams?.captions?.style,
    });
    return vibeParams;
  } catch (error) {
    console.error('[interpretVibe] Failed to interpret vibe, using fallback params', error);
    return buildFallbackVibeParams();
  }
}

