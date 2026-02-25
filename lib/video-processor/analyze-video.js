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
  return `You are the editor's eyes and ears. A professional video editor is about to cut this footage into a polished social media clip, but they cannot watch the video themselves. You are watching and listening for them.

Your job: give the editor a complete timing map of this footage — every shot, every sentence, every breath gap, every shift in energy — so they can place every cut at exactly the right millisecond. You must watch the ENTIRE video from the first frame to the last frame. Do not stop partway through.

CRITICAL TIMESTAMP RULES:
- All timestamps must be in SECONDS with MILLISECOND precision (three decimal places: 1.234, not 1.23).
- A 39-second video has duration 39.000, not 0.65.
- A moment at the 15-second mark is 15.000, not 0.25.
- The last shot must end at or very near the total duration. If the video is 39 seconds, your last shot must end near 39.000.
- If your timestamps are off by even a tenth of a second, the edit will land mid-word or clip a breath.

Return ONLY valid JSON:

{
  "duration": <total seconds with millisecond precision — e.g. 38.780 for a 38.78-second video>,

  "shots": [
    {
      "start": <seconds from start of video to 0.001s>,
      "end": <seconds from start of video to 0.001s>,
      "visual": "<Lighting, color temp, exposure, dominant tones — only what affects color grading>",
      "action": "<What the subject is doing or communicating>",
      "energy": <0.0 to 1.0>,
      "editing_value": "<One of: essential, strong, usable, filler, dead — and why>"
    }
  ],

  "speech": {
    "has_speech": <boolean>,
    "speaker_style": "<Pace, rhythm, pause habits — what affects where cuts can land>",
    "segments": [
      {
        "start": <seconds to 0.001s>,
        "end": <seconds to 0.001s>,
        "text": "<exact words>",
        "emotion": "<one or two words: delivery tone>",
        "energy_level": <0.0 to 1.0>,
        "notes": "<Only stumbles, restarts, laughs, or emphasis that affect edit timing. Leave empty if none.>"
      }
    ],
    "sentence_boundaries": [
      {
        "time": <seconds to 0.001s — the exact moment the last word ends>,
        "pause_after": <seconds of silence before next sentence>,
        "context": "<Topic ending → topic starting>"
      }
    ]
  },

  "audio": {
    "music": "<If present: genre, tempo, energy. If none: none>"
  },

  "cut_points": [
    {
      "time": <seconds to 0.001s>,
      "quality": <0.0 to 1.0>,
      "why": "<Reason: sentence end, breath gap, topic shift, energy change, scene change>"
    }
  ],

  "highlights": [
    {
      "time": <seconds to 0.001s>,
      "what": "<What happens here>",
      "importance": <0.0 to 1.0>
    }
  ],

  "footage_assessment": {
    "content_type": "<what kind of video>",
    "visual_character": "<Overall look: color palette, lighting, exposure, white balance. Directly informs color grading.>",
    "strongest_moments": "<Timestamps and what makes them compelling>",
    "weakest_moments": "<Timestamps and why they are filler or dead>",
    "recommended_duration": <15-30>,
    "editing_brief": "<How to edit this: what to keep, what to cut, how to pace it, what the final piece should feel like.>"
  },

  "color_baseline": {
    "assessment": "<What you see: overexposed, underexposed, flat, warm-cast, etc.>",
    "brightness": <corrective value, 0 if good, range -1.0 to 1.0>,
    "contrast": <corrective multiplier, 1.0 if good, range 0.0 to 3.0>,
    "saturation": <corrective multiplier, 1.0 if good, range 0.0 to 3.0>,
    "gamma": <corrective value, 1.0 if good, range 0.1 to 3.0>,
    "color_temperature": "<'neutral' if white balance is correct, 'warm' if footage needs warming, 'cool' if footage needs cooling>"
  }
}

You MUST analyze the complete video from start to finish. The shots array must span from 0.000 to the end of the video with no gaps. Every word spoken must appear in a speech segment. Provide as many cut points as possible — the more options the editor has, the better the edit. Prioritize timestamp accuracy on speech above everything else.

REMINDER: All numeric timestamps are in SECONDS with three decimal places. duration is in SECONDS.`;
}

async function promptGemini(fileUri, mimeType) {
  const response = await axios.post(
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
      timeout: 120_000,
    }
  );

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
    color_baseline: colorBaseline,
    metadata: parsed.metadata || {},
  };
}

async function analyzeVideo(videoUrl, onProgress) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  if (onProgress) onProgress({ step: 'analyzing', detail: 'Downloading video...' });
  const { buffer, mimeType } = await downloadVideo(videoUrl);
  console.log(`[analyze] Downloaded video: ${(buffer.length / 1024 / 1024).toFixed(1)}MB, type: ${mimeType}`);

  if (onProgress) onProgress({ step: 'analyzing', detail: 'Uploading to Gemini...' });
  const fileName = `promptly-${Date.now()}`;
  const fileResource = await uploadToGemini(buffer, mimeType, fileName);
  console.log(`[analyze] Uploaded to Gemini: ${fileResource.name}, state: ${fileResource.state}`);

  let activeFile = fileResource;
  if (fileResource.state !== 'ACTIVE') {
    if (onProgress) onProgress({ step: 'analyzing', detail: 'Waiting for video processing...' });
    activeFile = await waitForFileActive(fileResource.name, onProgress);
  }
  console.log(`[analyze] File active: ${activeFile.uri}`);

  if (onProgress) onProgress({ step: 'analyzing', detail: 'Performing deep video analysis...' });
  const rawResponse = await promptGemini(activeFile.uri, mimeType);
  console.log(`[analyze] Gemini response received (${rawResponse.length} chars)`);

  const analysis = parseAnalysisResponse(rawResponse);
  console.log(`[analyze] Analysis complete: ${analysis.duration}s, ${analysis.shots.length} shots, ${analysis.safe_cut_points.length} cut points, ${analysis.speech.segments?.length || 0} speech segments`);

  return analysis;
}

module.exports = { analyzeVideo };
