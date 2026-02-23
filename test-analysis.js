import 'dotenv/config';
import { analyzeVideo } from './lib/video-processor/analyze-video.js';

async function test() {
  // IMPORTANT: Replace with your actual video URL from Supabase Storage
  const testVideoUrl = 'PASTE_YOUR_VIDEO_URL_HERE';
  
  console.log('Testing video analysis pipeline...\n');
  
  try {
  const analysis = await analyzeVideo(testVideoUrl);
    
    console.log('\n=== ANALYSIS RESULT ===');
    console.log(JSON.stringify(analysis, null, 2));
    console.log('\n=== ANALYSIS SUMMARY ===');
    console.log(`Duration: ${analysis.duration}s`);
    console.log(`Resolution: ${analysis.dimensions.width}x${analysis.dimensions.height}`);
    console.log(`FPS: ${analysis.fps}`);
    console.log(`Words transcribed: ${analysis.audio.words.length}`);
    console.log(`Utterances: ${analysis.audio.transcript.length}`);
    console.log(`Beats detected: ${analysis.audio.beats.length}`);
    console.log(`Emphasis moments: ${analysis.audio.emphasisMoments.length}`);
    console.log('\n=== TEST COMPLETE ✅ ===');
    
  } catch (error) {
    console.error('\n=== TEST FAILED ❌ ===');
    console.error('Error details:', error.message);
    console.error('Full error:', error);
    process.exit(1);
  }
}

test();
