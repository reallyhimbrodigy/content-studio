const { buildPrompt } = require('../server.js');

const prompt = buildPrompt('basketball training coach', 'Brand voice sample', {
  days: 5,
  startDay: 1,
});

if (!prompt.includes('Return ONLY a valid JSON array')) {
  throw new Error('Calendar prompt is missing the strict JSON reminder.');
}
if (!prompt.includes('ALL FIELDS BELOW ARE REQUIRED')) {
  throw new Error('Calendar prompt no longer enforces the required fields list.');
}

console.log('Calendar prompt regression check passed.');
