const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const os = require('os');

const genai = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const GEMINI_MODEL = 'gemini-2.5-pro';
const DELAY_BETWEEN_VIDEOS_MS = 3000; // 3 seconds between API calls to respect rate limits
const TIMEOUT_MS = 90000; // 90 second timeout per video analysis

const EXTRACTION_PROMPT = `Watch this entire video from beginning to end before answering. This is a top-performing TikTok video. Your job is to analyze HOW it was edited — not what it's about. You are extracting the structural editing patterns that make this video feel produced and engaging.

Count carefully. Timestamp precisely. Do not guess or approximate — watch and measure.

Return ONLY a JSON object with the following structure. Every field is required. If you genuinely cannot determine a value, use null.

{
  "video_duration_seconds": <number — total duration in seconds, to one decimal>,

  "cuts": {
    "total_count": <integer — total number of visible cuts/edits in the entire video. A cut is any moment where the visual content changes discontinuously — a jump cut, a transition, a scene change, a switch to b-roll, a cut-zoom shift. Do NOT count smooth continuous camera movements as cuts>,
    "timestamps": [<array of numbers — the timestamp in seconds where each cut occurs, to one decimal>],
    "time_to_first_cut_seconds": <number — seconds from the start of the video to the first visible cut. If there is no cut, use the video duration>,
    "cuts_in_first_3_seconds": <integer — how many cuts occur in the first 3 seconds>,
    "cuts_in_first_5_seconds": <integer — how many cuts occur in the first 5 seconds>
  },

  "hook": {
    "type": <string — what type of hook is used in the first 2 seconds. Pick exactly one:
      "direct_address" — speaker looks at camera and starts talking immediately
      "text_hook" — text appears on screen as the primary attention grab
      "visual_surprise" — an unexpected or striking visual element
      "transformation" — a before/after or reveal that shows a result upfront
      "pattern_interrupt" — something visually or sonically jarring that breaks the scroll
      "question" — a question is posed verbally or via text
      "action_in_progress" — the video starts mid-action, no preamble
      "none" — no discernible hook technique
    >,
    "timing_seconds": <number — how many seconds into the video the hook element lands, to one decimal>
  },

  "framing_and_movement": {
    "primary_shot_type": <string — the shot type used for the majority of the video. Pick one:
      "close_up" — face fills most of the frame
      "medium_close_up" — head and shoulders
      "medium" — waist up
      "wide" — full body or environment
      "screen_recording" — the video is primarily a screen capture
      "mixed" — no single shot type dominates
    >,
    "has_zoom_movements": <boolean — are there any zoom-in or zoom-out camera movements during clips (not at cut points)>,
    "zoom_movement_count": <integer — how many distinct zoom movements occur>,
    "has_cut_zoom": <boolean — does the video alternate between two slightly different zoom levels at cut points, simulating a multi-camera setup from a single take? This is extremely common in talking head content — the framing jumps between normal and slightly tighter at sentence boundaries>,
    "framing_changes_at_cuts": <boolean — does the visual framing/size change when cuts happen, or do all clips have identical framing>
  },

  "transitions": {
    "types_observed": [<array of strings — which transition types are visible between clips. Include all that appear. Options:
      "hard_cut" — instant switch, no effect
      "dissolve" — crossfade between clips
      "wipe" — one clip slides over another directionally
      "zoom_transition" — zoom in/out used as transition between clips
      "whip" — fast directional blur between clips
      "flash" — white flash between clips
      "fade_black" — fade to/from black
      "fade_white" — fade to/from white
      "glitch" — digital distortion effect
      "smooth_slide" — smooth directional slide with easing
    >],
    "total_transition_count": <integer — total number of transitions that are NOT hard cuts>,
    "hard_cut_percentage": <number 0-1 — what fraction of all cuts are simple hard cuts with no transition effect>,
    "has_variety": <boolean — are at least 2 different transition types used>
  },

  "audio": {
    "has_background_music": <boolean — is there music playing underneath or alongside the primary content>,
    "music_energy_level": <string — "low" (ambient/chill), "medium" (moderate energy), "high" (intense/driving), "none" (no music)>,
    "has_sound_effects": <boolean — are there ANY added sound effects in the video? Listen carefully for: cash register / ching sounds, buzzer / "wrong answer" sounds, pop / click / snap sounds, whoosh / swoosh sounds, ding / bell / notification sounds, impact / thud sounds, typing sounds, camera shutter sounds, any other short non-musical audio accents that are clearly not the speaker's voice or the background music. These can appear at cuts, when text appears, on emphasis moments, or anywhere in the video. If you hear even ONE such sound, this is true>,
    "sound_effect_count": <integer — total number of individual sound effects heard across the entire video. Count each distinct sound event separately. A video with a pop when text appears, a ching on a money reference, and a whoosh on a cut has 3>,
    "sfx_at_transitions": <boolean — do any of the sound effects specifically land at or near cut points>,
    "sfx_on_text": <boolean — do any sound effects play when text appears on screen>,
    "sfx_on_emphasis": <boolean — do any sound effects play on emphasis moments in speech (key words, punchlines, reveals)>,
    "speaks_to_camera": <boolean — does a person speak directly to the camera/viewer>,
    "audio_feels_clean": <boolean — does the speech audio sound clean and processed (no background noise, room echo, or hiss) vs raw/unprocessed>
  },

  "speed": {
    "has_speed_changes": <boolean — are there any visible speed changes (slow motion, fast motion, speed ramps) in the video>,
    "speed_change_count": <integer — how many distinct speed changes are visible>,
    "has_speed_ramp": <boolean — is there a smooth acceleration or deceleration (a speed ramp) visible, as opposed to an abrupt speed change>,
    "base_speed_feels_accelerated": <boolean — does the overall playback speed feel slightly faster than natural speech/movement, suggesting the base footage was sped up>
  },

  "text_on_screen": {
    "has_text": <boolean — is there any text rendered on screen (not counting platform UI like username/caption)>,
    "text_element_count": <integer — how many distinct text elements appear across the whole video. Count each unique text appearance as one element>,
    "first_text_appears_at_seconds": <number — when does the first text element appear, in seconds from the start. null if no text>,
    "text_positions": [<array of strings — where text appears on the frame. Include all observed: "top", "center", "bottom">],
    "text_reinforces_speech": <boolean — do the text overlays show or reinforce what the speaker is saying, as opposed to being unrelated graphics>,
    "has_animated_captions": <boolean — are there word-by-word or sentence-by-sentence animated captions that follow the speaker's voice (the TikTok/Reels caption style where words appear or highlight as spoken)>,
    "has_hook_text": <boolean — is there a text element in the first 2 seconds designed to grab attention>,
    "has_cta_text": <boolean — is there a call-to-action text element (follow, link in bio, comment, etc.)>
  },

  "broll": {
    "has_broll": <boolean — does the video include any footage that is NOT the primary subject/scene? B-roll is supplementary footage — stock clips, cutaways, illustrations, screen recordings inserted into a talking head, etc.>,
    "broll_clip_count": <integer — how many separate b-roll clips appear>,
    "broll_total_seconds": <number — approximately how many total seconds of b-roll are in the video>,
    "broll_ratio": <number 0-1 — fraction of the total video duration that is b-roll>
  },

  "color_and_grade": {
    "looks_color_graded": <boolean — does the footage appear to have intentional color grading applied (beyond what a phone camera produces by default)>,
    "overall_tone": <string — pick one:
      "warm_natural" — warm tones but looks natural, not heavily processed
      "warm_saturated" — warm and noticeably boosted saturation
      "cool" — blue/green shifted tones
      "neutral" — no obvious color shift
      "high_contrast" — deep blacks, bright highlights, punchy
      "desaturated" — muted, low saturation, film-like
      "vibrant" — very high saturation across the board
    >,
    "has_vignette": <boolean — are the edges of the frame visibly darker than the center>
  },

  "ending": {
    "type": <string — how does the video end. Pick one:
      "abrupt" — cuts off suddenly, no outro
      "fade_black" — fades to black
      "fade_white" — fades to white
      "freeze" — last frame holds briefly before ending
      "cta_hold" — ends on a call-to-action frame or text
      "loop" — the end visually or sonically connects back to the beginning, creating a seamless loop
    >,
    "has_cta_at_end": <boolean — is there a call to action in the last 3 seconds (spoken, text, or visual)>,
    "loops_cleanly": <boolean — if you played the last frame followed immediately by the first frame, would it feel like a continuous or near-continuous viewing experience with no jarring visual break>
  },

  "overall_production": {
    "feels_professionally_edited": <boolean — overall, does this video look like it was edited with intentional creative choices (cuts, transitions, effects, text, sound design) vs. a single raw clip uploaded directly from a phone>,
    "editing_intensity": <string — pick one:
      "minimal" — very few visible edits, mostly raw footage
      "light" — some cuts and basic text, but mostly the source content
      "moderate" — clear editing with cuts, some effects, text overlays
      "heavy" — many cuts, transitions, effects, sound design, text — the editing is a defining feature of the video
    >
  }
}

CRITICAL RULES:
- Watch the ENTIRE video before writing any JSON. Many editing patterns only become clear after seeing the full piece.
- Count cuts by watching for discontinuities in the visual content. Do not count continuous camera movements.
- For timestamps, measure from the start of the video (0.0 seconds).
- For boolean fields, be definitive — true or false. Only use null if the video is genuinely too ambiguous to judge.
- For "has_cut_zoom": this is specifically the technique where a talking head alternates between normal and slightly-zoomed framing at sentence breaks. It is NOT the same as zoom transitions between clips.
- For "loops_cleanly": imagine the platform auto-playing the video again immediately after it ends. Would the viewer feel a smooth continuation or a jarring reset?
- Do not include any text outside the JSON object. No markdown, no explanation, no preamble.`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadVideoFromSupabase(videoFileUrl, localPath) {
  console.log(`[analyzer]   Downloading from: "${videoFileUrl}"`);

  // Extract the storage path from whatever format was stored
  let storagePath = videoFileUrl;

  // If it's a full Supabase URL, extract just the path after the bucket name
  if (storagePath.includes('/trend-videos/')) {
    storagePath = storagePath.split('/trend-videos/').pop();
  }

  // Remove any leading slashes
  storagePath = storagePath.replace(/^\/+/, '');

  console.log(`[analyzer]   Resolved storage path: "${storagePath}"`);

  // Method 1: Try Supabase SDK download (works for private buckets)
  try {
    const { data, error } = await supabase.storage
      .from('trend-videos')
      .download(storagePath);

    if (error) throw error;

    const buffer = Buffer.from(await data.arrayBuffer());
    fs.writeFileSync(localPath, buffer);
    console.log(`[analyzer]   Downloaded via Supabase SDK: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
    return;
  } catch (sdkErr) {
    console.log(`[analyzer]   Supabase SDK download failed: ${sdkErr.message}, trying signed URL...`);
  }

  // Method 2: Try creating a signed URL and downloading via fetch
  try {
    const { data: signedData, error: signedError } = await supabase.storage
      .from('trend-videos')
      .createSignedUrl(storagePath, 300); // 5 minute expiry

    if (signedError) throw signedError;

    const response = await fetch(signedData.signedUrl);
    if (!response.ok) throw new Error(`Signed URL fetch failed: ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(localPath, buffer);
    console.log(`[analyzer]   Downloaded via signed URL: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
    return;
  } catch (signedErr) {
    console.log(`[analyzer]   Signed URL download failed: ${signedErr.message}, trying direct fetch...`);
  }

  // Method 3: Try direct fetch as a last resort (works if it's already a valid URL)
  if (videoFileUrl.startsWith('http')) {
    const response = await fetch(videoFileUrl);
    if (!response.ok) throw new Error(`Direct fetch failed: ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(localPath, buffer);
    console.log(`[analyzer]   Downloaded via direct fetch: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
    return;
  }

  throw new Error(`All download methods failed for: ${videoFileUrl}`);
}

async function analyzeVideo(videoRow) {
  const videoId = videoRow.id;
  const localPath = path.join(os.tmpdir(), `trend-${videoId}.mp4`);

  try {
    // 1. Download video to local temp file
    console.log(`[analyzer]   Downloading video ${videoId}...`);
    console.log(`[analyzer]   video_file_url value: "${videoRow.video_file_url}"`);
    console.log(`[analyzer]   Type: ${typeof videoRow.video_file_url}`);
    await downloadVideoFromSupabase(videoRow.video_file_url, localPath);

    // 2. Upload to Gemini file API
    console.log('[analyzer]   Uploading to Gemini...');
    const model = genai.getGenerativeModel({ model: GEMINI_MODEL });

    // Read the file and prepare for Gemini
    const videoData = fs.readFileSync(localPath);
    const base64Video = videoData.toString('base64');

    // 3. Send extraction prompt with video
    console.log('[analyzer]   Analyzing with Gemini...');
    const result = await Promise.race([
      model.generateContent([
        {
          inlineData: {
            mimeType: 'video/mp4',
            data: base64Video,
          },
        },
        { text: EXTRACTION_PROMPT },
      ]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Gemini timeout')), TIMEOUT_MS)
      ),
    ]);

    const responseText = result.response.text();

    // 4. Parse JSON from response
    // Gemini sometimes wraps JSON in ```json ... ``` blocks
    let jsonText = responseText.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    }

    let analysisJson;
    try {
      analysisJson = JSON.parse(jsonText);
    } catch (parseErr) {
      console.error(`[analyzer]   JSON parse failed for ${videoId}, attempting cleanup...`);
      // Try to extract JSON from the response if there's extra text
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysisJson = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error(`Could not parse JSON from Gemini response: ${parseErr.message}`);
      }
    }

    // 5. Basic validation — check that key fields exist
    if (!analysisJson.cuts || !analysisJson.hook || !analysisJson.audio) {
      throw new Error('Gemini response missing required top-level fields');
    }

    // 6. Store in trend_analyses
    const { error: insertError } = await supabase.from('trend_analyses').insert({
      trend_video_id: videoId,
      analysis_json: analysisJson,
      gemini_model: GEMINI_MODEL,
    });

    if (insertError) throw new Error(`Insert failed: ${insertError.message}`);

    // 7. Mark video as analyzed
    await supabase
      .from('trend_videos')
      .update({ analyzed: true })
      .eq('id', videoId);

    // 8. Delete video file from Supabase storage (cleanup)
    if (videoRow.video_file_url && !videoRow.video_file_url.startsWith('http')) {
      await supabase.storage
        .from('trend-videos')
        .remove([videoRow.video_file_url]);
    }

    console.log(`[analyzer]   ✓ ${videoId} analyzed successfully`);
    return { success: true, videoId };
  } catch (err) {
    console.error(`[analyzer]   ✗ ${videoId} failed: ${err.message}`);

    // Mark as analyzed even on failure so we don't retry endlessly
    await supabase
      .from('trend_videos')
      .update({ analyzed: true })
      .eq('id', videoId);

    return { success: false, videoId, error: err.message };
  } finally {
    // Clean up local temp file
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
    }
  }
}

async function run(batchId) {
  if (!(process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY)) {
    throw new Error('GOOGLE_AI_API_KEY or GEMINI_API_KEY is required');
  }
  if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is required');
  if (!process.env.SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY is required');

  // If no batchId provided, analyze ALL unanalyzed videos
  let query = supabase
    .from('trend_videos')
    .select('*')
    .eq('analyzed', false)
    .order('scraped_at', { ascending: true });

  if (batchId) {
    query = query.eq('batch_id', batchId);
  }

  const { data: videos, error } = await query;

  if (error) {
    console.error(`[analyzer] Failed to query trend_videos: ${error.message}`);
    process.exit(1);
  }

  if (!videos || videos.length === 0) {
    console.log('[analyzer] No unanalyzed videos found');
    return { analyzed: 0, failed: 0 };
  }

  console.log(`[analyzer] Found ${videos.length} unanalyzed videos`);

  let analyzed = 0;
  let failed = 0;

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    console.log(`[analyzer] Processing ${i + 1}/${videos.length}: ${video.id}`);

    const result = await analyzeVideo(video);

    if (result.success) {
      analyzed++;
    } else {
      failed++;
    }

    // Rate limit delay between videos (skip after last video)
    if (i < videos.length - 1) {
      await sleep(DELAY_BETWEEN_VIDEOS_MS);
    }
  }

  const failRate = videos.length > 0 ? failed / videos.length : 0;
  if (failRate > 0.3) {
    console.warn(`[analyzer] WARNING: ${(failRate * 100).toFixed(0)}% failure rate — check Gemini API status`);
  }

  console.log(`[analyzer] Complete — analyzed: ${analyzed}, failed: ${failed}`);
  return { analyzed, failed };
}

// Run if called directly — optional batchId as first argument
if (require.main === module) {
  const batchId = process.argv[2] || null;
  run(batchId)
    .then((result) => {
      console.log('[analyzer] Finished:', result);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[analyzer] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { run };
