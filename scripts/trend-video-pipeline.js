/**
 * Weekly Trend Video Pipeline
 *
 * Runs every Sunday at 3AM UTC (Render cron).
 *
 * 1. Scrapes 50 top TikTok videos via Apify
 * 2. Downloads them to local temp storage
 * 3. Uploads to Google Cloud Storage (deletes last week's videos first)
 * 4. Sends all videos to Gemini 3.1 Pro in one call
 * 5. Gemini watches them and writes a comprehensive editing style guide
 * 6. Stores the style guide in Supabase (trend_profiles table)
 */

const { Storage } = require('@google-cloud/storage');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const { ApifyClient } = require('apify-client');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const GCS_BUCKET = process.env.GCS_BUCKET_NAME || 'promptly-trend-videos';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const APIFY_TOKEN = process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN;

if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY or GOOGLE_AI_API_KEY is required');
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN or APIFY_API_TOKEN is required');
if (!process.env.GCS_CREDENTIALS_JSON) throw new Error('GCS_CREDENTIALS_JSON is required');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let gcsCredentials;
try {
  gcsCredentials = JSON.parse(process.env.GCS_CREDENTIALS_JSON);
} catch (err) {
  console.error('[trend] Failed to parse GCS_CREDENTIALS_JSON');
  throw err;
}

const storage = new Storage({ credentials: gcsCredentials });
const bucket = storage.bucket(GCS_BUCKET);
const genai = new GoogleGenerativeAI(GEMINI_API_KEY);

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
        resultsPerPage: 10,
        shouldDownloadVideos: true,
      });

      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      for (const item of items) {
        if (item.videoUrl && (item.playCount || 0) >= 500000) {
          allVideos.push({
            url: item.videoUrl,
            views: item.playCount || 0,
            hashtag: tag,
            description: (item.text || '').slice(0, 200),
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
    if (seenUrls.has(video.url)) continue;
    seenUrls.add(video.url);
    unique.push(video);
    if (unique.length === 50) break;
  }

  console.log(`[trend] Scraped ${allVideos.length} videos total, selected top ${unique.length}`);
  return unique;
}

function downloadVideo(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);

    protocol
      .get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close(() => {
            fs.rm(destPath, { force: true }, () => {});
            downloadVideo(response.headers.location, destPath).then(resolve).catch(reject);
          });
          return;
        }

        if (response.statusCode !== 200) {
          file.close(() => fs.rm(destPath, { force: true }, () => {}));
          reject(new Error(`Unexpected status ${response.statusCode}`));
          return;
        }

        response.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', (err) => {
        file.close(() => fs.rm(destPath, { force: true }, () => {}));
        reject(err);
      });
  });
}

async function downloadAll(videos) {
  console.log(`[trend] Step 2: Downloading ${videos.length} videos...`);
  const tmpDir = path.join(os.tmpdir(), `trend-videos-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const downloaded = [];
  for (let i = 0; i < videos.length; i += 1) {
    const dest = path.join(tmpDir, `trend_${i}.mp4`);
    try {
      await downloadVideo(videos[i].url, dest);
      const stat = fs.statSync(dest);
      if (stat.size > 100000) {
        downloaded.push({ ...videos[i], localPath: dest, index: i });
        console.log(`[trend] Downloaded ${i + 1}/${videos.length}: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
      } else {
        console.log(`[trend] Skipping ${i + 1}: too small (${stat.size} bytes)`);
        fs.rmSync(dest, { force: true });
      }
    } catch (err) {
      console.log(`[trend] Failed to download ${i + 1}: ${err.message}`);
    }
  }

  console.log(`[trend] Downloaded ${downloaded.length}/${videos.length} videos`);
  return { downloaded, tmpDir };
}

async function uploadToGCS(downloaded) {
  console.log('[trend] Step 3: Uploading to Google Cloud Storage...');
  console.log("[trend] Deleting last week's videos from GCS...");

  try {
    const [files] = await bucket.getFiles({ prefix: 'trend_' });
    if (files.length > 0) {
      await Promise.all(files.map((file) => file.delete()));
      console.log(`[trend] Deleted ${files.length} old files from GCS`);
    }
  } catch (err) {
    console.log(`[trend] Error deleting old files: ${err.message}`);
  }

  const gcsUris = [];
  for (const video of downloaded) {
    const gcsName = `trend_${video.index}.mp4`;
    try {
      await bucket.upload(video.localPath, {
        destination: gcsName,
        metadata: {
          contentType: 'video/mp4',
          metadata: {
            views: String(video.views),
            hashtag: video.hashtag,
          },
        },
      });
      const gcsUri = `gs://${GCS_BUCKET}/${gcsName}`;
      gcsUris.push(gcsUri);
      console.log(`[trend] Uploaded ${gcsName} to GCS`);
    } catch (err) {
      console.log(`[trend] Failed to upload ${gcsName}: ${err.message}`);
    }
  }

  console.log(`[trend] Uploaded ${gcsUris.length} videos to GCS`);
  return gcsUris;
}

async function generateStyleGuide(gcsUris) {
  console.log(`[trend] Step 4: Sending ${gcsUris.length} videos to Gemini for style guide generation...`);

  const content = [];
  for (const uri of gcsUris) {
    content.push({
      fileData: {
        mimeType: 'video/mp4',
        fileUri: uri,
      },
    });
  }

  content.push({
    text: `You just watched ${gcsUris.length} of the highest-performing TikTok videos from this week — each with over 500,000 views. These are the videos the algorithm is actively distributing to millions of people right now.

Write a comprehensive EDITING STYLE GUIDE based on what you observed across all of these videos. This guide will be given to an AI video editor to inform how it edits user-uploaded footage. The guide should be specific, actionable, and based on actual patterns you observed — not generic advice.

Cover ALL of these areas with specific observations:

CUTTING AND PACING:
- How fast is the first cut? How many cuts happen in the first 3 seconds?
- What's the typical cut density (cuts per 10 seconds)?
- Do cuts land on speech boundaries, beats, or visual moments?
- How does pacing vary across the video — where does it speed up and slow down?
- Are there any pauses or moments of stillness, and how are they used?

HOOKS AND OPENINGS:
- What happens in the first 2 seconds across these videos?
- Is there text on screen immediately? What kind?
- Is the framing different in the opening vs the rest?
- What makes the hook work — curiosity, shock, pattern interrupt, direct address?

TRANSITIONS:
- What percentage of cuts are hard cuts vs visual transitions?
- When visual transitions ARE used, what type and at what moments?
- How do the videos handle the transition between different types of content (speaker to screen recording, speaker to b-roll)?

SOUND DESIGN:
- Do the videos use transition sounds? How frequently?
- What types of sounds (swooshes, thuds, pops, dings)?
- When are sounds placed vs when are cuts silent?
- How does sound design relate to text overlay appearances?

SPEED AND PACING:
- Do the videos use visible speed changes?
- Where do speed ramps appear — on what type of moments?
- What's the contrast between the fastest and slowest sections?
- Does the base speed feel accelerated (slightly faster than natural speech)?

TEXT OVERLAYS:
- How many text overlays per video on average?
- When does the first text appear?
- What kind of text (hooks, labels, CTAs, emphasis)?
- Where is text positioned on screen?
- How does text relate to what's being said?

B-ROLL AND VISUAL VARIETY:
- Do the talking-head videos use b-roll cutaways?
- How long are b-roll clips typically?
- What kind of b-roll is used (close-ups, actions, screens)?
- How does the video transition into and out of b-roll?

COLOR AND PRODUCTION:
- Do the videos look color graded? How would you describe the typical grade?
- Is the footage warm, cool, neutral?
- Do they use vignette, grain, or other stylistic treatments?
- What's the overall production quality feel?

FRAMING AND CAMERA:
- Do the videos use zoom movements?
- Do they use the cut-zoom multi-camera simulation?
- Is the framing mostly static or dynamic?

ENDINGS:
- How do the videos end? Abruptly, with a CTA, with a fade?
- Do they loop cleanly back to the beginning?

Write the style guide as direct, confident observations — not hedged or academic. Write it as if you're briefing a professional editor: "The top videos this week do X. They avoid Y. The pattern is Z."

The style guide should be 800-1200 words. Be specific enough that an editor reading this could replicate the style.`,
  });

  const model = genai.getGenerativeModel({ model: 'gemini-3.1-pro-preview' });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: content }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 4000,
    },
  });

  const styleGuide = result.response.text();
  console.log(`[trend] Style guide generated: ${styleGuide.length} chars`);
  return styleGuide;
}

async function storeStyleGuide(styleGuide, videoCount) {
  console.log('[trend] Step 5: Storing style guide in Supabase...');

  const now = new Date();
  const validUntil = new Date(now);
  validUntil.setDate(validUntil.getDate() + 8);

  const { error } = await supabase.from('trend_profiles').insert({
    profile_type: 'general',
    profile_json: {
      type: 'style_guide',
      style_guide: styleGuide,
      sample_size: videoCount,
      generated_at: now.toISOString(),
    },
    sample_size: videoCount,
    computed_at: now.toISOString(),
    valid_until: validUntil.toISOString(),
  });

  if (error) {
    console.error(`[trend] Failed to store style guide: ${error.message}`);
    throw error;
  }

  console.log(`[trend] Style guide stored, valid until ${validUntil.toISOString()}`);
}

function cleanup(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('[trend] Cleaned up temp files');
  } catch (err) {
    console.log(`[trend] Cleanup warning: ${err.message}`);
  }
}

async function main() {
  console.log('========================================');
  console.log('WEEKLY TREND VIDEO PIPELINE');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('========================================');

  const startTime = Date.now();
  let tmpDir = null;

  try {
    const videos = await scrapeVideos();
    if (videos.length === 0) {
      throw new Error('No videos scraped');
    }

    const downloadResult = await downloadAll(videos);
    tmpDir = downloadResult.tmpDir;
    if (downloadResult.downloaded.length < 10) {
      throw new Error(`Only ${downloadResult.downloaded.length} videos downloaded — need at least 10`);
    }

    const gcsUris = await uploadToGCS(downloadResult.downloaded);
    if (gcsUris.length < 10) {
      throw new Error(`Only ${gcsUris.length} videos uploaded to GCS — need at least 10`);
    }

    const styleGuide = await generateStyleGuide(gcsUris);
    if (!styleGuide || styleGuide.length < 500) {
      throw new Error('Style guide too short or empty');
    }

    await storeStyleGuide(styleGuide, gcsUris.length);
    cleanup(tmpDir);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('========================================');
    console.log(`PIPELINE COMPLETE in ${elapsed}s`);
    console.log(`Videos analyzed: ${gcsUris.length}`);
    console.log(`Style guide: ${styleGuide.length} chars`);
    console.log('========================================');
  } catch (err) {
    if (tmpDir) cleanup(tmpDir);
    console.error(`[trend] Pipeline failed: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
