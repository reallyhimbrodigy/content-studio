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
 * Map internal color grading to Shotstack filter enum.
 * Allowed: none, blur, boost, contrast, darken, greyscale, lighten, muted, negative
 * @param {string} mood
 * @param {number} saturation
 * @returns {string}
 */
function mapColorGradingToShotstackFilter(mood, saturation) {
  const sat = Number(saturation);
  if (Number.isFinite(sat) && sat < 0.8) return 'muted';
  if (Number.isFinite(sat) && sat > 1.2) return 'boost';

  const key = String(mood || '').trim().toLowerCase();
  const moodToFilter = {
    vibrant: 'boost',
    cinematic: 'contrast',
    desaturated: 'muted',
    neutral: 'none',
    dark: 'darken',
    bright: 'lighten',
  };
  return moodToFilter[key] || 'none';
}

/**
 * Convert caption position mode to normalized Shotstack Y offset (-10..10).
 * @param {string} positioning
 * @returns {number}
 */
function getCaptionYPosition(positioning) {
  const key = String(positioning || '').toLowerCase();
  const positions = {
    top: -8,
    top_center: -8,
    top_third: -7,
    center: 0,
    bottom: 8,
    bottom_center: 8,
    bottom_third: 7,
  };
  return Number.isFinite(positions[key]) ? positions[key] : 8;
}

/**
 * Validate Shotstack payload before submission.
 * @param {object} payload
 */
function validateTimelinePayload(payload) {
  console.log(`\n${'='.repeat(70)}`);
  console.log('VALIDATING TIMELINE');
  console.log('='.repeat(70));

  const errors = [];
  if (!payload || typeof payload !== 'object') {
    errors.push('Payload must be an object');
  }

  const timeline = payload?.timeline;
  if (!timeline || typeof timeline !== 'object') {
    errors.push('Missing timeline object');
  }

  const tracks = timeline?.tracks;
  if (!Array.isArray(tracks)) {
    errors.push('Missing or invalid timeline.tracks array');
  } else if (tracks.length === 0) {
    errors.push('timeline.tracks array is empty');
  }

  if (Array.isArray(tracks)) {
    tracks.forEach((track, trackIndex) => {
      if (!track || typeof track !== 'object') {
        errors.push(`Track ${trackIndex}: invalid track object`);
        return;
      }
      if (!Array.isArray(track.clips)) {
        errors.push(`Track ${trackIndex}: missing or invalid clips array`);
        return;
      }
      if (track.clips.length === 0 && trackIndex === 0) {
        errors.push('Primary video track has no clips');
      }

      track.clips.forEach((clip, clipIndex) => {
        if (!clip || typeof clip !== 'object') {
          errors.push(`Track ${trackIndex} clip ${clipIndex}: invalid clip object`);
          return;
        }
        if (!clip.asset || typeof clip.asset !== 'object') {
          errors.push(`Track ${trackIndex} clip ${clipIndex}: missing asset`);
        }
        if (!Object.prototype.hasOwnProperty.call(clip, 'start')) {
          errors.push(`Track ${trackIndex} clip ${clipIndex}: missing start`);
        }
        if (!Object.prototype.hasOwnProperty.call(clip, 'length')) {
          errors.push(`Track ${trackIndex} clip ${clipIndex}: missing length`);
        }
      });
    });
  }

  const validFilters = ['none', 'blur', 'boost', 'contrast', 'darken', 'greyscale', 'lighten', 'muted', 'negative'];
  const validResolutions = ['1080', 'preview', 'mobile', 'sd', 'hd', '4k'];

  if (Array.isArray(tracks)) {
    tracks.forEach((track, trackIndex) => {
      if (!Array.isArray(track?.clips) || track.clips.length === 0) {
        errors.push(`Track ${trackIndex} has no clips`);
        return;
      }
      track.clips.forEach((clip, clipIndex) => {
        if (clip?.filter && !validFilters.includes(String(clip.filter))) {
          errors.push(`Track ${trackIndex} clip ${clipIndex}: Invalid filter "${clip.filter}"`);
        }
        if (clip?.offset && Object.prototype.hasOwnProperty.call(clip.offset, 'y')) {
          const y = Number(clip.offset.y);
          if (!Number.isFinite(y) || y < -10 || y > 10) {
            errors.push(`Track ${trackIndex} clip ${clipIndex}: Y offset ${clip.offset.y} out of range (-10 to +10)`);
          }
        }
      });
    });
  }

  const resolution = String(payload?.output?.resolution || '');
  if (!validResolutions.includes(resolution)) {
    errors.push(`Invalid output.resolution "${resolution}"`);
  }

  if (errors.length > 0) {
    console.error('\n❌ TIMELINE VALIDATION ERRORS:');
    errors.forEach((err) => console.error(`  - ${err}`));
    console.log('='.repeat(70) + '\n');
    throw new Error(`Timeline validation failed: ${errors.join('; ')}`);
  }

  console.log('✅ Timeline validation passed');
  console.log('='.repeat(70) + '\n');
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
  const shotstackFilter = mapColorGradingToShotstackFilter(colorGrading?.mood, colorGrading?.saturation);

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
      filter: shotstackFilter,
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
        x: Number.isFinite(x) ? Math.max(-10, Math.min(10, (x - 50) / 5)) : 0,
        y: Number.isFinite(y) ? Math.max(-10, Math.min(10, (y - 50) / 5)) : getCaptionYPosition(editRecipe?.captionsPositioning || 'bottom_center'),
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

  const tracks = [
    { clips: videoClips },
    { clips: captionClips },
    { clips: sfxClips },
  ];

  const nonEmptyTracks = tracks.filter((track) => Array.isArray(track?.clips) && track.clips.length > 0);

  const timeline = {
    timeline: {
      soundtrack: {
        src: videoUrl,
        effect: 'fadeOut',
        volume: 1.0,
      },
      background: '#000000',
      tracks: nonEmptyTracks,
    },
    output: {
      format: 'mp4',
      resolution: 'hd',
      fps: 30,
      quality: 'high',
    },
  };

  console.log('[buildShotstackTimeline] Timeline built', {
    trackCount: nonEmptyTracks.length,
    videoClips: videoClips.length,
    captionClips: captionClips.length,
    sfxClips: sfxClips.length,
    shotstackFilter,
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
  const apiKeyPreview = `${process.env.SHOTSTACK_API_KEY.slice(0, 10)}...`;

  console.log(`\n${'='.repeat(70)}`);
  console.log('SUBMITTING TO SHOTSTACK');
  console.log('='.repeat(70));
  console.log('Shotstack endpoint:', apiUrl);
  console.log('Shotstack API key configured:', apiKeyPreview);
  console.log('\nTimeline payload:');
  console.log(JSON.stringify(timeline, null, 2));
  console.log('\nTimeline tracks:', timeline?.timeline?.tracks?.length || 0);
  console.log('Track[0] clips:', timeline?.timeline?.tracks?.[0]?.clips?.length || 0);
  console.log('Track[1] clips:', timeline?.timeline?.tracks?.[1]?.clips?.length || 0);
  console.log('Track[2] clips:', timeline?.timeline?.tracks?.[2]?.clips?.length || 0);

  validateTimelinePayload(timeline);

  try {
    const response = await axios.post(apiUrl, timeline, {
      headers: {
        'x-api-key': process.env.SHOTSTACK_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
      validateStatus: () => true,
    });
    console.log('\nShotstack response status:', response.status);
    console.log('Shotstack response body:', JSON.stringify(response.data, null, 2));

    if (response.status < 200 || response.status >= 300) {
      console.error('\n❌ SHOTSTACK ERROR RESPONSE:');
      console.error(JSON.stringify(response.data, null, 2));
      throw new Error(`Shotstack API error (${response.status}): ${JSON.stringify(response.data)}`);
    }

    const renderId = response?.data?.response?.id;
    const status = response?.data?.response?.status;
    if (!renderId) {
      throw new Error('Shotstack response missing render ID');
    }
    console.log('\n✅ Shotstack render submitted successfully');
    console.log('Render ID:', renderId);
    console.log('Render status:', status);
    console.log('='.repeat(70) + '\n');
    return { renderId, status };
  } catch (error) {
    const responseStatus = error?.response?.status;
    const responseData = error?.response?.data;
    console.error('\n❌ submitToShotstack failed:');
    console.error('Error:', error?.message || error);
    if (responseStatus) console.error('HTTP status:', responseStatus);
    if (responseData) console.error('HTTP body:', JSON.stringify(responseData, null, 2));
    if (error?.stack) console.error('Stack:', error.stack);

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
