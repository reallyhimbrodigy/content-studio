// lib/video-processor/build-timeline.js

const VALID_ANIMATIONS = new Set([
  'fade', 'scale', 'slide', 'rotate-slide', 'pan', 'wipe', 'color-wipe',
  'circular-wipe', 'film-roll', 'squash', 'spin', 'stripe', 'flip',
  'shake', 'bounce', 'wiggle', 'shift'
]);

const VALID_TRANSITIONS = new Set([
  'fade', 'slide', 'wipe', 'color-wipe', 'circular-wipe',
  'film-roll', 'squash', 'spin', 'stripe', 'flip'
]);

function buildCreatomateTimeline(recipe, videoUrl, analysis) {
  console.log('🎬 Building professional timeline...');
  
  const elements = [];
  let currentTime = 0;
  
  recipe.cuts.forEach((cut, index) => {
    const isLastCut = index === recipe.cuts.length - 1;
    
    const videoClip = {
      type: 'video',
      source: videoUrl,
      trim_start: cut.start,
      trim_duration: cut.duration,
      time: currentTime,
      duration: cut.duration,
      track: 1,
    };
    
    // Build animations — only add if we have valid effects
    const animations = [];
    if (cut.effects && cut.effects.length > 0) {
      cut.effects.forEach(effect => {
        const animation = mapEffect(effect, cut.duration);
        if (animation) animations.push(animation);
      });
    }
    if (animations.length > 0) {
      videoClip.animations = animations;
    }
    
    // Add transition — only if not the last cut and not a clean cut
    if (!isLastCut && cut.transition_out) {
      const transition = mapTransition(cut.transition_out);
      if (transition) {
        videoClip.exit_transition = transition;
      }
    }
    
    elements.push(videoClip);
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
  switch (effectName) {
    case 'slow_zoom_in':
      return {
        type: 'scale',
        scope: 'element',
        start_scale: '100%',
        end_scale: '106%',
        easing: 'quadratic-out',
      };
    
    case 'slow_zoom_out':
      return {
        type: 'scale',
        scope: 'element',
        start_scale: '106%',
        end_scale: '100%',
        easing: 'quadratic-in-out',
      };
    
    case 'none':
      return null;
    
    default:
      console.log(`[timeline] Skipping unknown effect: "${effectName}"`);
      return null;
  }
}

function mapTransition(transitionName) {
  switch (transitionName) {
    case 'clean_cut':
      return null;
    
    case 'smooth_fade':
      return {
        type: 'fade',
        duration: 0.3,
      };
    
    case 'soft_slide':
      return {
        type: 'slide',
        duration: 0.25,
      };
    
    default:
      console.log(`[timeline] Skipping unknown transition: "${transitionName}", using clean cut`);
      return null;
  }
}

module.exports = { buildCreatomateTimeline };
