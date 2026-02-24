const { analyzeVideo } = require('./analyze-video');
const { transcribeIfNeeded } = require('./transcribe');
const { generateEdit } = require('./generate-edit');
const { renderVideo } = require('./render-ffmpeg');
const { supabaseAdmin } = require('../../services/supabase-admin');

async function processVideoJob({ videoUrl, vibeInput, jobId, onProgress }) {
  console.log('\n' + '='.repeat(80));
  console.log(`🚀 JOB ${jobId}: "${vibeInput}"`);
  console.log('='.repeat(80));

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

    // Stage 3: AI creative direction (Claude)
    const editPlan = await generateEdit(analysis, transcript, vibeInput, onProgress);

    // Stage 4 + 5: Render with FFmpeg and upload to Supabase
    const finalVideoUrl = await renderVideo(editPlan, videoUrl, jobId, onProgress, transcript);

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
  }
}

module.exports = { processVideoJob };
