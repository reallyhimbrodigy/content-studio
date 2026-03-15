const crypto = require('crypto');
const { ApifyClient } = require('apify-client');
const { createClient } = require('@supabase/supabase-js');

const apify = new ApifyClient({ token: process.env.APIFY_API_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const BATCH_ID = new Date().toISOString().split('T')[0]; // e.g., "2026-03-15"
const VIDEOS_PER_CATEGORY = 20;

// Broad hashtag categories to capture diverse content types
const HASHTAG_CATEGORIES = [
  // General viral / trending
  { hashtags: ['fyp', 'viral', 'trending'], label: 'general' },
  // Educational / talking head
  { hashtags: ['learnontiktok', 'tips', 'howto'], label: 'educational' },
  // Lifestyle
  { hashtags: ['grwm', 'dayinmylife', 'routine'], label: 'lifestyle' },
  // Business / marketing
  { hashtags: ['smallbusiness', 'entrepreneur', 'marketing'], label: 'business' },
  // Entertainment
  { hashtags: ['storytime', 'comedy', 'relatable'], label: 'entertainment' },
];

async function scrapeCategory(category) {
  console.log(`[scraper] Scraping category: ${category.label} (hashtags: ${category.hashtags.join(', ')})`);

  const results = [];

  for (const hashtag of category.hashtags) {
    try {
      // Run the clockworks/tiktok-scraper actor
      const run = await apify.actor('clockworks/tiktok-scraper').call({
        hashtags: [hashtag],
        resultsPerPage: Math.ceil(VIDEOS_PER_CATEGORY / category.hashtags.length),
        shouldDownloadVideos: true,
      });

      // Fetch results from the default dataset
      const { items } = await apify.dataset(run.defaultDatasetId).listItems();

      for (const item of items) {
        // The clockworks scraper returns fields like:
        // webVideoUrl, playCount, diggCount (likes), shareCount, commentCount,
        // desc (caption/hashtags), musicMeta.musicName, videoMeta.duration,
        // and if shouldDownloadVideos is true, a videoUrl or similar download link

        // Extract hashtags from the description text
        const extractedHashtags = (item.desc || '').match(/#\w+/g) || [];

        results.push({
          platform: 'tiktok',
          video_url: item.webVideoUrl || item.videoUrl || item.url || '',
          video_download_url: item.videoUrl || item.downloadUrl || null,
          view_count: item.playCount || 0,
          like_count: item.diggCount || item.likesCount || 0,
          share_count: item.shareCount || 0,
          comment_count: item.commentCount || 0,
          hashtags: extractedHashtags.map((h) => h.toLowerCase()),
          sound_name: item.musicMeta?.musicName || item.music?.title || null,
          duration_seconds: item.videoMeta?.duration || item.video?.duration || null,
        });
      }

      console.log(`[scraper]   #${hashtag}: got ${items.length} videos`);
    } catch (err) {
      console.error(`[scraper]   #${hashtag} failed: ${err.message}`);
      // Continue to next hashtag — don't block the batch
    }
  }

  return results;
}

async function uploadVideoToSupabase(videoDownloadUrl, videoId) {
  // Download the video file and upload to Supabase storage
  if (!videoDownloadUrl) return null;

  try {
    const response = await fetch(videoDownloadUrl);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const filePath = `${BATCH_ID}/${videoId}.mp4`;

    const { error } = await supabase.storage
      .from('trend-videos')
      .upload(filePath, buffer, {
        contentType: 'video/mp4',
        upsert: false,
      });

    if (error) throw error;

    // Get the public/signed URL for later retrieval by the analyzer
    const { data } = supabase.storage
      .from('trend-videos')
      .getPublicUrl(filePath);

    return data.publicUrl || filePath;
  } catch (err) {
    console.error(`[scraper] Video upload failed for ${videoId}: ${err.message}`);
    return null;
  }
}

async function run() {
  if (!process.env.APIFY_API_TOKEN) throw new Error('APIFY_API_TOKEN is required');
  if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is required');
  if (!process.env.SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY is required');

  console.log(`[scraper] Starting trend scrape — batch ${BATCH_ID}`);

  let allVideos = [];

  // Scrape each category
  for (const category of HASHTAG_CATEGORIES) {
    const videos = await scrapeCategory(category);
    allVideos = allVideos.concat(videos);
  }

  console.log(`[scraper] Scraped ${allVideos.length} total videos across all categories`);

  // Deduplicate by video_url
  const seen = new Set();
  const unique = allVideos.filter((v) => {
    if (!v.video_url || seen.has(v.video_url)) return false;
    seen.add(v.video_url);
    return true;
  });

  console.log(`[scraper] ${unique.length} unique videos after dedup`);

  // Filter for high-performing videos (500K+ views)
  const highPerforming = unique.filter((v) => v.view_count >= 500000);
  console.log(`[scraper] ${highPerforming.length} videos with 500K+ views`);

  // If we don't have enough high-performing videos, lower the threshold
  let videosToProcess = highPerforming;
  if (highPerforming.length < 30) {
    console.log('[scraper] Not enough 500K+ videos, lowering threshold to 100K');
    videosToProcess = unique.filter((v) => v.view_count >= 100000);
    console.log(`[scraper] ${videosToProcess.length} videos with 100K+ views`);
  }

  // Cap at 120 videos to stay within budget
  videosToProcess = videosToProcess.slice(0, 120);

  let inserted = 0;
  let skipped = 0;
  let uploadFailed = 0;

  for (const video of videosToProcess) {
    // Check if this video URL already exists (idempotent)
    const { data: existing } = await supabase
      .from('trend_videos')
      .select('id')
      .eq('video_url', video.video_url)
      .limit(1);

    if (existing && existing.length > 0) {
      skipped++;
      continue;
    }

    // Generate a UUID for this video to use as filename
    const videoId = crypto.randomUUID();

    // Upload video file to Supabase storage
    const fileUrl = await uploadVideoToSupabase(video.video_download_url, videoId);

    if (!fileUrl) {
      uploadFailed++;
      continue; // Skip videos we can't download — Gemini needs the file
    }

    // Insert into trend_videos
    const { error } = await supabase.from('trend_videos').insert({
      id: videoId,
      platform: video.platform,
      video_url: video.video_url,
      video_file_url: fileUrl,
      view_count: video.view_count,
      like_count: video.like_count,
      share_count: video.share_count,
      comment_count: video.comment_count,
      hashtags: video.hashtags,
      sound_name: video.sound_name,
      duration_seconds: video.duration_seconds,
      batch_id: BATCH_ID,
      analyzed: false,
    });

    if (error) {
      console.error(`[scraper] Insert failed for ${video.video_url}: ${error.message}`);
    } else {
      inserted++;
    }
  }

  console.log(`[scraper] Complete — inserted: ${inserted}, skipped (duplicate): ${skipped}, upload failed: ${uploadFailed}`);
  return { inserted, skipped, uploadFailed, batchId: BATCH_ID };
}

// Run if called directly
if (require.main === module) {
  run()
    .then((result) => {
      console.log('[scraper] Finished:', result);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[scraper] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { run };
