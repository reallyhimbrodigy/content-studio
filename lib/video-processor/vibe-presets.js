const VIBE_PRESETS = {
  warm_cinematic: {
    color: { brightness: 0.05, contrast: 1.08, saturation: 1.2, gamma: 1.0, temperature: 'warm' },
    default_transition: 'fade',
    default_effect: 'slow_zoom_in',
    pacing: 'relaxed'
  },
  clean_professional: {
    color: { brightness: 0.02, contrast: 1.05, saturation: 1.05, gamma: 1.0, temperature: 'neutral' },
    default_transition: 'fade',
    default_effect: 'none',
    pacing: 'moderate'
  },
  dark_moody: {
    color: { brightness: -0.08, contrast: 1.25, saturation: 0.85, gamma: 0.9, temperature: 'cool' },
    default_transition: 'fade',
    default_effect: 'slow_zoom_in',
    pacing: 'slow'
  },
  energetic_hype: {
    color: { brightness: 0.08, contrast: 1.15, saturation: 1.3, gamma: 1.05, temperature: 'warm' },
    default_transition: 'wipeleft',
    default_effect: 'slow_zoom_in',
    pacing: 'fast'
  },
  vintage_retro: {
    color: { brightness: 0.03, contrast: 0.95, saturation: 0.75, gamma: 1.1, temperature: 'warm' },
    default_transition: 'fade',
    default_effect: 'slow_zoom_in',
    pacing: 'relaxed'
  },
  bright_fun: {
    color: { brightness: 0.1, contrast: 1.05, saturation: 1.35, gamma: 1.05, temperature: 'warm' },
    default_transition: 'fade',
    default_effect: 'none',
    pacing: 'moderate'
  },
  minimal_aesthetic: {
    color: { brightness: 0.0, contrast: 1.0, saturation: 0.9, gamma: 1.0, temperature: 'neutral' },
    default_transition: 'fade',
    default_effect: 'none',
    pacing: 'slow'
  }
};

// Color temperature is approximated via FFmpeg colorbalance filter
const TEMPERATURE_FILTERS = {
  warm: 'colorbalance=rs=0.08:gs=-0.03:bs=-0.12:rm=0.04:gm=0:bm=-0.08',
  cool: 'colorbalance=rs=-0.08:gs=0:bs=0.12:rm=-0.04:gm=0:bm=0.08',
  neutral: null  // no colorbalance filter needed
};

module.exports = { VIBE_PRESETS, TEMPERATURE_FILTERS };
