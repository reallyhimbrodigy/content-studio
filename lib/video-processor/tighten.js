function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeWord(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[.,!?;:'"]/g, '')
    .trim();
}

function mergeRanges(ranges, epsilon = 0.001) {
  const normalized = (Array.isArray(ranges) ? ranges : [])
    .map((r) => ({ start: toNum(r.start, 0), end: toNum(r.end, 0) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  if (!normalized.length) return [];

  const merged = [normalized[0]];
  for (let i = 1; i < normalized.length; i++) {
    const current = normalized[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end + epsilon) {
      last.end = Math.max(last.end, current.end);
      continue;
    }
    merged.push({ ...current });
  }
  return merged;
}

function subtractRanges(windowStart, windowEnd, removals) {
  const segments = [];
  const merged = mergeRanges(removals);
  let cursor = windowStart;

  for (const r of merged) {
    const start = Math.max(windowStart, r.start);
    const end = Math.min(windowEnd, r.end);
    if (end <= start) continue;
    if (start > cursor) {
      segments.push({ start: round3(cursor), end: round3(start) });
    }
    cursor = Math.max(cursor, end);
  }

  if (cursor < windowEnd) {
    segments.push({ start: round3(cursor), end: round3(windowEnd) });
  }
  return segments.filter((s) => s.end > s.start);
}

function buildTimeMap(segments) {
  const map = [];
  let cursor = 0;
  for (const seg of segments) {
    const sourceStart = toNum(seg.start, 0);
    const sourceEnd = toNum(seg.end, sourceStart);
    if (sourceEnd <= sourceStart) continue;
    const duration = sourceEnd - sourceStart;
    map.push({
      source_start: round3(sourceStart),
      source_end: round3(sourceEnd),
      tightened_start: round3(cursor),
      tightened_end: round3(cursor + duration),
    });
    cursor += duration;
  }
  return map;
}

/**
 * Tighten transcript by removing dead air + standalone fillers.
 * Returns keep segments in source timeline.
 */
function tightenTranscript(deepgramWords, options = {}) {
  const {
    maxGapSeconds = 0.4,
    trimToSeconds = 0.15,
    minSegmentSeconds = 0.5,
    paddingSeconds = 0.05,
    fillerPaddingSeconds = 0.02,
    sceneCutProximitySeconds = 0.3,
    sceneCuts = [],
  } = options;

  const words = (Array.isArray(deepgramWords) ? deepgramWords : [])
    .map((w) => ({
      ...w,
      start: toNum(w?.start, 0),
      end: toNum(w?.end, w?.start),
    }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);
  if (!words.length) {
    return {
      segments: [],
      removedSeconds: 0,
      fillerWords: [],
      deadAirCuts: [],
      deadAirRemovedSeconds: 0,
      deadAirTrimmedCount: 0,
      timeline_map: [],
      tightened_duration: 0,
    };
  }

  const fillerPatterns = new Set(['um', 'uh', 'uhm', 'hmm', 'ah', 'er', 'erm', 'huh']);
  const fillerIndices = new Set();
  const fillerCuts = [];

  for (let i = 0; i < words.length; i++) {
    const w = normalizeWord(words[i]?.word || words[i]?.punctuated_word);
    if (fillerPatterns.has(w)) {
      fillerIndices.add(i);
      fillerCuts.push({
        start: Math.max(0, words[i].start - fillerPaddingSeconds),
        end: words[i].end + fillerPaddingSeconds,
      });
    }
  }

  const keepWords = words.filter((_, i) => !fillerIndices.has(i));
  if (!keepWords.length) {
    return {
      segments: [],
      removedSeconds: 0,
      fillerWords: [...fillerIndices].map((i) => ({
        word: words[i].word,
        start: round3(words[i].start),
        end: round3(words[i].end),
      })),
      deadAirCuts: [],
      deadAirRemovedSeconds: 0,
      deadAirTrimmedCount: 0,
      timeline_map: [],
      tightened_duration: 0,
    };
  }

  const sceneCutList = (Array.isArray(sceneCuts) ? sceneCuts : [])
    .map((t) => toNum(t, -1))
    .filter((t) => t >= 0);
  const deadAirCuts = [];
  let deadAirRemovedSeconds = 0;
  let sceneGapSkips = 0;

  for (let i = 1; i < keepWords.length; i++) {
    const prevEnd = keepWords[i - 1].end;
    const currStart = keepWords[i].start;
    const gap = currStart - prevEnd;

    if (gap <= maxGapSeconds) continue;

    const isSceneChange = sceneCutList.some((cut) =>
      Math.abs(cut - prevEnd) < sceneCutProximitySeconds || Math.abs(cut - currStart) < sceneCutProximitySeconds
    );
    if (isSceneChange) {
      sceneGapSkips += 1;
      continue;
    }

    const removeStart = prevEnd + trimToSeconds;
    const removeEnd = currStart;
    if (removeEnd > removeStart) {
      deadAirCuts.push({ start: removeStart, end: removeEnd });
      deadAirRemovedSeconds += (removeEnd - removeStart);
    }
  }

  const first = Math.max(0, keepWords[0].start - paddingSeconds);
  const last = keepWords[keepWords.length - 1].end + paddingSeconds;
  const removeRanges = [...fillerCuts, ...deadAirCuts];
  const rawSegments = subtractRanges(first, last, removeRanges);

  const merged = [];
  for (const seg of rawSegments) {
    if (seg.end - seg.start < minSegmentSeconds && merged.length > 0) {
      merged[merged.length - 1].end = seg.end;
      continue;
    }
    merged.push({ ...seg });
  }

  const originalDuration = Math.max(0, last - first);
  const tightenedDuration = merged.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
  const removedSeconds = Math.max(0, round3(originalDuration - tightenedDuration));

  const fillerWords = [...fillerIndices].map((i) => ({
    word: words[i].word,
    start: round3(words[i].start),
    end: round3(words[i].end),
  }));
  const timelineMap = buildTimeMap(merged);

  console.log(`[tighten] ${words.length} words -> ${merged.length} segments`);
  console.log(`[tighten] Removed ${removedSeconds.toFixed(1)}s (${fillerWords.length} filler words)`);
  if (deadAirCuts.length > 0) {
    console.log(
      `[tighten] Removed ${deadAirRemovedSeconds.toFixed(1)}s dead air (${deadAirCuts.length} gaps trimmed from >${maxGapSeconds}s to ${trimToSeconds}s)`
    );
  } else {
    console.log('[tighten] Removed 0.0s dead air (0 gaps trimmed)');
  }
  if (sceneGapSkips > 0) {
    console.log(`[tighten] Skipped ${sceneGapSkips} dead-air trims near scene changes`);
  }

  return {
    segments: merged,
    removedSeconds,
    fillerWords,
    deadAirCuts: deadAirCuts.map((r) => ({ start: round3(r.start), end: round3(r.end) })),
    deadAirRemovedSeconds: round3(deadAirRemovedSeconds),
    deadAirTrimmedCount: deadAirCuts.length,
    timeline_map: timelineMap,
    tightened_duration: round3(tightenedDuration),
  };
}

module.exports = { tightenTranscript };
