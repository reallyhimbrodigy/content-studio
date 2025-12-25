const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SKIP_FILES = new Set(['tests/checkAudioSources.js']);

function walk(dir, callback) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (name === '.git' || name === 'node_modules') continue;
    const fullPath = path.join(dir, name);
    if (entry.isDirectory()) {
      walk(fullPath, callback);
    } else if (entry.isFile()) {
      callback(fullPath);
    }
  }
}

function findOccurrences(pattern) {
  const matches = [];
  walk(ROOT, (filePath) => {
    const rel = path.relative(ROOT, filePath);
    if (SKIP_FILES.has(rel)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(pattern)) {
      matches.push(rel);
    }
  });
  return matches;
}

[
  'DEFAULT_TIKTOK_AUDIO',
  'DEFAULT_INSTAGRAM_AUDIO',
].forEach((pattern) => {
  const occurrences = findOccurrences(pattern);
  if (occurrences.length > 0) {
    throw new Error(`Legacy audio list "${pattern}" must be removed; found in ${occurrences.join(', ')}`);
  }
});

const phrase = 'Provide the current Top 10 trending TikTok audio and Top 10 trending Instagram audio.';
const uniqueMatches = findOccurrences(phrase);
if (uniqueMatches.length !== 1 || uniqueMatches[0] !== 'server/lib/trendingAudio.js') {
  throw new Error(`Canonical trending audio descriptor must live only in server/lib/trendingAudio.js; found in ${uniqueMatches.join(', ')}`);
}

const placeholderTerm = '@' + 'Creator';
const placeholderMatches = findOccurrences(placeholderTerm);
if (placeholderMatches.length > 0) {
  throw new Error(`Placeholder creator handles must be removed; found in ${placeholderMatches.join(', ')}`);
}

console.log('Audio source duplication guardrail passed.');
