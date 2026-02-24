// FFmpeg colorbalance filter strings for temperature shifts
const TEMPERATURE_FILTERS = {
  warm: 'colorbalance=rs=0.04:gs=0:bs=-0.06:rm=0.02:gm=0:bm=-0.03',
  cool: 'colorbalance=rs=-0.04:gs=0:bs=0.06:rm=-0.02:gm=0:bm=0.03',
  neutral: null
};

module.exports = { TEMPERATURE_FILTERS };
