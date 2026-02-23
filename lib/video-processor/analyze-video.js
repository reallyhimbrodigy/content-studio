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
  return `You are the editor's eyes. A professional video editor cannot watch this footage — you are watching it for them. Everything you see, hear, and notice will be the only information they have to work with when making every cut, transition, and color decision. If you miss something or describe it vaguely, they will make a worse edit. The more precise and vivid your observations, the better the final product.

All timestamps must be precise to the hundredth of a second (e.g., 8.34s, not 8.3s, not 8s). At 30fps a single frame is 0.033s — your timestamps need to be at that level of accuracy, especially for speech.

Return ONLY valid JSON:

{
  "duration": <total duration in seconds>,

  "shots": [
    {
      "start": <number>,
      "end": <number>,
      "description": "<Describe exactly what you see. Not categories — paint the picture. What is the subject doing, what's in the background, how is the light falling, what colors dominate, is there motion, what draws the eye. Write as if the reader has never seen this footage.>",
      "camera": "<camera behavior>",
      "composition": "<framing>",
      "movement_energy": <0.0 to 1.0>,
      "visual_interest": <0.0 to 1.0>,
      "dominant_colors": "<specific color descriptions of what you actually see>",
      "lighting": "<describe the actual light — direction, quality, color temperature, shadows, how it hits the subject>",
      "whats_happening": "<the story of this moment — what's the subject doing, feeling, communicating>",
      "editing_notes": "<your professional instinct — what would you do with this footage, what works, what doesn't, where would you cut>"
    }
  ],

  "speech": {
    "has_speech": <boolean>,
    "overall_delivery": "<how the speaker talks — pace, energy, vocal quality, patterns, filler words, breathing patterns>",
    "segments": [
      {
        "start": <number — precise to 0.01s>,
        "end": <number — precise to 0.01s>,
        "text": "<exact words spoken>",
        "speaker": "<speaker_1 | speaker_2 | etc.>",
        "emotion": "<what you hear in their voice>",
        "delivery_notes": "<how they say it — speed changes, emphasis, pauses, pitch shifts, stumbles, laughter>",
        "emphasis_moments": [
          {
            "time": <number>,
            "word": "<word or phrase>",
            "reason": "<why this moment matters editorially>"
          }
        ]
      }
    ],
    "sentence_boundaries": [
      {
        "end_time": <number — precise to 0.01s>,
        "is_safe_cut": <boolean>,
        "pause_duration": <seconds of silence/breath after this sentence>,
        "context": "<what just ended and what comes next>"
      }
    ]
  },

  "audio": {
    "has_music": <boolean>,
    "music_description": "<if music: genre, tempo, energy, instrumentation, how it interacts with speech>",
    "beat_moments": [<timestamps that sync well with visual cuts>],
    "silence_gaps": [
      {"start": <number>, "end": <number>, "type": "<true_silence | breath | ambient_only>"}
    ],
    "ambient_description": "<everything you hear that isn't speech or music>",
    "energy_arc": "<how the audio energy evolves across the video, mapped to timestamps>",
    "audio_quality": "<describe the recording — mic type you'd guess, room sound, clarity, issues>"
  },

  "safe_cut_points": [
    {
      "time": <number — precise to 0.01s>,
      "reason": "<why this specific moment works for a cut>",
      "quality": <0.0 to 1.0>,
      "what_precedes": "<what just happened>",
      "what_follows": "<what comes next>"
    }
  ],

  "peak_moments": [
    {
      "time": <number>,
      "type": "<what kind of moment this is>",
      "description": "<what makes this compelling>",
      "importance": <0.0 to 1.0>,
      "suggested_treatment": "<how you'd feature this moment in an edit>"
    }
  ],

  "video_profile": {
    "content_type": "<what kind of video this is>",
    "mood_arc": "<how energy and emotion evolve, mapped to timestamps>",
    "primary_subject": "<who or what this video is about>",
    "overall_energy": "<low | medium | high>",
    "recommended_output_duration": <number>,
    "key_takeaway": "<the one thing a viewer should take away>",
    "visual_style": "<describe the overall look and feel of the footage — colors, lighting, production quality, aesthetic>",
    "editing_recommendation": "<if you were editing this footage, what would you do? Describe your approach — pacing, which moments to feature, what to cut, how to handle the color, what transitions would serve the content. Be specific to this video.>"
  },

  "metadata": {
    "resolution": "<if discernible>",
    "orientation": "<portrait | landscape | square>",
    "frame_rate_estimate": "<number or null>",
    "overall_quality": "<describe the technical quality — sharpness, exposure, color accuracy, stability, noise>"
  }
}

Mark every natural cut point you can find — the more options you provide, the better. Prioritize timestamp accuracy above all else, especially on speech boundaries.`;
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
        whats_happening: shot.whats_happening || '',
        editing_notes: shot.editing_notes || '',
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
