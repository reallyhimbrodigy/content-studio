/**
 * analyze-video.js — Gemini Flash video analysis
 * 
 * Replaces Twelve Labs with Google Gemini 2.0 Flash.
 * Same export signature: analyzeVideo(videoUrl, onProgress) → analysis object
 * Same output shape consumed by transcribe.js, generate-edit.js, build-timeline.js:
 *   { duration: number, shots: [{ start, end, description, score }], metadata: object }
 *
 * How it works:
 *   1. Downloads the video from its public URL
 *   2. Uploads to Gemini Files API (supports up to 2GB, 48h retention)
 *   3. Waits for Gemini to finish processing the file
 *   4. Prompts Gemini Flash to analyze the video and return structured JSON
 *   5. Parses response into the standard analysis shape
 *
 * No indexing step, no polling for index readiness — just upload → prompt → done.
 */

const axios = require('axios');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_UPLOAD_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const GEMINI_FILES_URL = 'https://generativelanguage.googleapis.com/v1beta/files';
const GEMINI_MODEL = 'gemini-2.0-flash';
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

  while (Date.now() - startTime < maxWaitMs) {
    const fileId = fileName.startsWith('files/') ? fileName.replace('files/', '') : fileName;
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
  return `You are a professional video analyst. Analyze this video and return a JSON object with the following structure. Return ONLY valid JSON, no markdown fences, no commentary.

{
  "duration": <total duration in seconds as a number>,
  "shots": [
    {
      "start": <start time in seconds>,
      "end": <end time in seconds>,
      "description": "<detailed description of what happens in this segment>",
      "score": <relevance/interest score from 0.0 to 1.0>
    }
  ],
  "metadata": {
    "resolution": "<width>x<height> if discernible, or null",
    "has_speech": <true/false — whether anyone is speaking or talking>,
    "dominant_mood": "<overall mood/energy of the video>",
    "key_subjects": ["<main subjects or objects in the video>"],
    "scene_count": <number of distinct scenes/locations>,
    "motion_level": "<low|medium|high — overall motion intensity>",
    "audio_description": "<brief description of audio: music, speech, ambient, silence, etc.>"
  }
}

Guidelines for shot segmentation:
- Break the video into logical shots/segments based on cuts, scene changes, or significant action changes.
- Each shot should be 1-5 seconds typically; don't make shots longer than 8 seconds unless nothing changes.
- For a 15-30 second video, expect roughly 4-15 shots.
- Descriptions should be specific and actionable for a video editor: mention camera movement, subject actions, lighting, colors, energy level.
- Include keywords like "speaking", "talking", "saying" in descriptions if someone is verbally communicating — this is used to trigger transcription.
- Score reflects how visually interesting/important the segment is (1.0 = most compelling, 0.0 = dead air).
- Timestamps must be accurate to the actual video content.`;
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
        temperature: 0.2,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60_000,
    }
  );

  const candidate = response.data.candidates?.[0];
  if (!candidate || !candidate.content?.parts?.length) {
    throw new Error('Gemini returned no content');
  }

  return candidate.content.parts[0].text;
}

function parseAnalysisResponse(rawText, fallbackDuration) {
  let parsed;
  try {
    const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse Gemini analysis JSON: ${err.message}\nRaw: ${rawText.slice(0, 500)}`);
  }

  const duration = typeof parsed.duration === 'number' ? parsed.duration : fallbackDuration || 0;

  const shots = Array.isArray(parsed.shots)
    ? parsed.shots.map((shot, i) => ({
        start: typeof shot.start === 'number' ? shot.start : 0,
        end: typeof shot.end === 'number' ? shot.end : duration,
        description: typeof shot.description === 'string' ? shot.description : `Shot ${i + 1}`,
        score: typeof shot.score === 'number' ? shot.score : 0.5,
      }))
    : [{ start: 0, end: duration, description: 'Full video', score: 0.5 }];

  const metadata = parsed.metadata || {};

  return { duration, shots, metadata };
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

  if (onProgress) onProgress({ step: 'analyzing', detail: 'Analyzing video content...' });
  const rawResponse = await promptGemini(activeFile.uri, mimeType);
  console.log(`[analyze] Gemini response received (${rawResponse.length} chars)`);

  const analysis = parseAnalysisResponse(rawResponse);
  console.log(`[analyze] Analysis complete: ${analysis.duration}s, ${analysis.shots.length} shots`);

  return analysis;
}

module.exports = { analyzeVideo };
