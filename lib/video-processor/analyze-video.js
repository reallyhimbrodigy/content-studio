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
  return `You are an expert video analyst and professional video editor. Watch this video extremely carefully — every frame, every sound, every word spoken. Your analysis will be used to make intelligent automated editing decisions, so accuracy and detail are critical.

Analyze the video thoroughly and return a JSON object with the structure below. Return ONLY valid JSON, no markdown fences, no commentary.

{
  "duration": <total duration in seconds>,

  "shots": [
    {
      "start": <start time in seconds, precise to 0.1s>,
      "end": <end time in seconds, precise to 0.1s>,
      "description": "<what is visually happening — be specific and actionable>",
      "camera": "<static | pan_left | pan_right | tilt_up | tilt_down | zoom_in | zoom_out | handheld | tracking>",
      "composition": "<close_up | medium | wide | extreme_close_up | over_shoulder>",
      "movement_energy": <0.0 to 1.0 — how much motion/action is in this shot>,
      "visual_interest": <0.0 to 1.0 — how compelling/important this shot is>,
      "dominant_colors": "<brief color description: warm tones, cool blue, etc.>",
      "lighting": "<bright | dim | natural | dramatic | backlit | mixed>"
    }
  ],

  "speech": {
    "has_speech": <true | false>,
    "segments": [
      {
        "start": <when this speech segment begins, precise to 0.1s>,
        "end": <when this speech segment ends, precise to 0.1s>,
        "text": "<what is being said — transcribe as accurately as possible>",
        "speaker": "<speaker_1 | speaker_2 | etc. if multiple speakers>",
        "emotion": "<neutral | excited | serious | funny | emotional | angry | calm>",
        "emphasis_moments": [
          {
            "time": <timestamp of a key word or phrase>,
            "word": "<the emphasized word or short phrase>",
            "reason": "<why this moment matters: punchline, key point, reaction, etc.>"
          }
        ]
      }
    ],
    "sentence_boundaries": [
      {
        "end_time": <timestamp where a complete sentence/thought ends>,
        "is_safe_cut": <true if cutting here would feel natural>
      }
    ]
  },

  "audio": {
    "has_music": <true | false>,
    "music_description": "<genre, energy, tempo if music is present>",
    "beat_moments": [<timestamps of strong musical beats or drops, if any>],
    "silence_gaps": [
      {"start": <number>, "end": <number>}
    ],
    "ambient_description": "<what non-speech, non-music audio is present>",
    "energy_arc": "<description of how audio energy changes over time>"
  },

  "safe_cut_points": [
    {
      "time": <timestamp where a cut would feel natural>,
      "reason": "<why: sentence break, scene change, pause, beat drop, action peak, etc.>",
      "quality": <0.0 to 1.0 — how clean this cut point would be>
    }
  ],

  "peak_moments": [
    {
      "time": <timestamp>,
      "type": "<reaction | punchline | reveal | action_peak | emotional_peak | visual_highlight>",
      "description": "<what makes this moment compelling>",
      "importance": <0.0 to 1.0>
    }
  ],

  "video_profile": {
    "content_type": "<talking_head | vlog | tutorial | product_demo | action | scenery | interview | skit | montage | other>",
    "mood_arc": "<how the energy/mood shifts across the video>",
    "primary_subject": "<main subject or focus of the video>",
    "overall_energy": "<low | medium | high>",
    "recommended_output_duration": <suggested output length in seconds for social media, between 15-30>,
    "key_takeaway": "<one sentence summary of the video's content or message>"
  },

  "metadata": {
    "resolution": "<width>x<height> if discernible, or null",
    "orientation": "<portrait | landscape | square>",
    "frame_rate_estimate": "<number or null>",
    "overall_quality": "<low | medium | high — production quality assessment>"
  }
}

CRITICAL GUIDELINES:
- Watch the ENTIRE video before responding. Do not skip any part.
- Speech timestamps must be PRECISE. Getting these wrong causes cuts mid-sentence, which ruins the edit.
- Every sentence boundary should be marked. These are the most important data points for editing.
- Safe cut points should include ALL natural edit points: between sentences, during pauses, at scene changes, on beat drops, after reactions.
- Peak moments should capture the "highlights reel" — the moments a viewer would want to see.
- Shot boundaries should be based on actual visual cuts, camera changes, or significant action changes.
- For talking head videos: prioritize speech accuracy and sentence boundaries above all else.
- Be generous with safe_cut_points — more options is better than fewer. Aim for at least one every 2-3 seconds.`;
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
        maxOutputTokens: 8192,
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
        description: typeof shot.description === 'string' ? shot.description : `Shot ${i + 1}`,
        score: typeof shot.visual_interest === 'number' ? shot.visual_interest : 0.5,
        camera: shot.camera || 'static',
        composition: shot.composition || 'medium',
        movement_energy: shot.movement_energy || 0.5,
        visual_interest: shot.visual_interest || 0.5,
        dominant_colors: shot.dominant_colors || '',
        lighting: shot.lighting || 'natural',
      }))
    : [{ start: 0, end: duration, description: 'Full video', score: 0.5 }];

  const speech = parsed.speech || { has_speech: false, segments: [], sentence_boundaries: [] };
  const audio = parsed.audio || { has_music: false };
  const safeCutPoints = Array.isArray(parsed.safe_cut_points) ? parsed.safe_cut_points : [];
  const peakMoments = Array.isArray(parsed.peak_moments) ? parsed.peak_moments : [];
  const videoProfile = parsed.video_profile || {};
  const metadata = parsed.metadata || {};

  return {
    duration,
    shots,
    speech,
    audio,
    safe_cut_points: safeCutPoints,
    peak_moments: peakMoments,
    video_profile: videoProfile,
    metadata,
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
