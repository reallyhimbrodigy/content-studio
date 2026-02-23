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
    // Stage 1: Deep video understanding (Gemini)
    const analysis = await analyzeVideo(videoUrl, onProgress);
    console.log(`[process-job] Gemini analysis:\n${JSON.stringify(analysis, null, 2)}`);
    await supabaseAdmin
      .from('video_jobs')
      .update({ analysis_data: analysis })
      .eq('id', jobId);

    // Stage 2: Speech transcription with word timestamps (Deepgram)
    const transcript = await transcribeIfNeeded(videoUrl, analysis, onProgress);

    // Stage 3: AI creative direction (Claude)
    const editPlan = await generateEdit(analysis, transcript, vibeInput, onProgress);

    // Stage 4 + 5: Render with FFmpeg and upload to Supabase
    const finalVideoUrl = await renderVideo(editPlan, videoUrl, jobId, onProgress);

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
