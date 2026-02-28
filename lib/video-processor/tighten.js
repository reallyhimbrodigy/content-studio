function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function normalizeWord(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[.,!?;:'"]/g, '')
    .trim();
}

/**
 * Tighten transcript by removing dead air + standalone fillers.
 * Returns keep segments in source timeline.
 */
function tightenTranscript(deepgramWords, options = {}) {
  const {
    maxGapSeconds = 0.4,
    minSegmentSeconds = 0.5,
    paddingSeconds = 0.05,
  } = options;

  const words = Array.isArray(deepgramWords) ? deepgramWords : [];
  if (!words.length) {
    return { segments: [], removedSeconds: 0, fillerWords: [] };
  }

  const fillerPatterns = new Set(['um', 'uh', 'uhm', 'hmm', 'ah', 'er', 'erm', 'huh']);
  const fillerIndices = new Set();

  for (let i = 0; i < words.length; i++) {
    const w = normalizeWord(words[i]?.word || words[i]?.punctuated_word);
    if (fillerPatterns.has(w)) fillerIndices.add(i);
  }

  const keepWords = words.filter((_, i) => !fillerIndices.has(i));
  if (!keepWords.length) {
    return { segments: [], removedSeconds: 0, fillerWords: [] };
  }

  const segments = [];
  let segStart = Number(keepWords[0].start || 0) - paddingSeconds;
  let segEnd = Number(keepWords[0].end || keepWords[0].start || 0) + paddingSeconds;

  for (let i = 1; i < keepWords.length; i++) {
    const prevEnd = Number(keepWords[i - 1].end || keepWords[i - 1].start || 0);
    const currStart = Number(keepWords[i].start || 0);
    const currEnd = Number(keepWords[i].end || currStart);
    const gap = currStart - prevEnd;
    if (gap > maxGapSeconds) {
      segments.push({ start: Math.max(0, round3(segStart)), end: round3(segEnd) });
      segStart = currStart - paddingSeconds;
    }
    segEnd = currEnd + paddingSeconds;
  }
  segments.push({ start: Math.max(0, round3(segStart)), end: round3(segEnd) });

  const merged = [];
  for (const seg of segments) {
    if (seg.end - seg.start < minSegmentSeconds && merged.length > 0) {
      merged[merged.length - 1].end = seg.end;
      continue;
    }
    merged.push({ ...seg });
  }

  const first = Number(words[0].start || 0);
  const last = Number(words[words.length - 1].end || words[words.length - 1].start || first);
  const originalDuration = Math.max(0, last - first);
  const keptDuration = merged.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
  const removedSeconds = Math.max(0, round3(originalDuration - keptDuration));

  const fillerWords = [...fillerIndices].map((i) => ({
    word: words[i].word,
    start: Number(words[i].start || 0),
    end: Number(words[i].end || words[i].start || 0),
  }));

  console.log(`[tighten] ${words.length} words -> ${merged.length} segments`);
  console.log(`[tighten] Removed ${removedSeconds.toFixed(1)}s (${fillerWords.length} filler words)`);

  return { segments: merged, removedSeconds, fillerWords };
}

module.exports = { tightenTranscript };

