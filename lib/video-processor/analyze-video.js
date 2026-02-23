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

Your job: give the editor a complete timing map of this footage so they can place every cut at exactly the right millisecond, understand the energy and flow of the content, and know what the footage looks and sounds like for color and audio decisions.

All timestamps must be precise to 0.01 seconds. The editor will cut at the exact moments you report. If your timestamps are off by even a tenth of a second, the edit will land mid-word or clip a breath. Precision is everything.

Return ONLY valid JSON:

{
  "duration": <total seconds>,

  "shots": [
    {
      "start": <number>,
      "end": <number>,
      "visual": "<What the frame looks like: light quality, color temperature, exposure, dominant tones, depth of field. Focus on what affects color grading and framing.>",
      "action": "<What is happening and what draws attention. What the subject is doing, showing, or communicating.>",
      "energy": <0.0 to 1.0>,
      "editing_value": "<Why keep or cut this? Essential, filler, transitional, strongest take? What role in the story?>"
    }
  ],

  "speech": {
    "has_speech": <boolean>,
    "speaker_style": "<How the speaker delivers: pace, rhythm, energy, vocal habits, breathing patterns. What the editor needs to know to cut around their natural rhythm.>",
    "segments": [
      {
        "start": <to 0.01s>,
        "end": <to 0.01s>,
        "text": "<exact words>",
        "emotion": "<delivery tone>",
        "energy_level": <0.0 to 1.0>,
        "notes": "<Anything affecting edit timing: speed changes, emphasis, pauses, stumbles, laughter, restarts>"
      }
    ],
    "sentence_boundaries": [
      {
        "time": <to 0.01s — the exact moment the last word ends>,
        "pause_after": <seconds of silence before next sentence>,
        "context": "<what thought just completed and what starts next>"
      }
    ]
  },

  "audio": {
    "overall_quality": "<Mic quality, room sound, background noise, clarity>",
    "music": "<If present: genre, tempo, energy, how it interacts with speech. If none: say none>",
    "energy_arc": "<How audio energy evolves across the video, mapped to timestamps>"
  },

  "cut_points": [
    {
      "time": <to 0.01s>,
      "quality": <0.0 to 1.0>,
      "why": "<Specific reason: sentence ends, breath gap, topic shift, energy change, scene change>"
    }
  ],

  "highlights": [
    {
      "time": <number>,
      "what": "<What happens here that an audience would care about>",
      "importance": <0.0 to 1.0>
    }
  ],

  "footage_assessment": {
    "content_type": "<what kind of video>",
    "energy_arc": "<how energy moves through the video with timestamps>",
    "visual_character": "<The overall look: color palette, lighting quality, exposure, white balance, contrast. Directly informs color grading.>",
    "audio_character": "<Overall sound: voice clarity, room tone, noise level>",
    "strongest_moments": "<Which parts are most compelling and why>",
    "weakest_moments": "<Which parts are filler, dead air, or low energy>",
    "recommended_duration": <15-30>,
    "editing_brief": "<One paragraph: how you would edit this footage. What to keep, what to cut, how to pace it, what the final piece should feel like.>"
  }
}

Provide as many cut points as possible — the more options the editor has, the better the edit. Prioritize timestamp accuracy on speech above everything else.`;
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

function parseAnalysisResponse(rawText) {
  let parsed;
  try {
    const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse Gemini analysis JSON: ${err.message}\nRaw: ${rawText.slice(0, 500)}`);
  }

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
  const audio = parsed.audio || { has_music: false };
  const safeCutPoints = Array.isArray(parsed.cut_points) ? parsed.cut_points :
                        Array.isArray(parsed.safe_cut_points) ? parsed.safe_cut_points : [];
  const peakMoments = Array.isArray(parsed.highlights) ? parsed.highlights :
                      Array.isArray(parsed.peak_moments) ? parsed.peak_moments : [];
  const footageAssessment = parsed.footage_assessment || parsed.video_profile || {};

  return {
    duration,
    shots,
    speech,
    audio,
    safe_cut_points: safeCutPoints,
    peak_moments: peakMoments,
    video_profile: footageAssessment,
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
