const { analyzeVideo } = require('./analyze-video');
const { transcribeIfNeeded } = require('./transcribe');
const { generateEdit } = require('./generate-edit');
const { renderVideo } = require('./render-ffmpeg');
const { supabaseAdmin } = require('../../services/supabase-admin');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Pre-download the source video to a local file.
 * This runs in parallel with Claude edit planning so the file
 * is already on disk when FFmpeg needs it.
 */
async function preDownloadVideo(videoUrl, jobId) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `promptly-src-${jobId}-`));
  const sourcePath = path.join(tmpDir, 'source.mp4');

  const response = await axios({
    method: 'GET',
    url: videoUrl,
    responseType: 'stream',
    timeout: 120_000,
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(sourcePath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  const sizeMB = (fs.statSync(sourcePath).size / 1024 / 1024).toFixed(1);
  console.log(`[process-job] Pre-downloaded source: ${sizeMB}MB -> ${sourcePath}`);

  return sourcePath;
}

async function processVideoJob({ videoUrl, vibeInput, jobId, onProgress }) {
  console.log('\n' + '='.repeat(80));
  console.log(`🚀 JOB ${jobId}: "${vibeInput}"`);
  console.log('='.repeat(80));

  let preDownloadedPath = null;

  try {
    // Stage 1 + 2: Run Gemini analysis and Deepgram transcription in parallel
    // They don't depend on each other — this saves 10-15 seconds
    const [analysis, transcript] = await Promise.all([
      analyzeVideo(videoUrl, onProgress),
      transcribeIfNeeded(videoUrl, null, onProgress),
    ]);

    console.log(`[process-job] Gemini analysis:\n${JSON.stringify(analysis, null, 2)}`);
    await supabaseAdmin
      .from('video_jobs')
      .update({ analysis_data: analysis })
      .eq('id', jobId);

    // Stage 3: AI creative direction (Claude) + pre-download source video in parallel
    // Claude takes 10-20s to plan. The source download takes 5-15s.
    // Running them together means the file is ready when FFmpeg starts.
    const [editPlan, downloadedPath] = await Promise.all([
      generateEdit(analysis, transcript, vibeInput, onProgress),
      preDownloadVideo(videoUrl, jobId),
    ]);

    preDownloadedPath = downloadedPath;

    // Stage 4 + 5: Render with FFmpeg and upload to Supabase
    // Pass the pre-downloaded source path so renderVideo skips its own download
    const finalVideoUrl = await renderVideo(editPlan, videoUrl, jobId, onProgress, transcript, preDownloadedPath);

    console.log('='.repeat(80));
    console.log(`✅ JOB ${jobId} COMPLETE`);
    console.log(`📹 Output: ${finalVideoUrl}`);
    console.log('='.repeat(80) + '\n');

    return {
      rendered_video_url: finalVideoUrl,
      edit_recipe: editPlan,
      metadata: {
        duration: analysis.duration,
        shots_analyzed: analysis.shots.length,
        has_speech: transcript.text.length > 0
      }
    };

  } catch (error) {
    console.error('='.repeat(80));
    console.error(`❌ JOB ${jobId} FAILED`);
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('='.repeat(80) + '\n');
    throw error;
  } finally {
    // Clean up pre-downloaded file if renderVideo didn't already
    if (preDownloadedPath) {
      try {
        const dir = path.dirname(preDownloadedPath);
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`[process-job] Cleaned up pre-download: ${dir}`);
      } catch (e) {
        // May already be cleaned up by renderVideo, that's fine
      }
    }
  }
}

module.exports = { processVideoJob };
