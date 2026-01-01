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

const billboardModule = path.join(ROOT, 'server', 'lib', 'billboardHot100.js');
if (!fs.existsSync(billboardModule)) {
  throw new Error('Billboard Hot 100 source module missing at server/lib/billboardHot100.js');
}

const placeholderTerm = '@' + 'Creator';
const placeholderMatches = findOccurrences(placeholderTerm);
if (placeholderMatches.length > 0) {
  throw new Error(`Placeholder creator handles must be removed; found in ${placeholderMatches.join(', ')}`);
}

console.log('Audio source duplication guardrail passed.');
