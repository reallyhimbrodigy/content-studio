const VALID_ANIMATIONS = new Set([
  'fade', 'scale', 'slide', 'rotate-slide', 'pan', 'wipe', 'color-wipe',
  'circular-wipe', 'film-roll', 'squash', 'spin', 'stripe', 'flip',
  'shake', 'bounce', 'wiggle', 'shift'
]);

const VALID_TRANSITIONS = new Set([
  'fade', 'slide', 'wipe', 'color-wipe', 'circular-wipe',
  'film-roll', 'squash', 'spin', 'stripe', 'flip'
]);

const ALLOWED_ANIMATION_KEYS = new Set([
  'type', 'scope', 'start_scale', 'end_scale', 'easing', 'duration', 'direction', 'intensity', 'speed'
]);

function buildCreatomateTimeline(recipe, videoUrl, analysis) {
  console.log('🎬 Building professional timeline...');
  
  const elements = [];
  let currentTime = 0;
  
  recipe.cuts.forEach((cut, index) => {
    const videoClip = {
      type: 'video',
      source: videoUrl,
      trim_start: cut.start,
      trim_duration: cut.duration,
      time: currentTime,
      duration: cut.duration,
      track: 1,
      animations: []
    };
    
    if (cut.effects) {
      cut.effects.forEach(effect => {
        const animation = mapEffect(effect, cut.duration);
        if (animation) {
          videoClip.animations.push(animation);
        }
      });
    }
    
    if (cut.transition_out && index < recipe.cuts.length - 1) {
      videoClip.exit_transition = mapTransition(cut.transition_out);
    }
    
    elements.push(videoClip);
    
    if (cut.sound_effects) {
      cut.sound_effects.forEach(sfx => {
        const sfxElement = createSFX(sfx, currentTime);
        if (sfxElement) elements.push(sfxElement);
      });
    }
    
    currentTime += cut.duration;
  });
  
  return {
    output_format: 'mp4',
    width: 1080,
    height: 1920,
    frame_rate: 30,
    duration: currentTime,
    elements: elements
  };
}

function mapEffect(effectName, duration) {
  const effects = {
    'zoom_in': {
      type: 'scale',
      scope: 'element',
      start_scale: '100%',
      end_scale: '120%',
      easing: 'cubic-out'
    },
    'zoom_out': {
      type: 'scale',
      scope: 'element',
      start_scale: '120%',
      end_scale: '100%',
      easing: 'cubic-in'
    },
    // Creatomate doesn't support a "time" animation type; skip this effect.
    'speed_ramp': null,
    'shake': {
      type: 'shake',
      intensity: 20,
      speed: 30
    },
    'flash': {
      type: 'fade',
      duration: 0.1
    }
  };
  
  const animation = effects[effectName] || null;
  return normalizeAnimation(animation);
}

function mapTransition(transitionName) {
  const transitions = {
    'quick_cut': null,
    'glitch': { type: 'fade', duration: 0.2 },
    'whip': { type: 'slide', direction: 'right', duration: 0.15 },
    'fade': { type: 'fade', duration: 0.3 }
  };
  
  const transition = transitions[transitionName] ?? { type: transitionName, duration: 0.2 };
  return normalizeTransition(transition);
}

function normalizeAnimation(animation) {
  if (!animation || typeof animation !== 'object') return null;
  const resolvedType = VALID_ANIMATIONS.has(animation.type) ? animation.type : 'scale';
  const normalized = { type: resolvedType };
  for (const [key, value] of Object.entries(animation)) {
    if (key === 'type') continue;
    if (ALLOWED_ANIMATION_KEYS.has(key)) normalized[key] = value;
  }
  return normalized;
}

function normalizeTransition(transition) {
  if (!transition || typeof transition !== 'object') return null;
  if (VALID_TRANSITIONS.has(transition.type)) return transition;
  return { type: 'fade', duration: transition.duration || 0.2 };
}

function createSFX(sfxName, time) {
  const sfx = {
    'whoosh': 'https://cdn.creatomate.com/assets/sfx/whoosh-1.mp3',
    'impact': 'https://cdn.creatomate.com/assets/sfx/impact.mp3',
    'riser': 'https://cdn.creatomate.com/assets/sfx/riser.mp3'
  };
  
  const source = sfx[sfxName];
  if (!source) return null;
  
  return {
    type: 'audio',
    source: source,
    time: time,
    duration: 1.0,
    volume: '70%',
    track: 2
  };
}

module.exports = { buildCreatomateTimeline };
