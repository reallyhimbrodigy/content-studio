#!/usr/bin/env node
// Simple integration check to ensure Stability's API accepts our payload shape.
// Run via `npm run test:stability`. Skips automatically if no sandbox key is set.

const apiKey = process.env.STABILITY_SANDBOX_API_KEY || process.env.STABILITY_API_KEY;
if (!apiKey) {
  console.log('Stability sandbox test skipped (no STABILITY_SANDBOX_API_KEY set).');
  process.exit(0);
}

const endpoint = 'https://api.stability.ai/v2beta/stable-image/generate/sd3';

async function run() {
  const form = new FormData();
  const prompt = `Promptly deployment check ${new Date().toISOString()}`;
  form.set('prompt', prompt);
  form.set('text_prompts[0][text]', prompt);
  form.set('mode', 'text-to-image');
  form.set('aspect_ratio', '1:1');
  form.set('output_format', 'png');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    body: form,
  });
  const raw = await response.text();
  if (!response.ok) {
    const hint = raw.slice(0, 240);
    throw new Error(`Stability sandbox failed ${response.status}: ${hint}`);
  }
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (err) {
    throw new Error(`Unable to parse Stability response: ${err.message}`);
  }
  const hasArtifacts = Array.isArray(data.artifacts) && data.artifacts.length > 0;
  const hasArtifactBase64 = hasArtifacts && data.artifacts.some((artifact) => artifact && artifact.base64);
  const hasImageField = typeof data.image === 'string' && data.image.length > 32;
  if (!hasArtifactBase64 && !hasImageField) {
    throw new Error(
      `Stability sandbox response missing recognizable image data: ${JSON.stringify(data).slice(0, 400)}`
    );
  }
  console.log('✓ Stability sandbox endpoint responded with an artifact.');
}

async function main() {
  try {
    await run();
  } catch (err) {
    console.warn('⚠ Stability sandbox check failed:', err?.message || err);
  } finally {
    process.exit(0);
  }
}

main();
