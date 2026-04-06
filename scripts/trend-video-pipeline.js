/**
 * Weekly Trend Video Pipeline
 *
 * Flow:
 * 1) Scrape trending TikTok videos via Apify
 * 2) Download each video and analyze with Gemini (structured JSON)
 * 3) Analyze manually curated reference videos
 * 4) Aggregate all analyses into a style guide
 * 5) Write style_guide profile to Supabase trend_profiles
 */

const { createClient } = require('@supabase/supabase-js');
const { ApifyClient } = require('apify-client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const fetch = require('node-fetch');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const APIFY_TOKEN = process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN;

if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY or GOOGLE_AI_API_KEY is required');
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN or APIFY_API_TOKEN is required');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

let GoogleAIFileManager = null;
try {
  ({ GoogleAIFileManager } = require('@google/generative-ai/server'));
} catch (_) {
  GoogleAIFileManager = null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFileManager() {
  if (typeof genAI.getFileManager === 'function') {
    return genAI.getFileManager();
  }
  if (GoogleAIFileManager) {
    return new GoogleAIFileManager(GEMINI_API_KEY);
  }
  throw new Error('Gemini file manager is unavailable in current SDK version');
}

async function scrapeVideos() {
  console.log('[trend] Step 1: Scraping TikTok videos via Apify...');

  const client = new ApifyClient({ token: APIFY_TOKEN });
  const hashtags = [
    'viral', 'fyp', 'foryou', 'trending', 'relatable',
    'smallbusiness', 'entrepreneur', 'motivation', 'lifehacks', 'storytime',
  ];

  const allVideos = [];

  for (const tag of hashtags) {
    try {
      const run = await client.actor('clockworks/tiktok-scraper').call({
        hashtags: [tag],
        resultsPerPage: 20,
        shouldDownloadVideos: true,
      });

      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      for (const item of items) {
        const videoUrl = item.videoUrl || item.webVideoUrl || item.url;
        const views = item.playCount || item.viewCount || 0;
        if (videoUrl && views >= 500000) {
          allVideos.push({
            videoUrl,
            views,
            likes: item.diggCount || item.likesCount || 0,
            author: item.authorMeta?.name || item.author || null,
            hashtag: tag,
            description: (item.desc || item.text || '').slice(0, 200),
          });
        }
      }
    } catch (err) {
      console.log(`[trend] Failed to scrape #${tag}: ${err.message}`);
    }
  }

  allVideos.sort((a, b) => b.views - a.views);
  const unique = [];
  const seenUrls = new Set();
  for (const video of allVideos) {
    if (!video.videoUrl || seenUrls.has(video.videoUrl)) continue;
    seenUrls.add(video.videoUrl);
    unique.push(video);
    if (unique.length === 50) break;
  }

  console.log(`[trend] Scraped ${allVideos.length} videos total, selected top ${unique.length}`);
  return unique;
}

async function downloadVideo(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const buffer = await response.buffer();
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

async function analyzeVideoWithGemini(videoPath, videoMetadata) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro-preview' });
  const fileManager = getFileManager();

  const uploadResult = await fileManager.uploadFile(videoPath, {
    mimeType: 'video/mp4',
    displayName: path.basename(videoPath),
  });

  let file = uploadResult.file;
  while (file && file.state === 'PROCESSING') {
    await sleep(3000);
    file = await fileManager.getFile(file.name);
  }

  if (!file || file.state !== 'ACTIVE') {
    console.log(`[trend] Video ${videoPath} failed to process, skipping`);
    return null;
  }

  const prompt = `You are analyzing a high-performing TikTok video (${videoMetadata.views || '500K+'} views) to extract editing patterns that make it successful.

Watch the entire video carefully and analyze these specific editing elements:

1. HOOK (first 1-3 seconds):
   - How does it grab attention? (text on screen, direct address, visual surprise, action already happening)
   - Is there text/caption in the first frame?
   - How quickly does the speaker/content start?

2. CUT PATTERNS:
   - How many cuts total?
   - Average time between cuts (seconds)
   - Are cuts getting faster toward the end?
   - Are there any jump cuts? How are they used?

3. SPEED RAMPING (if present):
   - Does the video use speed changes?
   - WHERE in the video do speed changes happen? (setup, punchline, transition, ending)
   - What gets sped up? What gets slowed down?
   - How dramatic are the speed changes? (subtle 1.1-1.2x or dramatic 1.3-1.5x)
   - What's the rhythm? (fast→slow→fast or slow→fast→slow)
   - Does the pitch shift on the audio? (TikTok style)

4. CAPTIONS/TEXT:
   - What caption style? (word-by-word highlight, single word pop, two-line, boxed, minimal, hormozi-style bold)
   - Font size and position?
   - Any keyword highlighting? What color?
   - Do captions have animation?

5. SOUND EFFECTS:
   - Are there any sound effects? What kind? (ching, pop, swoosh, ding, thud)
   - When do they play? (on specific words, on cuts, on visual changes)
   - How many total?

6. TEXT OVERLAYS (separate from captions):
   - Are there text overlays on screen? (titles, CTAs, labels)
   - Where are they positioned?
   - When do they appear/disappear?
   - What do they say?

7. PACING/ENERGY:
   - Does the video start fast and stay fast, or does it build?
   - Are there any pauses for emphasis?
   - How does the ending feel? (abrupt cut, fade, CTA, loop)

8. COLOR/LOOK:
   - Is the footage color graded? How? (warm, cool, punchy, moody, clean)
   - Is there a filter or LUT applied?

9. ZOOM/CAMERA:
   - Are there zoom effects? (slow zoom in, cut zoom on emphasis)
   - Is the framing dynamic or static?

Respond with a structured analysis in this EXACT JSON format:
{
  "hook_type": "text_hook|direct_address|visual_surprise|action_in_progress|pattern_interrupt",
  "hook_description": "brief description of how the hook works",
  "total_cuts": <number>,
  "avg_cut_interval": <seconds>,
  "cuts_accelerate": true|false,
  "has_speed_ramping": true|false,
  "speed_ramp_details": "description of speed ramping patterns, or null if none",
  "speed_ramp_moments": [
    {"time_description": "on the punchline about X", "type": "slowdown|speedup", "estimated_speed": 0.8}
  ],
  "caption_style": "word_highlight|single_word|two_line|boxed|minimal|hormozi|none",
  "caption_details": "description of caption styling",
  "sound_effects": [
    {"type": "ching|pop|swoosh|ding|thud", "trigger": "what moment it plays on"}
  ],
  "text_overlays": true|false,
  "text_overlay_details": "description or null",
  "pacing": "fast_throughout|builds|peaks_and_valleys|slow_deliberate",
  "energy_curve": "description of how energy flows through the video",
  "color_look": "warm|cool|punchy|moody|clean|natural|cinematic",
  "has_zoom": true|false,
  "zoom_details": "description or null",
  "what_makes_it_work": "1-2 sentence summary of why this video performs well from an editing perspective"
}

Respond ONLY with the JSON. No markdown, no backticks, no explanation.`;

  const result = await model.generateContent([
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
    { text: prompt },
  ]);

  const text = result.response.text().trim();

  try {
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.log(`[trend] Failed to parse Gemini analysis: ${e.message}`);
    console.log(`[trend] Raw response: ${text.substring(0, 500)}`);
    return null;
  }
}

async function analyzeScrapedVideos(scrapedVideos) {
  const analyses = [];
  const tempDir = path.join(os.tmpdir(), `temp_trend_videos_${Date.now()}`);
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  try {
    for (let i = 0; i < scrapedVideos.length; i++) {
      const video = scrapedVideos[i];
      const videoUrl = video.videoUrl || video.url;
      if (!videoUrl) continue;

      console.log(`[trend] Analyzing video ${i + 1}/${scrapedVideos.length}: ${videoUrl.substring(0, 60)}...`);

      try {
        const tempPath = path.join(tempDir, `trend_${i}.mp4`);
        await downloadVideo(videoUrl, tempPath);

        const analysis = await analyzeVideoWithGemini(tempPath, {
          views: video.playCount || video.views,
          likes: video.diggCount || video.likes,
          author: video.authorMeta?.name || video.author,
        });

        if (analysis) {
          analyses.push(analysis);
          console.log(`[trend] Video ${i + 1}: ${analysis.what_makes_it_work || 'analyzed'}`);
        }

        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        await sleep(2000);
      } catch (err) {
        console.log(`[trend] Failed to analyze video ${i + 1}: ${err.message}`);
      }
    }
  } finally {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`[trend] Successfully analyzed ${analyses.length}/${scrapedVideos.length} videos`);
  return analyses;
}

async function analyzeManualReferenceVideos() {
  const manifestPath = path.join(__dirname, '..', 'reference-videos', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.log('[trend] No reference-videos/manifest.json found, skipping manual videos');
    return [];
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const analyses = [];

  for (const entry of manifest.videos || []) {
    const videoPath = path.join(__dirname, '..', 'reference-videos', entry.filename);
    if (!fs.existsSync(videoPath)) {
      console.log(`[trend] Reference video not found: ${entry.filename}, skipping`);
      continue;
    }

    console.log(`[trend] Analyzing manual reference: ${entry.filename} (${entry.why_included})`);

    try {
      const analysis = await analyzeVideoWithGemini(videoPath, {
        views: entry.views,
        description: entry.description,
        tags: entry.tags,
      });

      if (analysis) {
        analysis._manual_reference = true;
        analysis._why_included = entry.why_included;
        analysis._tags = entry.tags;
        analyses.push(analysis);
        console.log(`[trend] Reference ${entry.filename}: ${analysis.what_makes_it_work || 'analyzed'}`);
      }

      await sleep(2000);
    } catch (err) {
      console.log(`[trend] Failed to analyze reference ${entry.filename}: ${err.message}`);
    }
  }

  console.log(`[trend] Analyzed ${analyses.length} manual reference videos`);
  return analyses;
}

async function aggregateIntoStyleGuide(analyses) {
  if (!analyses.length) return null;

  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro-preview' });

  const scraped = analyses.filter((a) => !a._manual_reference);
  const manual = analyses.filter((a) => a._manual_reference);

  const prompt = `You are a senior short-form video editor. Below are structured analyses of ${analyses.length} high-performing TikTok videos (${scraped.length} from trending content, ${manual.length} manually curated reference videos).

Your job: synthesize these into a concise, actionable EDITING STYLE GUIDE that another AI editor can follow when editing new videos.

The guide should cover:
1. HOOKS — what hook styles are working and how to execute them
2. CUT PACING — how fast to cut, whether to accelerate, average intervals
3. SPEED RAMPING — when to use it, what to speed up, what to slow down, specific speed values that work
4. CAPTIONS — which styles are dominant, positioning, highlighting patterns
5. SOUND EFFECTS — when and how to use them, which types work
6. TEXT OVERLAYS — when to use them, what they say, where to position them
7. PACING/ENERGY — how energy should flow through the video
8. COLOR — what looks are trending
9. KEY INSIGHT — the single most important editing principle these videos share

Be specific. Use actual numbers (cut every 2.3 seconds, speed up to 1.3x on setup). Reference specific patterns you see across multiple videos. If manual reference videos show specific techniques (like speed ramping), give those extra weight and detail.

Here are the individual analyses:

=== SCRAPED TRENDING VIDEOS ===
${scraped.map((a, i) => `Video ${i + 1}:\n${JSON.stringify(a, null, 2)}`).join('\n\n')}

=== MANUALLY CURATED REFERENCE VIDEOS ===
${manual.map((a, i) => `Reference ${i + 1} (${a._why_included}):\n${JSON.stringify(a, null, 2)}`).join('\n\n')}

Write the style guide as clear, direct prose. No JSON. No bullet points. Write it like you're briefing a junior editor before they cut a video. Keep it under 2000 words.`;

  const result = await model.generateContent([{ text: prompt }]);
  return result.response.text().trim();
}

async function writeTrendProfile(styleGuide, sampleSize) {
  const now = new Date();
  const validUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const { error } = await supabase.from('trend_profiles').insert({
    profile_type: 'general',
    sample_size: sampleSize,
    computed_at: now.toISOString(),
    valid_until: validUntil.toISOString(),
    profile_json: {
      type: 'style_guide',
      style_guide: styleGuide,
      sample_size: sampleSize,
      computed_at: now.toISOString(),
    },
  });

  if (error) {
    console.log(`[trend] Failed to write trend profile: ${error.message}`);
    return false;
  }

  console.log(`[trend] Trend profile written: ${sampleSize} videos, valid until ${validUntil.toISOString()}`);
  return true;
}

async function main() {
  console.log('========================================');
  console.log('WEEKLY TREND VIDEO PIPELINE');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('========================================');

  const startTime = Date.now();

  try {
    const scrapedVideos = await scrapeVideos();
    if (scrapedVideos.length === 0) {
      throw new Error('No videos scraped');
    }

    const scrapedAnalyses = await analyzeScrapedVideos(scrapedVideos);
    const manualAnalyses = await analyzeManualReferenceVideos();
    const allAnalyses = [...scrapedAnalyses, ...manualAnalyses];

    console.log(`[trend] Total analyses: ${allAnalyses.length} (${scrapedAnalyses.length} scraped + ${manualAnalyses.length} manual)`);

    if (allAnalyses.length > 0) {
      const styleGuide = await aggregateIntoStyleGuide(allAnalyses);
      if (styleGuide) {
        console.log(`[trend] Style guide generated: ${styleGuide.length} chars`);
        await writeTrendProfile(styleGuide, allAnalyses.length);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('========================================');
    console.log(`PIPELINE COMPLETE in ${elapsed}s`);
    console.log(`Videos analyzed: ${allAnalyses.length}`);
    console.log('========================================');
  } catch (err) {
    console.error(`[trend] Pipeline failed: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
