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
  'TIKTOK_TRENDING_TOP10',
  'INSTAGRAM_TRENDING_TOP10',
].forEach((pattern) => {
  const occurrences = findOccurrences(pattern);
  if (occurrences.length !== 1 || occurrences[0] !== 'server.js') {
    throw new Error(`Audio source pattern "${pattern}" must live only in server.js; found in ${occurrences.join(', ')}`);
  }
});

console.log('Audio source duplication guardrail passed.');
