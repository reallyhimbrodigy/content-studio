const { analyzeVideo } = require('./analyze-video');
const { transcribeIfNeeded } = require('./transcribe');
const { generateEdit } = require('./generate-edit');
const { buildCreatomateTimeline } = require('./build-timeline');
const { renderVideo } = require('./render');

async function processVideoJob({ videoUrl, vibeInput, jobId, onProgress }) {
  console.log('\n' + '='.repeat(80));
  console.log(`🚀 JOB ${jobId}: "${vibeInput}"`);
  console.log('='.repeat(80));
  
  try {
    // Stage 1: Deep video understanding
    const analysis = await analyzeVideo(videoUrl, onProgress);
    
    // Stage 2: Speech transcription (if needed)
    const transcript = await transcribeIfNeeded(videoUrl, analysis, onProgress);
    
    // Stage 3: AI creative decisions
    const recipe = await generateEdit(analysis, transcript, vibeInput, onProgress);
    
    // Stage 4: Build professional timeline
    const timeline = buildCreatomateTimeline(recipe, videoUrl, analysis);
    
    // Stage 5: Render final video
    const finalVideoUrl = await renderVideo(timeline, onProgress);
    
    console.log('='.repeat(80));
    console.log(`✅ JOB ${jobId} COMPLETE`);
    console.log(`📹 Output: ${finalVideoUrl}`);
    console.log('='.repeat(80) + '\n');
    
    return {
      rendered_video_url: finalVideoUrl,
      edit_recipe: recipe,
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
