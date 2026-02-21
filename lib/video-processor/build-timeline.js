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
    'speed_ramp': {
      type: 'time',
      speed: 1.5
    },
    'shake': {
      type: 'shake',
      intensity: 20,
      speed: 30
    },
    'flash': {
      type: 'brightness',
      start_brightness: '100%',
      end_brightness: '150%',
      duration: 0.1
    }
  };
  
  return effects[effectName];
}

function mapTransition(transitionName) {
  const transitions = {
    'quick_cut': null,
    'glitch': { type: 'glitch', duration: 0.2 },
    'whip': { type: 'slide', direction: 'right', duration: 0.15 },
    'fade': { type: 'fade', duration: 0.3 }
  };
  
  return transitions[transitionName];
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
