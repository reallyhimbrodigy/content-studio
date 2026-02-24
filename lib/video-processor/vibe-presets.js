// FFmpeg colorbalance filter strings for temperature shifts
const TEMPERATURE_FILTERS = {
  warm: 'colorbalance=rs=0.1:gs=-0.04:bs=-0.15:rm=0.05:gm=0:bm=-0.1',
  cool: 'colorbalance=rs=-0.1:gs=0:bs=0.15:rm=-0.05:gm=0:bm=0.1',
  neutral: null
};

module.exports = { TEMPERATURE_FILTERS };
