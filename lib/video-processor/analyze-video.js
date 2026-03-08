/**
 * analyze-video.js — Gemini Flash deep video analysis
 * 
 * Uploads video to Gemini and extracts comprehensive understanding:
 * - Shot-by-shot breakdown with camera movement, composition, energy
 * - Precise speech segments with timestamps and sentence boundaries
 * - Audio landscape (music, silence, ambient, beats)
 * - Safe cut points where edits won't feel jarring
 * - Overall video profile (mood arc, peak moments, pacing)
 *
 * This rich analysis feeds into Claude so it can make truly intelligent
 * editing decisions instead of guessing from vague descriptions.
 */

const axios = require('axios');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_UPLOAD_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const GEMINI_FILES_URL = 'https://generativelanguage.googleapis.com/v1beta/files';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_GENERATE_TIMEOUT_MS = 180_000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadVideo(videoUrl) {
  const response = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120_000 });
  const mimeType = response.headers['content-type'] || 'video/mp4';
  return { buffer: Buffer.from(response.data), mimeType };
}

async function uploadToGemini(buffer, mimeType, displayName) {
  const initResponse = await axios.post(
    `${GEMINI_UPLOAD_URL}?key=${GEMINI_API_KEY}`,
    JSON.stringify({ file: { display_name: displayName } }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': buffer.length,
        'X-Goog-Upload-Header-Content-Type': mimeType,
      },
      validateStatus: (s) => s >= 200 && s < 300,
    }
  );

  const uploadUrl = initResponse.headers['x-goog-upload-url'];
  if (!uploadUrl) {
    throw new Error('Gemini Files API did not return an upload URL');
  }

  const uploadResponse = await axios.put(uploadUrl, buffer, {
    headers: {
      'Content-Length': buffer.length,
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 300_000,
  });

  return uploadResponse.data.file;
}

async function waitForFileActive(fileName, onProgress, maxWaitMs = 120_000) {
  const startTime = Date.now();
  let attempts = 0;
  const fileId = fileName.startsWith('files/') ? fileName.replace('files/', '') : fileName;

  while (Date.now() - startTime < maxWaitMs) {
    const response = await axios.get(
      `${GEMINI_FILES_URL}/${fileId}?key=${GEMINI_API_KEY}`
    );
    const state = response.data.state;

    if (state === 'ACTIVE') {
      return response.data;
    }

    if (state === 'FAILED') {
      throw new Error(`Gemini file processing failed: ${JSON.stringify(response.data.error || {})}`);
    }

    attempts++;
    if (onProgress) {
      onProgress({ step: 'analyzing', detail: `Processing video (attempt ${attempts})...` });
    }

    await sleep(2000);
  }

  throw new Error(`Gemini file processing timed out after ${maxWaitMs / 1000}s`);
}

function buildAnalysisPrompt() {
  return `You are analyzing video footage for a professional editor. Your job is to describe what you SEE — the visuals, the shots, the lighting, the energy. Do NOT transcribe or timestamp the speech; that will be handled separately by a dedicated audio tool.

Watch the ENTIRE video from first frame to last frame.
Describe each visually distinct segment of the video. Focus on what you see — the lighting, the framing, the action, the energy.
Frame layout analysis: Look at where the main subject is positioned in the frame. Report whether the video already has any burned-in text, captions, subtitles, logos, or lower-third graphics. Note where these existing overlays appear. Identify any open/free areas of the frame where new text could be placed without covering the subject or conflicting with existing graphics.

CRITICAL TIMESTAMP RULES:
- All timestamps must be in SECONDS (e.g. 15.000 for the 15-second mark, NOT 0.25).
- The last shot must end at or very near the total duration.
- Millisecond precision: three decimal places (1.234).

Return ONLY valid JSON:

{
  "duration": <total seconds, e.g. 38.780>,

  "shots": [
    {
      "visual": "<Lighting, color temp, exposure, dominant tones>",
      "action": "<What the subject is doing>",
      "energy": <0.0 to 1.0>,
      "editing_value": "<essential | strong | usable | filler | dead>"
    }
  ],

  "audio": {
    "music": "<genre/tempo/energy if present, or 'none'>"
  },

  "footage_assessment": {
    "content_type": "<what kind of video>",
    "visual_character": "<color palette, lighting, exposure, white balance>",
    "strongest_moments": "<timestamps and what makes them compelling>",
    "weakest_moments": "<timestamps and why they are weak, or 'none'>",
    "editing_brief": "<how to edit this: what to keep, what to cut, pacing, feel>"
  },

  "frame_layout": {
    "subject_position": "<where the main subject/person is in the frame>",
    "existing_overlays": {
      "has_burned_captions": <true|false>,
      "has_text_graphics": <true|false>,
      "overlay_locations": "<where existing text/graphics appear>"
    },
    "free_zones": "<areas of the frame with no subject or existing text>"
  },

  "color_baseline": {
    "assessment": "<what you see: overexposed, flat, warm-cast, etc.>",
    "brightness": <-1.0 to 1.0, 0 if good>,
    "contrast": <0.0 to 3.0, 1.0 if good>,
    "saturation": <0.0 to 3.0, 1.0 if good>,
    "gamma": <0.1 to 3.0, 1.0 if good>,
    "color_temperature": "<neutral | warm | cool>"
  }
}

Focus on visual accuracy — every shift in framing or content.`;
}

async function promptGemini(fileUri, mimeType) {
  const startedAt = Date.now();
  console.log('[analyze] Starting Gemini generateContent call...');
  let response;
  try {
    response = await axios.post(
      `${GEMINI_GENERATE_URL}?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [
              {
                fileData: {
                  mimeType: mimeType,
                  fileUri: fileUri,
                },
              },
              {
                text: buildAnalysisPrompt(),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 65536,
          responseMimeType: 'application/json',
        },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: GEMINI_GENERATE_TIMEOUT_MS,
      }
    );
  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : 'none';
    console.error(
      `[analyze] Gemini generateContent failed after ${Date.now() - startedAt}ms (status: ${status || 'n/a'})`
    );
    console.error(`[analyze] Gemini error body (truncated): ${body}`);
    throw err;
  }
  console.log(`[analyze] Gemini generateContent complete in ${Date.now() - startedAt}ms`);

  const candidate = response.data.candidates?.[0];
  if (!candidate || !candidate.content?.parts?.length) {
    throw new Error('Gemini returned no content');
  }

  return candidate.content.parts[0].text;
}

function repairAndParseJSON(str) {
  let s = str;

  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');

  // If string is truncated mid-value, try to close it
  // Count open braces/brackets
  let braces = 0, brackets = 0, inString = false, escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braces++;
    if (ch === '}') braces--;
    if (ch === '[') brackets++;
    if (ch === ']') brackets--;
  }

  // If we're inside a string, close it
  if (inString) {
    s += '"';
  }

  // Remove any trailing partial key-value pair
  // (e.g., string ends with `"key": "partial val` after closing the quote)
  // Try to find the last complete property
  const lastCompleteComma = s.lastIndexOf(',');
  const lastCompleteBrace = s.lastIndexOf('}');
  const lastCompleteBracket = s.lastIndexOf(']');

  if (braces > 0 || brackets > 0) {
    // Truncated — try trimming back to last complete value
    const lastGoodEnd = Math.max(lastCompleteBrace, lastCompleteBracket, lastCompleteComma);
    if (lastGoodEnd > s.length * 0.5) {
      // Only trim if we're past halfway — don't lose too much data
      s = s.substring(0, lastGoodEnd + 1);
      // Remove trailing comma if present
      s = s.replace(/,\s*$/, '');
    }

    // Close remaining open structures
    while (brackets > 0) { s += ']'; brackets--; }
    while (braces > 0) { s += '}'; braces--; }
  }

  return JSON.parse(s);
}

/**
 * Detect and fix Gemini returning timestamps in minutes instead of seconds.
 *
 * Gemini non-deterministically returns timestamps in either seconds or minutes.
 * When in minutes: duration=0.388 for a 39s video, shots end at 0.249 (14.9s).
 * When in seconds: duration=39, shots end at 24.9.
 *
 * Detection: if the max timestamp across the entire analysis is < 2.0 and there
 * are more than 2 timestamp values, these are almost certainly in minutes.
 * No real video analysis would have all timestamps under 2 seconds.
 *
 * We multiply ALL numeric timestamp fields by 60 to convert minutes → seconds.
 */
function normalizeTimestamps(parsed) {
  const duration = typeof parsed.duration === 'number' ? parsed.duration : 0;

  // Collect all timestamp-like values to check
  const allTimestamps = [];
  const nonDurationTimestamps = [];
  if (duration > 0) allTimestamps.push(duration);

  if (Array.isArray(parsed.shots)) {
    for (const shot of parsed.shots) {
      if (typeof shot.start === 'number') { allTimestamps.push(shot.start); nonDurationTimestamps.push(shot.start); }
      if (typeof shot.end === 'number') { allTimestamps.push(shot.end); nonDurationTimestamps.push(shot.end); }
    }
  }

  if (Array.isArray(parsed.cut_points)) {
    for (const cp of parsed.cut_points) {
      if (typeof cp.time === 'number') { allTimestamps.push(cp.time); nonDurationTimestamps.push(cp.time); }
    }
  }

  if (Array.isArray(parsed.safe_cut_points)) {
    for (const cp of parsed.safe_cut_points) {
      if (typeof cp.time === 'number') { allTimestamps.push(cp.time); nonDurationTimestamps.push(cp.time); }
    }
  }

  if (allTimestamps.length === 0) return parsed;

  const maxTimestamp = Math.max(...allTimestamps);
  const maxNonDuration = nonDurationTimestamps.length > 0 ? Math.max(...nonDurationTimestamps) : 0;

  // --- Check 1: All timestamps in minutes (including duration) ---
  // If max timestamp < 2.0 with enough data points, timestamps are in minutes
  const needsMinuteConversion = maxTimestamp < 2.0 && allTimestamps.length > 2;

  if (needsMinuteConversion) {
    console.warn(`[analyze] ⚠️ TIMESTAMP UNIT FIX: Max timestamp is ${maxTimestamp.toFixed(3)} — Gemini returned minutes, converting to seconds (×60)`);
    return applyTimestampMultiplier(parsed, 60, 'minutes→seconds');
  }

  // --- Check 2: Duration is in seconds but timestamps are normalized 0-1 ---
  // Gemini sometimes returns duration=39 but all other timestamps as 0.xx
  // Detection: duration > 5 AND max non-duration timestamp < 1.5 AND that max
  // is < 5% of duration. This means timestamps are fractional (0-1 range).
  // Multiply by duration to convert to real seconds.
  const needsScaleConversion = duration > 5
    && nonDurationTimestamps.length > 2
    && maxNonDuration < 1.5
    && maxNonDuration < duration * 0.05;

  if (needsScaleConversion) {
    console.warn(`[analyze] ⚠️ TIMESTAMP SCALE FIX: Duration is ${duration}s but max event timestamp is ${maxNonDuration.toFixed(3)} — Gemini returned normalized 0-1 range, scaling by duration (×${duration})`);
    return applyTimestampMultiplier(parsed, duration, 'normalized→seconds', true);
  }

  // ── OVERSHOOT FIX ──────────────────────────────────────────────
  // Gemini sometimes returns correct duration but drifts timestamps
  // past it (e.g. duration=39 but speech goes to 62.9).
  // Detect this by comparing max timestamp across ALL fields to duration.
  // If timestamps overshoot, scale them proportionally back into range.
  // ────────────────────────────────────────────────────────────────

  // Collect timestamps from ALL fields, not just shots and cut_points
  let maxAll = 0;

  if (Array.isArray(parsed.shots)) {
    for (const s of parsed.shots) {
      if (typeof s.start === 'number') maxAll = Math.max(maxAll, s.start);
      if (typeof s.end === 'number') maxAll = Math.max(maxAll, s.end);
    }
  }
  if (parsed.speech?.segments) {
    for (const s of parsed.speech.segments) {
      if (typeof s.start === 'number') maxAll = Math.max(maxAll, s.start);
      if (typeof s.end === 'number') maxAll = Math.max(maxAll, s.end);
    }
  }
  if (parsed.speech?.sentence_boundaries) {
    for (const b of parsed.speech.sentence_boundaries) {
      if (typeof b.time === 'number') maxAll = Math.max(maxAll, b.time);
    }
  }
  if (Array.isArray(parsed.cut_points)) {
    for (const cp of parsed.cut_points) {
      if (typeof cp.time === 'number') maxAll = Math.max(maxAll, cp.time);
    }
  }
  if (Array.isArray(parsed.safe_cut_points)) {
    for (const cp of parsed.safe_cut_points) {
      if (typeof cp.time === 'number') maxAll = Math.max(maxAll, cp.time);
    }
  }
  if (Array.isArray(parsed.highlights)) {
    for (const h of parsed.highlights) {
      if (typeof h.time === 'number') maxAll = Math.max(maxAll, h.time);
    }
  }
  if (Array.isArray(parsed.peak_moments)) {
    for (const pm of parsed.peak_moments) {
      if (typeof pm.time === 'number') maxAll = Math.max(maxAll, pm.time);
    }
  }

  if (duration > 0 && maxAll > duration * 1.1) {
    console.warn(`[analyze] ⚠️ TIMESTAMP OVERSHOOT FIX: Duration is ${duration}s but max timestamp is ${maxAll.toFixed(3)}s — scaling all timestamps by ×${(duration / maxAll).toFixed(4)}`);
    return applyTimestampMultiplier(parsed, duration / maxAll, 'overshoot→scaled', true);
  }

  return parsed;
}

/**
 * Multiply all timestamp fields by a given factor.
 * If skipDuration is true, leave parsed.duration as-is (already correct).
 */
function applyTimestampMultiplier(parsed, multiplier, label, skipDuration = false) {
  const fixed = JSON.parse(JSON.stringify(parsed));
  const originalDuration = parsed.duration;

  if (!skipDuration && typeof fixed.duration === 'number') fixed.duration *= multiplier;

  if (Array.isArray(fixed.shots)) {
    for (const shot of fixed.shots) {
      if (typeof shot.start === 'number') shot.start *= multiplier;
      if (typeof shot.end === 'number') shot.end *= multiplier;
    }
  }

  if (fixed.speech?.segments && Array.isArray(fixed.speech.segments)) {
    for (const seg of fixed.speech.segments) {
      if (typeof seg.start === 'number') seg.start *= multiplier;
      if (typeof seg.end === 'number') seg.end *= multiplier;
    }
  }

  if (fixed.speech?.sentence_boundaries && Array.isArray(fixed.speech.sentence_boundaries)) {
    for (const sb of fixed.speech.sentence_boundaries) {
      if (typeof sb.time === 'number') sb.time *= multiplier;
      if (typeof sb.end_time === 'number') sb.end_time *= multiplier;
      // Only scale pause_after if it also looks normalized
      if (typeof sb.pause_after === 'number' && sb.pause_after < 0.5) sb.pause_after *= multiplier;
      if (typeof sb.pause_duration === 'number' && sb.pause_duration < 0.5) sb.pause_duration *= multiplier;
    }
  }

  if (Array.isArray(fixed.cut_points)) {
    for (const cp of fixed.cut_points) {
      if (typeof cp.time === 'number') cp.time *= multiplier;
    }
  }

  if (Array.isArray(fixed.safe_cut_points)) {
    for (const cp of fixed.safe_cut_points) {
      if (typeof cp.time === 'number') cp.time *= multiplier;
    }
  }

  if (Array.isArray(fixed.highlights)) {
    for (const h of fixed.highlights) {
      if (typeof h.time === 'number') h.time *= multiplier;
    }
  }

  if (Array.isArray(fixed.peak_moments)) {
    for (const h of fixed.peak_moments) {
      if (typeof h.time === 'number') h.time *= multiplier;
    }
  }

  const resultDuration = skipDuration ? originalDuration : fixed.duration;
  console.log(`[analyze] ${label}: max event timestamp ${(parsed.shots?.[parsed.shots.length - 1]?.end || 0).toFixed(3)} → ${(fixed.shots?.[fixed.shots.length - 1]?.end || 0).toFixed(1)}s (duration: ${resultDuration?.toFixed(1)}s)`);

  return fixed;
}

function parseAnalysisResponse(text) {
  let jsonStr = text;

  // Strip markdown fences if present
  jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  jsonStr = jsonStr.trim();

  // Try direct parse first
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (firstError) {
    console.warn(`[analyze] Direct JSON parse failed: ${firstError.message}`);
    console.warn(`[analyze] Attempting JSON repair...`);

    // Repair attempt: fix common LLM JSON issues
    try {
      parsed = repairAndParseJSON(jsonStr);
      console.log(`[analyze] JSON repair succeeded`);
    } catch (repairError) {
      // Log first 500 chars for debugging
      const preview = jsonStr.substring(0, 500);
      throw new Error(`Failed to parse Gemini analysis JSON: ${firstError.message}\nRaw: ${preview}`);
    }
  }

  // === CRITICAL: Normalize timestamps before anything else ===
  // Gemini non-deterministically returns timestamps in minutes or seconds.
  // This must happen before any field extraction so all downstream code
  // always sees seconds.
  if (!parsed.speech) {
    parsed.speech = { has_speech: false, segments: [], sentence_boundaries: [] };
  }
  if (!parsed.safe_cut_points) parsed.safe_cut_points = [];
  if (!parsed.peak_moments) parsed.peak_moments = [];
  if (!parsed.highlights) parsed.highlights = [];
  if (parsed.footage_assessment && !parsed.video_profile) {
    parsed.video_profile = parsed.footage_assessment;
  }
  parsed = normalizeTimestamps(parsed);

  const duration = typeof parsed.duration === 'number' ? parsed.duration : 0;

  const shots = Array.isArray(parsed.shots)
    ? parsed.shots.map((shot, i) => ({
        start: typeof shot.start === 'number' ? shot.start : 0,
        end: typeof shot.end === 'number' ? shot.end : duration,
        visual: shot.visual || '',
        action: shot.action || '',
        energy: typeof shot.energy === 'number' ? shot.energy : 0.5,
        editing_value: shot.editing_value || '',
        // Keep backward compat for buildPrompt
        description: shot.action || shot.visual || `Shot ${i + 1}`,
        score: typeof shot.energy === 'number' ? shot.energy : 0.5,
      }))
    : [{ start: 0, end: duration, description: 'Full video', score: 0.5 }];

  const speech = parsed.speech || { has_speech: false, segments: [], sentence_boundaries: [] };
  const audio = parsed.audio || {};
  const safeCutPoints = Array.isArray(parsed.cut_points) ? parsed.cut_points :
                        Array.isArray(parsed.safe_cut_points) ? parsed.safe_cut_points : [];
  const peakMoments = Array.isArray(parsed.highlights) ? parsed.highlights :
                      Array.isArray(parsed.peak_moments) ? parsed.peak_moments : [];
  const footageAssessment = parsed.footage_assessment || parsed.video_profile || {};
  const rawFrameLayout = parsed.frame_layout || {};
  const frameLayout = {
    subject_position: typeof rawFrameLayout.subject_position === 'string'
      ? rawFrameLayout.subject_position
      : 'unknown',
    existing_overlays: {
      has_burned_captions: Boolean(rawFrameLayout?.existing_overlays?.has_burned_captions),
      has_text_graphics: Boolean(rawFrameLayout?.existing_overlays?.has_text_graphics),
      overlay_locations: typeof rawFrameLayout?.existing_overlays?.overlay_locations === 'string'
        ? rawFrameLayout.existing_overlays.overlay_locations
        : 'none detected',
    },
    free_zones: typeof rawFrameLayout.free_zones === 'string'
      ? rawFrameLayout.free_zones
      : 'unknown',
  };
  const rawColorBaseline = parsed.color_baseline || {};
  const colorBaseline = {
    assessment: typeof rawColorBaseline.assessment === 'string' ? rawColorBaseline.assessment : '',
    brightness: typeof rawColorBaseline.brightness === 'number' ? rawColorBaseline.brightness : 0,
    contrast: typeof rawColorBaseline.contrast === 'number' ? rawColorBaseline.contrast : 1,
    saturation: typeof rawColorBaseline.saturation === 'number' ? rawColorBaseline.saturation : 1,
    gamma: typeof rawColorBaseline.gamma === 'number' ? rawColorBaseline.gamma : 1,
    color_temperature: ['warm', 'cool', 'neutral'].includes(rawColorBaseline.color_temperature)
      ? rawColorBaseline.color_temperature
      : 'neutral',
  };

  if (parsed.color_baseline) {
    console.log(
      `[analyze] Color baseline: b=${colorBaseline.brightness}, c=${colorBaseline.contrast}, s=${colorBaseline.saturation}, g=${colorBaseline.gamma}, temp=${colorBaseline.color_temperature}`
    );
  }

  return {
    duration,
    shots,
    speech,
    audio,
    safe_cut_points: safeCutPoints,
    peak_moments: peakMoments,
    video_profile: footageAssessment,
    frame_layout: frameLayout,
    color_baseline: colorBaseline,
    metadata: parsed.metadata || {},
  };
}

async function analyzeVideo(videoUrl, onProgress) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  if (onProgress) onProgress({ step: 'analyzing', detail: 'Downloading video...' });
  let { buffer, mimeType } = await downloadVideo(videoUrl);
  console.log(`[analyze] Downloaded video: ${(buffer.length / 1024 / 1024).toFixed(1)}MB, type: ${mimeType}`);

  if (onProgress) onProgress({ step: 'analyzing', detail: 'Uploading to Gemini...' });
  const fileName = `promptly-${Date.now()}`;
  const fileResource = await uploadToGemini(buffer, mimeType, fileName);
  // Release upload buffer as soon as Gemini returns a file handle.
  buffer = null;
  console.log(`[analyze] Uploaded to Gemini: ${fileResource.name}, state: ${fileResource.state}`);

  let activeFile = fileResource;
  if (fileResource.state !== 'ACTIVE') {
    if (onProgress) onProgress({ step: 'analyzing', detail: 'Waiting for video processing...' });
    activeFile = await waitForFileActive(fileResource.name, onProgress);
  }
  console.log(`[analyze] File active: ${activeFile.uri}`);

  if (onProgress) onProgress({ step: 'analyzing', detail: 'Performing deep video analysis...' });
  let rawResponse = await promptGemini(activeFile.uri, mimeType);
  console.log(`[analyze] Gemini response received (${rawResponse.length} chars)`);

  console.log('[analyze] Starting Gemini JSON parse...');
  let analysis;
  try {
    analysis = parseAnalysisResponse(rawResponse);
  } catch (err) {
    console.error('[analyze] FAILED parsing Gemini response:', err.message, err.stack);
    throw err;
  }
  console.log('[analyze] Gemini JSON parse complete');
  rawResponse = null;
  const videoDuration = Number(analysis?.duration || 0);
  const shots = Array.isArray(analysis?.shots) ? analysis.shots : [];
  const totalShotDuration = shots.reduce((sum, s) => {
    const start = Number(s?.start || 0);
    const end = Number(s?.end || start);
    return sum + Math.max(0, end - start);
  }, 0);
  if (videoDuration > 0 && totalShotDuration < videoDuration * 0.5) {
    console.error(
      `[analyze] WARNING: Gemini shots only cover ${totalShotDuration.toFixed(1)}s `
      + `of ${videoDuration.toFixed(1)}s video`
    );
  }
  const shortShots = shots.filter((s) => {
    const start = Number(s?.start || 0);
    const end = Number(s?.end || start);
    return (end - start) < 0.05;
  });
  if (shortShots.length > 3) {
    console.error(
      `[analyze] WARNING: ${shortShots.length} shots are under 50ms — Gemini timestamps may be incorrect`
    );
  }
  console.log(`[analyze] Analysis complete: ${analysis.duration}s, ${analysis.shots.length} shots, ${analysis.safe_cut_points.length} cut points, ${analysis.speech.segments?.length || 0} speech segments`);

  return analysis;
}

module.exports = { analyzeVideo };
