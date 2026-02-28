const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'this', 'that', 'these', 'those',
  'i', 'you', 'we', 'they', 'he', 'she', 'them', 'us', 'my', 'your', 'our', 'their',
  'have', 'has', 'had', 'do', 'does', 'did', 'can', 'will', 'would', 'should',
]);

function cleanWord(word) {
  return String(word || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function isVisualTerm(term) {
  if (!term || term.length < 3) return false;
  if (STOP_WORDS.has(term)) return false;
  return true;
}

/**
 * Extract concrete visual keyword candidates from word-level transcript.
 */
function extractBrollKeywords(deepgramWords, maxKeywords = 8) {
  const words = Array.isArray(deepgramWords) ? deepgramWords : [];
  if (!words.length) return [];

  const counts = new Map();

  for (let i = 0; i < words.length; i++) {
    const w1 = cleanWord(words[i]?.word || words[i]?.punctuated_word);
    if (isVisualTerm(w1)) {
      const existing = counts.get(w1);
      if (!existing) {
        counts.set(w1, { keyword: w1, timestamp: Number(words[i].start || 0), count: 1 });
      } else {
        existing.count += 1;
      }
    }

    if (i < words.length - 1) {
      const w2 = cleanWord(words[i + 1]?.word || words[i + 1]?.punctuated_word);
      if (isVisualTerm(w1) && isVisualTerm(w2)) {
        const phrase = `${w1} ${w2}`;
        const existing = counts.get(phrase);
        if (!existing) {
          counts.set(phrase, { keyword: phrase, timestamp: Number(words[i].start || 0), count: 1 });
        } else {
          existing.count += 1;
        }
      }
    }
  }

  return [...counts.values()]
    .sort((a, b) => (b.count - a.count) || (a.timestamp - b.timestamp))
    .slice(0, maxKeywords)
    .map(({ keyword, timestamp, count }) => ({ keyword, timestamp, count }));
}

module.exports = { extractBrollKeywords };

