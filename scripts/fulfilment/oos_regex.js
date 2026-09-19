// DETERMINISTIC out-of-scope token pass. The LLM decides CLASS (judgement);
// this decides TOKEN PRESENCE (mechanical). Calibration showed the LLM's oos
// recall degrades on long briefs — it lost "Add very subtle background music"
// inside a 3,735-char brief — and class-8 is the number D1 exists to produce.
// Union of the two, with each source recorded so disagreement stays visible.
const NEG = /(mute|remove|without|no|delete|strip|get rid of|take out|don'?t add|dont add)\s+(the\s+)?$/i;

const RULES = [
  ['music',          [/\b(background music|bgm|add (a )?song|add music|music track|soundtrack|背景音楽|музык|müzik|add.{0,12}\bmusic\b)/i]],
  ['upscale_quality',[/\b(4\s?k|8\s?k|upscal|super.?resolution|make it hd|in hd|higher resolution|enhance the quality|improve the quality|sharpen)\b/i]],
  ['generative_vfx', [/\b(anime|ai.generated|generate (a )?(scene|background|image|video)|replace the|remove the (person|man|woman|logo|name|text|object|background)|change the background|deepfake|make (him|her|them) (say|blink|smile|move)|turn (me|him|her|this) into)\b/i]],
  ['stock_broll',    [/\b(stock (footage|video|clip)|b-?roll)\b/i]],
  ['voiceover_tts',  [/\b(voice.?over|tts|text.to.speech|ai (voice|narrator)|narrat(e|ion) (this|the)|clone my voice)\b/i]],
  ['ai_avatar',      [/\b(avatar|digital human|ai presenter)\b/i]],
  // NAMED RATIOS ONLY. `\d{1,2}:\d{1,2}` also matches TIMESTAMPS — "0:00",
  // "2:00 min", and a Psalms quote at "52:2" — 13 false positives in 290 before
  // this was pinned to the ratios that actually exist.
  ['aspect_ratio',   [/(\b(9\s?:\s?16|16\s?:\s?9|1\s?:\s?1|4\s?:\s?5|3\s?:\s?4|2\s?:\s?3|5\s?:\s?4)\b|\bvertical\b|\bhorizontal\b|\bportrait\b|\blandscape\b|\bsquare\b|縦型|横型)/i]],
  ['color_grade_lut',[/\b(colou?r grad|lut\b|cinematic colou?r|colou?r correct|filter\b)/i]],
  ['translation_dub',[/\b(translat|dub\b|dubbing|в переводе|traduc)/i]],
];

function oosTokens(text) {
  const hits = [];
  for (const [tag, res] of RULES) {
    for (const re of res) {
      const m = text.match(re);
      if (!m) continue;
      // a NEGATED mention is not an ask for it: "Mute music", "no b-roll"
      const before = text.slice(Math.max(0, m.index - 28), m.index);
      if (NEG.test(before)) continue;
      hits.push(tag);
      break;
    }
  }
  return hits;
}
module.exports = { oosTokens };
