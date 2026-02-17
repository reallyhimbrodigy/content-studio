const axios = require('axios');

/**
 * Sleep helper for polling.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map caption animation names to Shotstack transition names.
 * @param {string} animation
 * @returns {string}
 */
function mapCaptionAnimation(animation) {
  const key = String(animation || '').toLowerCase();
  if (key === 'bounce') return 'zoom';
  if (key === 'slide_up') return 'slideUp';
  if (key === 'scale_pop') return 'zoom';
  if (key === 'fade') return 'fade';
  return 'fade';
}

/**
 * Map recipe transition type to Shotstack transition.
 * @param {string} type
 * @returns {string|undefined}
 */
function mapTransitionType(type) {
  const key = String(type || '').toLowerCase();
  if (key === 'zoom') return 'zoom';
  if (key === 'whip') return 'wipe';
  if (key === 'fade') return 'fade';
  if (key === 'dissolve') return 'fade';
  if (key === 'glitch') return 'zoom';
  if (key === 'spin') return 'rotate';
  if (key === 'cut') return undefined;
  return undefined;
}

/**
 * Resolve Shotstack base render endpoint for configured environment.
 * @returns {string}
 */
function getShotstackRenderUrl() {
  const env = String(process.env.SHOTSTACK_ENV || 'sandbox').toLowerCase();
  if (env === 'v1') return 'https://api.shotstack.io/v1/render';
  return 'https://api.shotstack.io/stage/render';
}

/**
 * Build Shotstack timeline from analysis + edit recipe.
 * @param {object} clipAnalysis
 * @param {object} editRecipe
 * @param {string} videoUrl
 * @param {Array<{timestamp:number,audioUrl:string,duration?:number}>} sfxAssets
 * @returns {object}
 */
function buildShotstackTimeline(clipAnalysis, editRecipe, videoUrl, sfxAssets = []) {
  if (!editRecipe || typeof editRecipe !== 'object') {
    throw new Error('buildShotstackTimeline: editRecipe is required');
  }
  if (!videoUrl || typeof videoUrl !== 'string') {
    throw new Error('buildShotstackTimeline: videoUrl is required');
  }

  const cuts = Array.isArray(editRecipe.cuts) ? editRecipe.cuts : [];
  const transitions = Array.isArray(editRecipe.transitions) ? editRecipe.transitions : [];
  const captions = Array.isArray(editRecipe.captions) ? editRecipe.captions : [];
  const colorGrading = editRecipe.colorGrading || {};

  let cumulativeStart = 0;
  const videoClips = cuts.map((cut, index) => {
    const transition = transitions[index] || {};
    const mappedTransition = mapTransitionType(transition?.type);
    const clip = {
      asset: {
        type: 'video',
        src: videoUrl,
        trim: Number(cut.start) || 0,
        volume: 0,
      },
      start: Number(cumulativeStart.toFixed(3)),
      length: Number(cut.duration) || 0,
      fit: 'crop',
      scale: 1.0,
      position: 'center',
      offset: { x: 0, y: 0 },
      transition: {
        in: mappedTransition,
        out: mappedTransition,
      },
      filter: {
        contrast: Number(colorGrading.contrast) || 1.0,
        saturation: Number(colorGrading.saturation) || 1.0,
        brightness: (Number(colorGrading.warmth) || 0) * 0.1,
      },
    };
    cumulativeStart += Number(cut.duration) || 0;
    return clip;
  });

  const captionClips = captions.map((caption) => {
    const fill = caption?.style?.fill || '#FFFFFF';
    const stroke = caption?.style?.stroke || '#000000';
    const strokeWidth = Number(caption?.style?.strokeWidth) || 2;
    const x = Number(caption?.position?.x);
    const y = Number(caption?.position?.y);
    const html = `<p style="font-size:80px; color:${fill}; -webkit-text-stroke:${strokeWidth}px ${stroke}; font-family:'Impact'; text-align:center; font-weight:bold;">${String(caption?.text || '')}</p>`;

    return {
      asset: {
        type: 'html',
        html,
        width: 1080,
        height: 1920,
      },
      start: Number(caption?.start) || 0,
      length: Math.max(0.05, (Number(caption?.end) || 0) - (Number(caption?.start) || 0)),
      position: 'center',
      offset: {
        x: (Number.isFinite(x) ? x : 50) - 50,
        y: (Number.isFinite(y) ? y : 50) - 50,
      },
      transition: {
        in: mapCaptionAnimation(caption?.animation),
      },
    };
  });

  const sfxClips = (Array.isArray(sfxAssets) ? sfxAssets : [])
    .filter((sfx) => sfx && sfx.audioUrl)
    .map((sfx) => ({
      asset: {
        type: 'audio',
        src: sfx.audioUrl,
        volume: Number((0.6 + Math.random() * 0.2).toFixed(2)),
      },
      start: Number(sfx.timestamp) || 0,
      length: Number(sfx.duration) || 0.5,
    }));

  const timeline = {
    timeline: {
      soundtrack: {
        src: videoUrl,
        effect: 'fadeOut',
        volume: 1.0,
      },
      background: '#000000',
      tracks: [
        { clips: videoClips },
        { clips: captionClips },
        { clips: sfxClips },
      ],
    },
    output: {
      format: 'mp4',
      resolution: '1080x1920',
      fps: 30,
      quality: 'high',
    },
  };

  console.log('[buildShotstackTimeline] Timeline built', {
    videoClips: videoClips.length,
    captionClips: captionClips.length,
    sfxClips: sfxClips.length,
    duration: clipAnalysis?.duration,
  });

  return timeline;
}

/**
 * Submit render timeline to Shotstack.
 * @param {object} timeline
 * @returns {Promise<{renderId:string,status:string}>}
 */
async function submitToShotstack(timeline) {
  if (!process.env.SHOTSTACK_API_KEY) {
    throw new Error('submitToShotstack: Missing SHOTSTACK_API_KEY');
  }
  if (!timeline || typeof timeline !== 'object') {
    throw new Error('submitToShotstack: timeline must be an object');
  }

  const apiUrl = getShotstackRenderUrl();
  try {
    const response = await axios.post(apiUrl, timeline, {
      headers: {
        'x-api-key': process.env.SHOTSTACK_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    const renderId = response?.data?.response?.id;
    const status = response?.data?.response?.status;
    if (!renderId) {
      throw new Error('Shotstack response missing render ID');
    }
    console.log('[submitToShotstack] Render submitted', { renderId, status, apiUrl });
    return { renderId, status };
  } catch (error) {
    const status = error?.response?.status;
    const message = error?.response?.data?.response?.error || error?.response?.data?.message || error?.message;
    if (status === 401 || status === 403) {
      throw new Error(`submitToShotstack: Shotstack auth error (${status})`);
    }
    if (status === 429) {
      throw new Error('submitToShotstack: Shotstack rate limited (429). Retry later.');
    }
    if (error?.code === 'ECONNABORTED') {
      throw new Error('submitToShotstack: Request timed out');
    }
    throw new Error(`submitToShotstack: Failed to submit render - ${message || 'unknown error'}`);
  }
}

/**
 * Poll Shotstack render until completion or timeout.
 * @param {string} renderId
 * @returns {Promise<string>} Final rendered video URL
 */
async function pollShotstackRender(renderId) {
  if (!process.env.SHOTSTACK_API_KEY) {
    throw new Error('pollShotstackRender: Missing SHOTSTACK_API_KEY');
  }
  if (!renderId || typeof renderId !== 'string') {
    throw new Error('pollShotstackRender: renderId is required');
  }

  const baseUrl = getShotstackRenderUrl();
  const pollUrl = `${baseUrl}/${renderId}`;
  const maxPolls = 60;
  const intervalMs = 5000;

  console.log('[pollShotstackRender] Polling started', { renderId, pollUrl, maxPolls, intervalMs });

  for (let attempt = 1; attempt <= maxPolls; attempt += 1) {
    try {
      const response = await axios.get(pollUrl, {
        headers: {
          'x-api-key': process.env.SHOTSTACK_API_KEY,
        },
        timeout: 20000,
      });

      const payload = response?.data?.response || {};
      const status = payload.status;

      if (attempt % 2 === 0) {
        console.log('[pollShotstackRender] Poll status', {
          renderId,
          attempt,
          status,
        });
      }

      if (status === 'done') {
        const finalUrl = payload.url;
        if (!finalUrl) {
          throw new Error('Render finished but URL is missing');
        }
        console.log('[pollShotstackRender] Render complete', { renderId, url: finalUrl });
        return finalUrl;
      }

      if (status === 'failed') {
        const detail = payload.error || 'Unknown Shotstack render failure';
        throw new Error(`Shotstack render failed: ${detail}`);
      }

      if (status !== 'queued' && status !== 'rendering') {
        console.warn('[pollShotstackRender] Unexpected status, continuing', { renderId, status });
      }
    } catch (error) {
      const status = error?.response?.status;
      if (status === 429) {
        console.warn('[pollShotstackRender] Rate limited, backing off', { renderId, attempt });
      } else {
        console.error('[pollShotstackRender] Poll error', {
          renderId,
          attempt,
          status,
          message: error?.message || error,
        });
      }

      if (attempt === maxPolls) {
        throw new Error(`pollShotstackRender: polling failed after ${maxPolls} attempts - ${error?.message || error}`);
      }
    }

    await sleep(intervalMs);
  }

  throw new Error('pollShotstackRender: timeout after 5 minutes waiting for render completion');
}


module.exports = {
  sleep,
  mapCaptionAnimation,
  buildShotstackTimeline,
  submitToShotstack,
  pollShotstackRender,
};
