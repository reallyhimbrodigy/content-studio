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
  return `You are the editor's eyes and ears. A professional video editor cannot watch this footage — you are watching and listening for them. Your job is to report everything that matters for making editing decisions: where to cut, what to keep, how the footage looks and sounds, and where the energy lives.

Every timestamp you provide must be precise to 0.01 seconds. The editor will place cuts at the exact moments you specify — if you're off by even a tenth of a second, the cut will land mid-word or clip a reaction. Timestamp precision is the most important thing you can provide.

Return ONLY valid JSON:

{
  "duration": <total duration in seconds>,

  "shots": [
    {
      "start": <number>,
      "end": <number>,
      "visual": "<What does the frame look like? Describe the light quality, color temperature, exposure, dominant tones, depth of field, and anything visually notable that would affect color grading or framing decisions.>",
      "action": "<What is happening? What is the subject doing, showing, demonstrating? Where is the viewer's attention drawn and why?>",
      "energy": <0.0 to 1.0 — how much visual momentum is in this shot>,
      "editing_value": "<Why would an editor keep or cut this shot? Is it essential, filler, transitional, the best take? What role does it play in the story?>"
    }
  ],

  "speech": {
    "has_speech": <boolean>,
    "speaker_style": "<How does the speaker talk? Pace, rhythm, energy level, verbal habits. What does the editor need to know about their delivery to cut around it naturally?>",
    "segments": [
      {
        "start": <number — to 0.01s>,
        "end": <number — to 0.01s>,
        "text": "<exact words>",
        "emotion": "<what you hear in the delivery>",
        "energy_level": <0.0 to 1.0>,
        "notes": "<Anything the editor needs to know: speaker speeds up, stumbles, emphasizes a word, laughs, pauses for effect, restarts a thought>"
      }
    ],
    "sentence_boundaries": [
      {
        "time": <number — to 0.01s — the exact moment the last word of the sentence ends>,
        "pause_after": <seconds of silence/breath before next sentence begins>,
        "context": "<what thought just completed and what comes next>"
      }
    ]
  },

  "audio": {
    "overall_quality": "<What does the audio sound like? Mic quality, room sound, background noise, anything that affects how the final product will sound>",
    "music": "<If there's music: what kind, how loud relative to speech, any beat moments that would sync well with cuts. If no music: say so>",
    "energy_arc": "<Map how the audio energy evolves across the video with timestamps. Where does it build, peak, and settle?>"
  },

  "cut_points": [
    {
      "time": <number — to 0.01s>,
      "quality": <0.0 to 1.0>,
      "why": "<What makes this a good place to cut? Be specific: 'sentence ends, 0.3s breath, topic shifts from intro to demo'>"
    }
  ],

  "highlights": [
    {
      "time": <number>,
      "what": "<What happens here that an audience would care about?>",
      "importance": <0.0 to 1.0>
    }
  ],

  "footage_assessment": {
    "content_type": "<what kind of video this is>",
    "energy_arc": "<how the overall energy moves through the video, with timestamps>",
    "visual_character": "<Describe the overall look of the footage — color palette, lighting quality, exposure, white balance, contrast level, production value. This directly informs color grading decisions.>",
    "audio_character": "<Describe the overall sound — voice clarity, room tone, background noise level, music presence. This informs audio treatment.>",
    "strongest_moments": "<Which parts of this video are the most compelling and why?>",
    "weakest_moments": "<Which parts are filler, dead air, false starts, or low energy?>",
    "recommended_duration": <number between 15-30>,
    "editing_brief": "<If you were handing this footage to an editor with one paragraph of direction, what would you tell them? What to keep, what to cut, how to pace it, what the final piece should feel like.>"
  }
}

Focus your detail where it matters for editing. Spend your descriptions on timing, energy, and the look/sound of the footage — not on physical descriptions of people or objects that don't affect editing decisions.`;
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
