const axios = require('axios');

const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/sound-generation';

/**
 * Generate a single sound effect asset using ElevenLabs.
 * @param {{ prompt: string, duration?: number }} sfxPlacement
 * @returns {Promise<string>} Audio URL
 */
async function generateSFX(sfxPlacement) {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error('generateSFX: Missing ELEVENLABS_API_KEY');
  }
  if (!sfxPlacement || typeof sfxPlacement !== 'object') {
    throw new Error('generateSFX: sfxPlacement must be an object');
  }
  if (!sfxPlacement.prompt || typeof sfxPlacement.prompt !== 'string') {
    throw new Error('generateSFX: sfxPlacement.prompt must be a non-empty string');
  }

  const duration = Number.isFinite(Number(sfxPlacement.duration))
    ? Number(sfxPlacement.duration)
    : 1.0;

  try {
    const response = await axios.post(
      ELEVENLABS_URL,
      {
        text: sfxPlacement.prompt,
        duration_seconds: duration || 1.0,
        prompt_influence: 0.3,
      },
      {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const audioUrl = response?.data?.audio_url;
    if (!audioUrl) {
      throw new Error('ElevenLabs response missing audio_url');
    }

    console.log('[generateSFX] Generated SFX', {
      prompt: sfxPlacement.prompt,
      duration,
      audioUrl,
    });

    return audioUrl;
  } catch (error) {
    const status = error?.response?.status;
    const message = error?.response?.data?.detail || error?.response?.data?.message || error?.message;
    if (status === 401 || status === 403) {
      throw new Error(`generateSFX: ElevenLabs auth error (${status}) - invalid API key or unauthorized`);
    }
    if (status === 429) {
      throw new Error('generateSFX: ElevenLabs rate limited (429). Try again shortly.');
    }
    if (error?.code === 'ECONNABORTED') {
      throw new Error('generateSFX: ElevenLabs request timed out');
    }
    throw new Error(`generateSFX: Failed to generate SFX - ${message || 'unknown error'}`);
  }
}

/**
 * Generate multiple sound effects in parallel.
 * Continues even when individual SFX calls fail.
 * @param {Array<{ timestamp?: number, prompt: string, duration?: number }>} sfxPlacements
 * @returns {Promise<Array<{ timestamp: number, audioUrl: string, duration: number }>>}
 */
async function generateMultipleSFX(sfxPlacements) {
  if (!Array.isArray(sfxPlacements)) {
    throw new Error('generateMultipleSFX: sfxPlacements must be an array');
  }

  if (!sfxPlacements.length) {
    console.log('[generateMultipleSFX] No SFX placements provided');
    return [];
  }

  const settled = await Promise.all(
    sfxPlacements.map(async (placement, index) => {
      try {
        const audioUrl = await generateSFX(placement);
        return {
          ok: true,
          value: {
            timestamp: Number.isFinite(Number(placement?.timestamp)) ? Number(placement.timestamp) : 0,
            audioUrl,
            duration: Number.isFinite(Number(placement?.duration)) ? Number(placement.duration) : 1.0,
          },
        };
      } catch (error) {
        console.error('[generateMultipleSFX] Failed SFX placement', {
          index,
          timestamp: placement?.timestamp,
          prompt: placement?.prompt,
          error: error?.message || error,
        });
        return { ok: false, error };
      }
    })
  );

  const assets = settled.filter((item) => item.ok).map((item) => item.value);
  console.log('[generateMultipleSFX] Completed batch', {
    requested: sfxPlacements.length,
    generated: assets.length,
    failed: sfxPlacements.length - assets.length,
  });

  return assets;
}


module.exports = {
  generateSFX,
  generateMultipleSFX,
};
