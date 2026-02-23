const VIBE_PRESETS = {
  warm_cinematic: {
    color: { brightness: 0.06, contrast: 1.15, saturation: 1.25, gamma: 1.0, color_temperature: 'warm' },
  },
  clean_professional: {
    color: { brightness: 0.04, contrast: 1.12, saturation: 1.1, gamma: 1.0, color_temperature: 'neutral' },
  },
  enhanced: {
    color: { brightness: 0.06, contrast: 1.2, saturation: 1.2, gamma: 1.02, color_temperature: 'warm' },
  },
  dark_moody: {
    color: { brightness: -0.08, contrast: 1.3, saturation: 0.8, gamma: 0.88, color_temperature: 'cool' },
  },
  energetic_hype: {
    color: { brightness: 0.08, contrast: 1.25, saturation: 1.35, gamma: 1.05, color_temperature: 'warm' },
  },
  vintage_retro: {
    color: { brightness: 0.04, contrast: 0.92, saturation: 0.7, gamma: 1.1, color_temperature: 'warm' },
  },
  bright_fun: {
    color: { brightness: 0.1, contrast: 1.1, saturation: 1.4, gamma: 1.05, color_temperature: 'warm' },
  },
  minimal_aesthetic: {
    color: { brightness: 0.0, contrast: 1.05, saturation: 0.85, gamma: 1.0, color_temperature: 'neutral' },
  }
};

const TEMPERATURE_FILTERS = {
  warm: 'colorbalance=rs=0.1:gs=-0.04:bs=-0.15:rm=0.05:gm=0:bm=-0.1',
  cool: 'colorbalance=rs=-0.1:gs=0:bs=0.15:rm=-0.05:gm=0:bm=0.1',
  neutral: null
};

module.exports = { VIBE_PRESETS, TEMPERATURE_FILTERS };
