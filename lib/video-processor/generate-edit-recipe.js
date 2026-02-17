/**
 * Get a random number in range.
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Clamp a number.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Pick a random item from an array.
 * @param {Array<any>} arr
 * @returns {any}
 */
function pickRandom(arr = []) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Check if timestamp is near a beat.
 * @param {number} timestamp
 * @param {number[]} beats
 * @param {number} threshold
 * @returns {boolean}
 */
function isNearBeat(timestamp, beats = [], threshold = 0.12) {
  return Array.isArray(beats) && beats.some((beat) => Math.abs(Number(beat) - Number(timestamp)) < threshold);
}

/**
 * Adjust cut duration so cut endpoint aligns to speech boundary when possible.
 * @param {number} start
 * @param {number} duration
 * @param {Array<{start:number,end:number,word?:string}>} transcript
 * @returns {number}
 */
function adjustToSpeechBoundary(start, duration, transcript = []) {
  if (!Array.isArray(transcript) || !transcript.length) return duration;
  const targetEnd = start + duration;
  let nearest = null;
  let nearestDiff = Number.POSITIVE_INFINITY;

  for (const token of transcript) {
    const tokenEnd = Number(token?.end);
    if (!Number.isFinite(tokenEnd)) continue;
    const diff = Math.abs(tokenEnd - targetEnd);
    if (diff < nearestDiff) {
      nearest = tokenEnd;
      nearestDiff = diff;
    }
  }

  if (nearest !== null && nearestDiff <= 0.15) {
    return Math.max(0.3, nearest - start);
  }
  return duration;
}

/**
 * Generate pacing cuts across full clip using vibe pacing rules.
 * @param {object} clipAnalysis
 * @param {object} vibeParams
 * @returns {Array<{start:number,end:number,duration:number}>}
 */
function generatePacingPlan(clipAnalysis, vibeParams) {
  const duration = Number(clipAnalysis?.duration) || 0;
  const beats = Array.isArray(clipAnalysis?.audio?.beats) ? clipAnalysis.audio.beats.map(Number).filter(Number.isFinite) : [];
  const words = Array.isArray(clipAnalysis?.audio?.words) ? clipAnalysis.audio.words : [];
  const pacing = vibeParams?.pacing || {};
  const avgCutDuration = clamp(Number(pacing.avgCutDuration) || 1.2, 0.3, 5.0);
  const cutVariance = clamp(Number(pacing.cutVariance) || 0.3, 0.0, 1.0);
  const beatSync = Boolean(pacing.beatSync);
  const microCuts = Boolean(pacing.microCuts);

  const cuts = [];
  let currentTime = 0;

  while (currentTime < duration) {
    const varianceDelta = (Math.random() * 2 - 1) * cutVariance * avgCutDuration;
    let cutDuration = avgCutDuration + varianceDelta;

    if (microCuts && Math.random() < 0.2) {
      cutDuration *= 0.5;
    }

    cutDuration = Math.max(0.3, cutDuration);

    if (beatSync && beats.length) {
      const target = currentTime + cutDuration;
      let nearestBeat = null;
      let nearestDiff = Number.POSITIVE_INFINITY;
      for (const beat of beats) {
        const diff = Math.abs(beat - target);
        if (diff < nearestDiff) {
          nearestBeat = beat;
          nearestDiff = diff;
        }
      }
      if (nearestBeat !== null && nearestDiff <= 0.3) {
        cutDuration = Math.max(0.3, nearestBeat - currentTime);
      }
    }

    cutDuration = adjustToSpeechBoundary(currentTime, cutDuration, words);
    cutDuration = Math.max(0.3, cutDuration);

    const end = Math.min(duration, currentTime + cutDuration);
    const safeDuration = Math.max(0.01, end - currentTime);

    cuts.push({
      start: Number(currentTime.toFixed(3)),
      end: Number(end.toFixed(3)),
      duration: Number(safeDuration.toFixed(3)),
    });

    currentTime = end;
  }

  console.log('[generatePacingPlan] Built cuts', {
    cutCount: cuts.length,
    avgCutDuration,
    beatSync,
    microCuts,
  });
  return cuts;
}

/**
 * Pick transitions for each cut boundary.
 * @param {Array<{start:number,end:number,duration:number}>} cuts
 * @param {object} clipAnalysis
 * @param {object} vibeParams
 * @returns {Array<{type:string,timestamp:number,duration:number,direction:string}>}
 */
function selectTransitions(cuts, clipAnalysis, vibeParams) {
  const beats = Array.isArray(clipAnalysis?.audio?.beats) ? clipAnalysis.audio.beats : [];
  const transitionConfig = vibeParams?.transitions || {};
  const allowedTypes = Array.isArray(transitionConfig.allowedTypes) && transitionConfig.allowedTypes.length
    ? transitionConfig.allowedTypes.map((x) => String(x))
    : ['cut', 'fade', 'zoom', 'whip'];
  const frequency = clamp(Number(transitionConfig.transitionFrequency) || 0.4, 0.0, 1.0);
  const family = String(transitionConfig.family || 'snappy');
  const transitions = [];

  for (let i = 0; i < Math.max(0, cuts.length - 1); i += 1) {
    const boundary = Number(cuts[i].end);
    if (Math.random() > frequency) {
      transitions.push({
        type: 'cut',
        timestamp: Number(boundary.toFixed(3)),
        duration: 0,
        direction: 'none',
      });
      continue;
    }

    let transitionPool = allowedTypes.filter((x) => x !== 'cut' && x !== 'none');
    if (isNearBeat(boundary, beats, 0.12) && family === 'chaotic') {
      const energetic = ['whip', 'zoom', 'glitch'];
      const intersect = energetic.filter((t) => transitionPool.includes(t));
      if (intersect.length) transitionPool = intersect;
    }
    const type = pickRandom(transitionPool) || 'cut';
    transitions.push({
      type,
      timestamp: Number(boundary.toFixed(3)),
      duration: Number(randomInRange(0.1, 0.3).toFixed(3)),
      direction: pickRandom(['left', 'right', 'up', 'down', 'in', 'out']) || 'right',
    });
  }

  console.log('[selectTransitions] Selected transitions', {
    count: transitions.length,
    family,
    frequency,
  });
  return transitions;
}

/**
 * Generate caption style instance from scheme.
 * @param {string} colorScheme
 * @returns {object}
 */
function generateCaptionStyle(colorScheme) {
  const presets = {
    high_contrast_pop: [
      { fill: '#FFFF00', stroke: '#000000', strokeWidth: 8 },
      { fill: '#FF006E', stroke: '#FFFFFF', strokeWidth: 6 },
      { fill: '#00F5FF', stroke: '#000000', strokeWidth: 10 },
      { fill: '#00FF00', stroke: '#000000', strokeWidth: 8 },
    ],
    subtle: [{ fill: '#FFFFFF', stroke: '#000000', strokeWidth: 2 }],
    gradient: [{ fill: 'linear-gradient(90deg, #FF006E, #FFBE0B)' }],
    monochrome: [{ fill: '#FFFFFF', stroke: '#000000', strokeWidth: 4 }],
  };
  const pool = presets[colorScheme] || presets.subtle;
  return pickRandom(pool) || presets.subtle[0];
}

/**
 * Generate caption position from positioning strategy.
 * @param {string} positioning
 * @returns {{x:number,y:number}}
 */
function generateCaptionPosition(positioning) {
  if (positioning === 'randomized') {
    return {
      x: Number(randomInRange(10, 90).toFixed(2)),
      y: Number(randomInRange(20, 80).toFixed(2)),
    };
  }
  if (positioning === 'center') return { x: 50, y: 50 };
  if (positioning === 'top_third') return { x: 50, y: 25 };
  return { x: 50, y: 75 };
}

/**
 * Select caption animation by caption style mode.
 * @param {string} style
 * @returns {string}
 */
function selectCaptionAnimation(style) {
  const map = {
    dynamic_animated: ['bounce', 'slide_up', 'scale_pop', 'rotate_in'],
    static: ['fade'],
    kinetic_type: ['typewriter', 'glitch_in'],
    minimal: ['fade'],
  };
  return pickRandom(map[style] || map.static) || 'fade';
}

/**
 * Generate caption objects from transcript data.
 * @param {object} clipAnalysis
 * @param {object} vibeParams
 * @returns {Array<object>}
 */
function generateCaptions(clipAnalysis, vibeParams) {
  const captionConfig = vibeParams?.captions || {};
  const styleName = String(captionConfig.style || 'dynamic_animated');
  const positionMode = String(captionConfig.positioning || 'bottom_third');
  const colorScheme = String(captionConfig.colorScheme || 'high_contrast_pop');
  const wordByWord = Boolean(captionConfig.wordByWord);
  const words = Array.isArray(clipAnalysis?.audio?.words) ? clipAnalysis.audio.words : [];
  const utterances = Array.isArray(clipAnalysis?.audio?.transcript) ? clipAnalysis.audio.transcript : [];
  const captions = [];

  if (wordByWord) {
    for (const word of words) {
      const start = Number(word?.start);
      const end = Number(word?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      captions.push({
        text: String(word?.word || '').toUpperCase(),
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        style: generateCaptionStyle(colorScheme),
        position: generateCaptionPosition(positionMode),
        animation: selectCaptionAnimation(styleName),
      });
    }
  } else {
    for (const utt of utterances) {
      const start = Number(utt?.start);
      const end = Number(utt?.end);
      const text = String(utt?.text || '').trim();
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      captions.push({
        text,
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        style: generateCaptionStyle(colorScheme),
        position: generateCaptionPosition(positionMode),
        animation: selectCaptionAnimation(styleName),
      });
    }
  }

  console.log('[generateCaptions] Generated captions', {
    count: captions.length,
    wordByWord,
    styleName,
  });
  return captions;
}

/**
 * Select appropriate SFX type for transition context.
 * @param {string} transitionType
 * @param {string[]} allowedTypes
 * @returns {string}
 */
function selectSFXType(transitionType, allowedTypes = []) {
  const map = {
    zoom: ['whoosh', 'pop'],
    whip: ['whoosh', 'vinyl_scratch'],
    glitch: ['glitch'],
    spin: ['whoosh'],
    fade: ['whoosh'],
  };
  const base = map[transitionType] || ['whoosh', 'pop'];
  const filtered = base.filter((x) => !allowedTypes.length || allowedTypes.includes(x));
  return pickRandom(filtered.length ? filtered : base) || 'whoosh';
}

/**
 * Build SFX generation prompt by type and palette.
 * @param {string} sfxType
 * @param {string} palette
 * @returns {string}
 */
function generateSFXPrompt(sfxType, palette) {
  const prompts = {
    meme_comedy: {
      whoosh: 'fast comedic whoosh sound, exaggerated cartoon style',
      pop: 'bubble pop sound, playful and bouncy',
      vinyl_scratch: 'DJ vinyl scratch sound, hip hop style',
      boing: 'spring boing sound, bouncy and exaggerated',
      boom: 'cartoon boom sound effect',
      hit: 'cartoon bonk sound effect, Tom and Jerry style',
      glitch: 'digital glitch sound, futuristic',
    },
    cinematic: {
      whoosh: 'deep cinematic whoosh, dramatic and powerful',
      boom: 'heavy bass impact, trailer-style hit',
      glitch: 'subtle digital artifact',
    },
    minimal: {
      whoosh: 'subtle air whoosh, clean',
      pop: 'soft click sound',
    },
  };
  const paletteMap = prompts[palette] || prompts.minimal;
  return paletteMap[sfxType] || 'subtle transition sound effect';
}

/**
 * Generate SFX placement events based on transitions and emphasis moments.
 * @param {Array<object>} cuts
 * @param {Array<object>} transitions
 * @param {object} clipAnalysis
 * @param {object} vibeParams
 * @returns {Array<object>}
 */
function generateSFXPlacements(cuts, transitions, clipAnalysis, vibeParams) {
  const sfx = vibeParams?.sfx || {};
  const density = String(sfx.density || 'none');
  if (density === 'none') return [];
  const palette = String(sfx.palette || 'minimal');
  const allowedTypes = Array.isArray(sfx.types) ? sfx.types.map((x) => String(x)) : [];
  const probabilities = { low: 0.3, medium: 0.6, high: 0.9 };
  const probability = probabilities[density] || 0.3;
  const emphasis = Array.isArray(clipAnalysis?.audio?.emphasisMoments) ? clipAnalysis.audio.emphasisMoments : [];

  const placements = [];

  for (const t of transitions) {
    if (!t || t.type === 'cut' || t.type === 'none') continue;
    if (Math.random() > probability) continue;
    const type = selectSFXType(t.type, allowedTypes);
    placements.push({
      type,
      timestamp: Number((t.timestamp || 0).toFixed(3)),
      duration: Number(randomInRange(0.3, 0.5).toFixed(3)),
      prompt: generateSFXPrompt(type, palette),
      source: 'transition',
    });
  }

  for (const moment of emphasis) {
    if (Math.random() > probability * 0.5) continue;
    const type = pickRandom(allowedTypes.length ? allowedTypes : ['pop', 'hit', 'whoosh']) || 'pop';
    placements.push({
      type,
      timestamp: Number((Number(moment?.timestamp) || 0).toFixed(3)),
      duration: Number(randomInRange(0.3, 0.5).toFixed(3)),
      prompt: generateSFXPrompt(type, palette),
      source: 'emphasis',
    });
  }

  console.log('[generateSFXPlacements] Generated SFX placements', {
    count: placements.length,
    density,
    palette,
  });
  return placements;
}

/**
 * Generate animation events over cuts.
 * @param {Array<{start:number,end:number,duration:number}>} cuts
 * @param {object} clipAnalysis
 * @param {object} vibeParams
 * @returns {Array<object>}
 */
function generateAnimations(cuts, clipAnalysis, vibeParams) {
  const cfg = vibeParams?.animations || {};
  const types = Array.isArray(cfg.types) ? cfg.types.map((x) => String(x)) : [];
  const frequency = clamp(Number(cfg.frequency) || 0.5, 0.0, 1.0);
  const intensity = String(cfg.intensity || 'moderate');
  const syncToBeats = Boolean(cfg.syncToBeats);
  const beats = Array.isArray(clipAnalysis?.audio?.beats) ? clipAnalysis.audio.beats.map(Number).filter(Number.isFinite) : [];
  const emphasis = Array.isArray(clipAnalysis?.audio?.emphasisMoments) ? clipAnalysis.audio.emphasisMoments : [];
  const animations = [];

  for (const cut of cuts) {
    if (Math.random() > frequency) continue;
    const cutStart = Number(cut.start);
    const cutEnd = Number(cut.end);
    const inCutEmphasis = emphasis.filter((m) => Number(m?.timestamp) >= cutStart && Number(m?.timestamp) <= cutEnd);

    if (types.includes('zoom_in') && inCutEmphasis.length) {
      const focus = pickRandom(inCutEmphasis);
      animations.push({
        type: 'zoom_in',
        timestamp: Number((Number(focus?.timestamp) || cutStart).toFixed(3)),
        scale: Number(randomInRange(1.1, 1.4).toFixed(3)),
        clipStart: cutStart,
        clipEnd: cutEnd,
      });
    }

    if (syncToBeats && beats.length && Math.random() < 0.3) {
      const beat = beats.find((b) => b >= cutStart && b <= cutEnd);
      if (Number.isFinite(beat)) {
        animations.push({
          type: 'bounce',
          timestamp: Number(beat.toFixed(3)),
          intensity: intensity,
          clipStart: cutStart,
          clipEnd: cutEnd,
        });
      }
    }

    if ((intensity === 'high' || intensity === 'extreme') && Math.random() < 0.2) {
      animations.push({
        type: 'shake',
        start: Number(cutStart.toFixed(3)),
        end: Number(Math.min(cutEnd, cutStart + randomInRange(0.1, 0.35)).toFixed(3)),
        amplitude: Number(randomInRange(0.5, 1.6).toFixed(3)),
        intensity,
        clipStart: cutStart,
        clipEnd: cutEnd,
      });
    }
  }

  console.log('[generateAnimations] Generated animations', {
    count: animations.length,
    intensity,
    frequency,
  });
  return animations;
}

/**
 * Build complete edit recipe from clip analysis + interpreted vibe parameters.
 * @param {object} clipAnalysis
 * @param {object} vibeParams
 * @returns {{cuts:Array,transitions:Array,captions:Array,sfxPlacements:Array,animations:Array,colorGrading:object,metadata:object}}
 */
function generateEditRecipe(clipAnalysis, vibeParams) {
  try {
    console.log('[generateEditRecipe] Starting recipe generation');

    const cuts = generatePacingPlan(clipAnalysis, vibeParams);
    const transitions = selectTransitions(cuts, clipAnalysis, vibeParams);
    const captions = generateCaptions(clipAnalysis, vibeParams);
    const sfxPlacements = generateSFXPlacements(cuts, transitions, clipAnalysis, vibeParams);
    const animations = generateAnimations(cuts, clipAnalysis, vibeParams);

    const recipe = {
      cuts,
      transitions,
      captions,
      sfxPlacements,
      animations,
      colorGrading: { ...(vibeParams?.colorGrading || {}) },
      metadata: {
        generatedAt: new Date().toISOString(),
        duration: Number(clipAnalysis?.duration) || 0,
        fps: Number(clipAnalysis?.fps) || 0,
        cutCount: cuts.length,
        transitionCount: transitions.filter((t) => t.type !== 'cut').length,
        captionCount: captions.length,
        sfxCount: sfxPlacements.length,
        animationCount: animations.length,
      },
    };

    console.log('[generateEditRecipe] Recipe generation complete', recipe.metadata);
    return recipe;
  } catch (error) {
    console.error('[generateEditRecipe] Failed to generate recipe', error);
    return {
      cuts: [],
      transitions: [],
      captions: [],
      sfxPlacements: [],
      animations: [],
      colorGrading: { ...(vibeParams?.colorGrading || {}) },
      metadata: {
        generatedAt: new Date().toISOString(),
        duration: Number(clipAnalysis?.duration) || 0,
        fps: Number(clipAnalysis?.fps) || 0,
        error: String(error?.message || error),
      },
    };
  }
}


module.exports = {
  isNearBeat,
  adjustToSpeechBoundary,
  generatePacingPlan,
  selectTransitions,
  generateCaptions,
  generateCaptionStyle,
  generateCaptionPosition,
  selectCaptionAnimation,
  generateSFXPlacements,
  selectSFXType,
  generateSFXPrompt,
  generateAnimations,
  generateEditRecipe,
};
