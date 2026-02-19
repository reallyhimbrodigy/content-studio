const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

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

  const pacingStyle = String(pacing.style || '').toLowerCase();
  const mappedProfile = pacing.profile
    || (pacingStyle.includes('rapid') || pacingStyle.includes('hyper') ? 'rapid_fire'
      : pacingStyle.includes('smooth') || pacingStyle.includes('slow') ? 'smooth'
      : pacingStyle.includes('suspense') ? 'suspenseful'
      : 'dynamic');
  const mappedAvgCutDuration = Number(pacing.avgCutDuration) || Number(pacing.averageShotLength) || fallback.pacing.avgCutDuration;
  const mappedCutVariance = Number(pacing.cutVariance) || Number(pacing.cutIntensity) || fallback.pacing.cutVariance;
  const mappedTransitionTypes = Array.isArray(transitions.allowedTypes) && transitions.allowedTypes.length
    ? transitions.allowedTypes
    : [transitions.primary, transitions.secondary].filter(Boolean);
  const mappedTransitionFrequency = Number(transitions.transitionFrequency)
    || Number(pacing.cutIntensity)
    || Number(transitions.transitionDuration)
    || fallback.transitions.transitionFrequency;
  const animationIntensityValue = Number(animations.intensity);
  const mappedAnimationIntensity = animations.intensity && typeof animations.intensity === 'string'
    ? animations.intensity
    : Number.isFinite(animationIntensityValue)
      ? (animationIntensityValue >= 0.65 ? 'high' : animationIntensityValue >= 0.35 ? 'moderate' : 'subtle')
      : fallback.animations.intensity;
  const mappedAnimationFrequency = Number(animations.frequency)
    || Number(animations.patternInterruptFrequency)
    || fallback.animations.frequency;
  const mappedSfxDensity = sfx.density
    || (Number(sfx.density) >= 0.7 ? 'high' : Number(sfx.density) >= 0.4 ? 'medium' : Number(sfx.density) > 0 ? 'low' : '')
    || fallback.sfx.density;
  const mappedCaptionPositioning = captions.positioning
    || (captions.position === 'bottom_center' ? 'bottom_third'
      : captions.position === 'top_center' ? 'top_third'
      : captions.position || '');
  const mappedColorMood = colorGrading.mood
    || (colorGrading.style === 'vibrant_pop' ? 'vibrant_saturated'
      : colorGrading.style === 'cinematic' ? 'cinematic'
      : colorGrading.style || '');
  const mappedRetentionInterruptFrequency = Number(retention.interruptFrequency)
    || Number(retention.hookStrength && retention.visualVariety
      ? (retention.hookStrength + retention.visualVariety) * 3
      : 0)
    || fallback.retention.interruptFrequency;

  return {
    pacing: {
      profile: mappedProfile,
      avgCutDuration: clamp(mappedAvgCutDuration, 0.3, 5.0),
      cutVariance: clamp(mappedCutVariance, 0.0, 1.0),
      beatSync: typeof pacing.beatSync === 'boolean' ? pacing.beatSync : fallback.pacing.beatSync,
      microCuts: typeof pacing.microCuts === 'boolean' ? pacing.microCuts : fallback.pacing.microCuts,
    },
    transitions: {
      family: transitions.family || fallback.transitions.family,
      allowedTypes: Array.isArray(mappedTransitionTypes) && mappedTransitionTypes.length
        ? mappedTransitionTypes.map((x) => String(x))
        : fallback.transitions.allowedTypes,
      transitionFrequency: clamp(
        mappedTransitionFrequency,
        0.0,
        1.0
      ),
    },
    animations: {
      intensity: mappedAnimationIntensity,
      types: Array.isArray(animations.types) && animations.types.length
        ? animations.types.map((x) => String(x))
        : fallback.animations.types,
      frequency: clamp(mappedAnimationFrequency, 0.0, 1.0),
      syncToBeats: typeof animations.syncToBeats === 'boolean'
        ? animations.syncToBeats
        : fallback.animations.syncToBeats,
    },
    sfx: {
      palette: sfx.palette || fallback.sfx.palette,
      density: mappedSfxDensity,
      types: Array.isArray(sfx.types) && sfx.types.length ? sfx.types.map((x) => String(x)) : fallback.sfx.types,
    },
    captions: {
      style: captions.style || fallback.captions.style,
      positioning: mappedCaptionPositioning || fallback.captions.positioning,
      colorScheme: captions.colorScheme || fallback.captions.colorScheme,
      wordByWord: typeof captions.wordByWord === 'boolean'
        ? captions.wordByWord
        : typeof captions.keyPhrasesOnly === 'boolean'
          ? !captions.keyPhrasesOnly
          : fallback.captions.wordByWord,
    },
    colorGrading: {
      mood: mappedColorMood || fallback.colorGrading.mood,
      contrast: clamp(Number(colorGrading.contrast) || fallback.colorGrading.contrast, 0.5, 2.0),
      saturation: clamp(Number(colorGrading.saturation) || fallback.colorGrading.saturation, 0.5, 2.0),
      warmth: clamp(Number(colorGrading.warmth) || Number(colorGrading.temperature) || fallback.colorGrading.warmth, -1.0, 1.0),
    },
    retention: {
      patternInterrupts: typeof retention.patternInterrupts === 'boolean'
        ? retention.patternInterrupts
        : typeof retention.paceVariation === 'boolean'
          ? retention.paceVariation
        : fallback.retention.patternInterrupts,
      interruptFrequency: clamp(
        mappedRetentionInterruptFrequency,
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
 * Remove code fences from model output so JSON.parse can safely run.
 * @param {string} text
 * @returns {string}
 */
function stripMarkdownJson(text) {
  return String(text || '')
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();
}

function getContentTypeGuidance(type, context = {}) {
  const {
    beatCount = 0,
    duration = 0,
    secondsPerBeat = null,
    vibeInput = '',
  } = context;

  const guidance = {
    'music-video': `
MUSIC VIDEO PARAMETER SELECTION:

Beat structure for this video:
- Total beats: ${beatCount}
- Duration: ${duration.toFixed(1)}s
- Seconds per beat: ${secondsPerBeat}

PACING PARAMETERS:

avgCutDuration (seconds per shot):
This controls cut frequency. The editing system uses this to calculate cut intervals.

Examine "${vibeInput}" for sync intent:

Tight sync indicators: "locked", "synced", "tight", "aggressive", "hype"
→ Set avgCutDuration = ${secondsPerBeat} (one cut per beat)
→ Result: ~${beatCount} cuts total

Medium sync indicators: "energetic", "fast", "dynamic" without "tight"
→ Set avgCutDuration = ${secondsPerBeat ? (parseFloat(secondsPerBeat) * 1.5).toFixed(3) : 'N/A'}
→ Result: ~${Math.floor(beatCount / 1.5)} cuts

Loose sync indicators: "smooth", "chill", "flowing", "relaxed", "breathe"
→ Set avgCutDuration = ${secondsPerBeat ? (parseFloat(secondsPerBeat) * 2).toFixed(3) : 'N/A'}
→ Result: ~${Math.floor(beatCount / 2)} cuts

beatSync: Set true (enables beat timestamp alignment)
cutVariance: Tight=0.1, Medium=0.2, Loose=0.3
microCuts: Set false (beats provide rhythm)
profile: Set "rhythmic"

TRANSITIONS:
family: "immediate"
allowedTypes: ["cut"]
transitionFrequency: 0.0 (all hard cuts)

SFX:
palette: "minimal"
density: "low" (music is the audio star)
types: ["impact"]

CAPTIONS:
style: "none" (unless vibe mentions "lyrics" → "dynamic")

ANIMATIONS:
intensity: High energy (0.7-0.8), Medium (0.5-0.6), Low (0.3-0.4)
types: High=["zoom","shake","pulse"], Medium=["zoom","pulse"], Low=["pulse"]
frequency: 0.3-0.5
syncToBeats: true

COLOR GRADING:
mood: "vibrant"
saturation: High energy (1.3-1.4), Medium (1.2-1.3), Low (1.1-1.2)
contrast: 1.1-1.3
warmth: 0.0

RETENTION:
patternInterrupts: true
interruptFrequency: 0.3
interruptTypes: ["zoom", "flash"]`,

    automotive: `
AUTOMOTIVE EDITING APPROACH:

Goal: Make speed and power feel visceral. The edit should amplify the sensation of motion.

Pacing mechanics:
- Target shot length: 0.8 to 1.5 seconds
- Cut on mechanical moments: gear shifts, revs, acceleration, impacts
- Use 70-80% of available beats for cut placement

Motion enhancement:
- Speed ramps: 2-4 per video, duration exactly 1 second, multiply speed by 1.3-1.6x
- Motion blur intensity: 0.6-0.8 (always high for automotive)
- Camera shake on impacts: intensity 0.4-0.6

Visual treatment:
- Color grading: Either gritty (desaturated 0.85, contrast 1.3) or cinematic (teal-orange, contrast 1.25)
- Keep contrast high (1.2-1.4) to emphasize visual drama

Audio treatment:
- Emphasize engine sounds: boost volume 15-25%
- Bass frequencies should hit hard on revs and acceleration
- Music should complement but not overpower mechanical audio

Text approach:
- Captions rarely needed (the visuals tell the story)
- If vibe mentions stats or specs, can include brief text overlays

Adaptation based on vibe keywords:
- "aggressive" or "intense": Max out all intensity values, fastest cuts, highest motion blur
- "clean" or "smooth": Pull back on effects (motion blur 0.5, fewer speed ramps)
- "cinematic": Extend shots to 1.5-2.5s, use smoother transitions`,

    cinematic: `
CINEMATIC EDITING APPROACH:

Goal: Create a sophisticated edit that feels intentional, composed, and visually elegant.

Pacing mechanics:
- Target shot length: 3 to 5 seconds
- Each cut should feel purposeful, not rushed
- Use 20-40% of available beats for cuts (selective, not constant)

Transition approach:
- Primary: Cross-dissolve with 0.3-0.5 second duration
- Smooth visual flow between shots
- Avoid jarring or instant transitions unless vibe specifies energy

Visual treatment:
- Color grading: Film-inspired (teal-orange, desaturated, or muted palettes)
- Saturation: 0.7-0.9 (avoid vibrant, oversaturated looks)
- Contrast: 1.0-1.2 (natural, not blown out)

Effects restraint:
- Animation intensity: 0.1-0.3 (minimal)
- No shake, no rapid zoom, no hyperactive movement
- Respect the composition; let the framing speak

Audio treatment:
- SFX density: 0.0-0.2 (minimal or atmospheric only)
- SFX types: Ambient sounds that support mood, not distract
- Music should be atmospheric, not overpowering

Text approach:
- Captions: Typically not used in cinematic content
- If included, must be subtle and non-distracting

Adaptation based on vibe keywords:
- "dreamy" or "ethereal": Extend shots to 4-6s, use softer cross-dissolves
- "epic" or "dramatic": Can reduce to 2.5-4s shots, slightly higher contrast
- "emotional": Let key moments linger, use gentle fades`,

    'action-sports': `
ACTION SPORTS EDITING APPROACH:

Goal: Capture the energy and impact of athletic performance. Amplify the intensity.

Pacing mechanics:
- Target shot length: 0.6 to 1.5 seconds during action
- Cut on impact moments: landings, hits, trick completions
- Use 70-85% of available beats for cuts

Timing dynamics:
- Fast cuts during setup and approach
- Slow-motion on peak moments (apex of jump, landing, trick execution)
- Speed ramps to emphasize flow: 1.0x to 0.4x over 0.8 seconds for highlights

Visual treatment:
- Color grading: Vibrant and energetic (saturation 1.1-1.3)
- High contrast (1.2-1.4) to make action pop
- Motion blur moderate (0.4-0.6) to preserve clarity of movement

Audio treatment:
- Impact SFX on landings and hits (density 0.4-0.6)
- Music should be high-energy and drive the pace
- Whoosh sounds on fast movements can enhance sensation

Text approach:
- Captions minimal unless highlighting trick names or athlete callouts
- If used, should be brief and not obstruct the action

Adaptation based on vibe keywords:
- "hype" or "intense": Maximize cut speed, more SFX, tighter beat sync
- "smooth" or "flow": Fewer cuts, more slow-motion moments, emphasis on continuous movement`,

    'talking-head': `
TALKING HEAD EDITING APPROACH:

Goal: Keep the content engaging while preserving clear communication. Remove dead air without sacrificing natural flow.

Pacing mechanics:
- Cut on natural speech boundaries (end of sentences, breaths, pauses)
- Target shot length: 2 to 4 seconds
- Never cut mid-word or mid-sentence
- Use 40-60% of available beats (selective cutting based on speech rhythm)

Visual treatment:
- Jump cuts to remove filler words and pauses
- Zoom cuts can add emphasis on key points (use sparingly, 2-4 per video)
- Keep framing consistent; don't disorient the viewer

Caption approach:
- Captions should be present for key phrases or impactful statements
- Sync timing precisely with speech
- Style should be readable but not distracting

Audio treatment:
- Keep speech clear and foremost
- Music should be present but under dialogue (volume 30-40% of speech)
- Remove background noise and normalize audio levels

Retention tactics:
- Pattern interrupts: Occasional zoom or cut on emphasis words
- Visual interest: Text overlays, reactions, b-roll if available
- Remove dead air aggressively but preserve comedic timing

Adaptation based on vibe keywords:
- "punchy" or "fast": Aggressive jump cuts, remove all pauses, tight pacing
- "natural" or "conversational": Preserve more pauses, fewer cuts
- "energetic": More zoom cuts and visual emphasis`,

    gaming: `
GAMING EDITING APPROACH:

Goal: Highlight the best moments while maintaining gameplay readability.

Pacing mechanics:
- Cut on action beats: kills, explosions, victories, close calls
- Target shot length: 1 to 3 seconds during intense action, 2-4s during downtime
- Preserve important moments; don't cut away too quickly

Visual treatment:
- Keep UI and HUD visible and readable
- Don't crop gameplay elements unless specifically requested
- Color grading can be vibrant (saturation 1.1-1.3)

Moment emphasis:
- Slow-motion on highlight moments (0.3-0.5x speed for 1-2 seconds)
- Zoom emphasis on critical plays
- Fast cuts during intense sequences

Audio treatment:
- Game audio should remain clear and present
- Music can be energetic but should not overpower game sounds
- Impact SFX on kills and major moments (density 0.3-0.5)

Commentary handling:
- If commentary is present, cut on speech boundaries like talking-head content
- If no commentary, cut purely on gameplay action

Text approach:
- Captions for commentary if present
- Kill counts, streaks, or callouts can enhance hype

Adaptation based on vibe keywords:
- "hype" or "montage": Fast cuts, max energy, highlight reels only
- "clutch" or "intense": Preserve tension, don't cut away during crucial moments`,

    'travel-lifestyle': `
TRAVEL LIFESTYLE EDITING APPROACH:

Goal: Showcase locations and experiences with a balance of energy and breathing room.

Pacing mechanics:
- Mixed shot lengths: 1.5 to 3 seconds
- Scenic shots can linger longer (3-5s); action moments can be faster (1-2s)
- Use 50-70% of available beats for cuts

Visual treatment:
- Color grading: Either vibrant (saturation 1.2-1.4) or film-inspired depending on vibe
- Transitions can be varied: cross-dissolves for location changes, hard cuts for action
- Emphasize the beauty and variety of locations

Narration handling:
- If voice-over is present, cut on speech boundaries
- Music can be prominent when no speech
- Balance between showing and telling

Caption approach:
- Captions for narration if present
- Location callouts can enhance the experience
- Keep text minimal and tasteful

Audio treatment:
- Music should match the mood and energy of the locations
- Ambient sounds (waves, city noise, nature) can add authenticity
- SFX density moderate (0.2-0.4)

Adaptation based on vibe keywords:
- "adventure" or "exciting": Faster cuts, higher energy, more action focus
- "serene" or "peaceful": Longer shots, smoother transitions, atmospheric audio`,

    'dance-performance': `
DANCE PERFORMANCE EDITING APPROACH:

Goal: Showcase choreography while maintaining musical synchronization. Let the dancer shine.

Pacing mechanics:
- Cut on musical accents and beat hits
- Preserve continuous movement; avoid cutting mid-move unless intentional
- Most cuts (80-90%) should align with musical structure

Shot selection:
- Full-body shots during continuous choreography
- Closer shots on specific movements or expressions
- Multiple angles if available, synced to musical sections

Visual treatment:
- Color grading should be clean and vibrant (saturation 1.1-1.3)
- Lighting and contrast should showcase the dancer clearly
- Effects should enhance, not distract from performance

Audio treatment:
- Music is the primary driver
- Keep music volume prominent and clear
- Minimal SFX (only on major hits if at all)

Text approach:
- Captions typically not needed (the performance speaks for itself)
- Dancer name or song title can be included briefly

Adaptation based on vibe keywords:
- "energetic" or "powerful": Tighter cuts, higher energy, emphasize hits
- "graceful" or "smooth": Longer shots, let movements flow, minimal cutting`,

    'product-showcase': `
PRODUCT SHOWCASE EDITING APPROACH:

Goal: Clearly present the product with professional, clean editing that maintains focus.

Pacing mechanics:
- Deliberate shot lengths: 2 to 4 seconds
- Allow viewers time to see and understand the product
- Cuts should transition between product features or angles smoothly

Visual treatment:
- Clean, professional color grading
- Well-lit and clear product visibility
- Transitions should be smooth and tasteful (cross-dissolve or clean cuts)

Focus maintenance:
- Product should be the star; avoid distracting effects
- Animation intensity low (0.1-0.3)
- SFX density minimal (0.1-0.3)

Audio treatment:
- If commentary is present, speech should be clear and primary
- Background music should be subtle and professional
- Avoid heavy or distracting sound effects

Text approach:
- Captions can highlight key features or benefits
- Product names, specs, or callouts can be included
- Keep text clean and readable

Adaptation based on vibe keywords:
- "luxury" or "premium": Slower pace, cinematic treatment, elegant transitions
- "exciting" or "innovative": Can be slightly faster, more dynamic presentation`,

    'comedy-skit': `
COMEDY SKIT EDITING APPROACH:

Goal: Preserve comedic timing while maintaining engagement. Punchlines need proper setup and delivery.

Pacing mechanics:
- Cut on comedic beats: setup, punchline, reaction
- Timing is critical: don't rush punchlines or cut away from reactions
- Shot lengths vary based on rhythm: 1-3 seconds for rapid bits, 3-5s for reactions

Visual treatment:
- Zoom cuts on punchlines for emphasis
- Quick cuts for rapid-fire comedy
- Reaction shots should have time to land

Audio treatment:
- Preserve comedic audio timing precisely
- SFX can enhance jokes (moderate density 0.4-0.6)
- Music should support but not overpower the comedy

Text approach:
- Captions can emphasize punchlines or add comedic value
- Text can be part of the joke if appropriate
- Timing of text appearance is critical

Retention tactics:
- Fast pacing between jokes
- Pattern interrupts and visual variety
- Keep energy high without sacrificing setup/payoff

Adaptation based on vibe keywords:
- "chaotic" or "absurd": Faster cuts, more visual chaos, heavy effects
- "dry" or "subtle": Preserve timing, fewer cuts, let jokes breathe`
  };

  return guidance[type] || '';
}

/**
 * Convert user vibe text and clip analysis into concrete edit parameters with Claude Opus 4.6.
 * @param {string} vibeInput
 * @param {object} clipAnalysis
 * @param {object} [contentType]
 * @returns {Promise<object>}
 */
async function interpretVibe(vibeInput, clipAnalysis, contentType = null) {
  if (!process.env.CLAUDE_API_KEY) {
    throw new Error('interpretVibe: missing CLAUDE_API_KEY');
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
  const beatCount = beats.length;
  const secondsPerBeat = beatCount > 0 ? (duration / beatCount).toFixed(3) : null;

  console.log('[interpretVibe] Starting Claude vibe interpretation', {
    vibeInput,
    contentType: contentType?.primaryType || 'unknown',
    duration,
    resolution: `${width}x${height}`,
    fps,
    beatCount: beats.length,
    utteranceCount: utterances.length,
    wordCount: words.length,
  });

  const normalizedContentType = contentType && typeof contentType === 'object'
    ? contentType
    : {
        primaryType: 'talking-head',
        confidence: 0.5,
        characteristics: ['general'],
        editingApproach: 'Balanced editing approach.',
        recommendedPacing: 'medium',
        captionsNeeded: true,
        musicEmphasis: false,
      };

  const contentContext = `
DETECTED CONTENT TYPE: ${normalizedContentType.primaryType}
Confidence: ${Math.round((Number(normalizedContentType.confidence) || 0) * 100)}%
Content characteristics: ${(normalizedContentType.characteristics || []).join(', ')}
Recommended approach: ${normalizedContentType.editingApproach}
Recommended pacing: ${normalizedContentType.recommendedPacing}
Music should drive the edit: ${normalizedContentType.musicEmphasis ? 'Yes' : 'No'}
Captions should be included: ${normalizedContentType.captionsNeeded ? 'Yes' : 'No'}

${getContentTypeGuidance(normalizedContentType.primaryType, {
    beatCount,
    duration,
    secondsPerBeat,
    vibeInput,
  })}
`;

  const totalSpokenWords = Array.isArray(clipAnalysis?.audio?.transcript)
    ? clipAnalysis.audio.transcript.reduce((sum, seg) => sum + (seg?.words?.length || 0), 0)
    : 0;

  const mainPrompt = `You are an expert video editor specializing in ${normalizedContentType.primaryType} content for short-form social media.

User's creative direction: "${vibeInput}"

VIDEO DATA:
- Duration: ${duration.toFixed(2)} seconds
- Detected beats: ${beatCount}
- Speech segments: ${clipAnalysis.audio.transcript?.length || 0}

IMPORTANT: You are selecting PARAMETERS that guide the editing system.
- avgCutDuration controls cut frequency (editing system calculates specific timestamps)
- beatSync enables alignment to beat timestamps
- density controls how many SFX are placed
- intensity controls effect strength

The editing system will calculate all specific timestamps based on your parameter choices.

Follow the content-specific guidance above to select appropriate values for "${vibeInput}".

SHORT-FORM CONTEXT:
- TikTok/Instagram Reels/Facebook videos (15-60 seconds)
- Mobile-first, fast-paced, retention-focused
- Pattern interrupts needed for engagement

Return valid JSON with these parameters:
{
  "pacing": {"profile": string, "avgCutDuration": number, "cutVariance": number, "beatSync": boolean, "microCuts": boolean},
  "transitions": {"family": string, "allowedTypes": array, "transitionFrequency": number},
  "animations": {"intensity": number, "types": array, "frequency": number, "syncToBeats": boolean},
  "sfx": {"palette": string, "density": string, "types": array},
  "captions": {"style": string, "positioning": string, "colorScheme": string, "wordByWord": boolean},
  "colorGrading": {"mood": string, "contrast": number, "saturation": number, "warmth": number},
  "retention": {"patternInterrupts": boolean, "interruptFrequency": number, "interruptTypes": array}
}

CRITICAL: Return ONLY valid JSON. No markdown. No code blocks.`;

  const fullPrompt = `${contentContext}

${mainPrompt}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      effort: 'high',
      messages: [
        {
          role: 'user',
          content: fullPrompt,
        },
      ],
    });

    const responseText = Array.isArray(response?.content)
      ? response.content
          .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
          .map((item) => item.text)
          .join('\n')
      : '';

    if (!responseText) {
      throw new Error('interpretVibe: empty response from Claude');
    }

    const cleanedText = stripMarkdownJson(responseText);
    const parsed = JSON.parse(cleanedText);
    const vibeParams = normalizeVibeParams(parsed);

    console.log('[interpretVibe] Claude vibe parameters created successfully', {
      profile: vibeParams?.pacing?.profile,
      transitionFamily: vibeParams?.transitions?.family,
      captionStyle: vibeParams?.captions?.style,
    });

    return vibeParams;
  } catch (error) {
    console.error('Claude API error:', error);

    if (error?.status === 429) {
      throw new Error('Rate limit exceeded. Please try again in a moment.');
    }
    if (error?.status === 500) {
      throw new Error('Claude API is temporarily unavailable.');
    }
    throw new Error(`Failed to interpret vibe with Claude: ${error.message}`);
  }
}

module.exports = {
  interpretVibe,
};
