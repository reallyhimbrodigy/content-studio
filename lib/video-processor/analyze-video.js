const axios = require('axios');

async function analyzeVideo(videoUrl, onProgress) {
  console.log('🎬 Starting deep video analysis...');
  onProgress?.(5, 'Analyzing video...');
  
  // Submit video to Twelve Labs
  const taskId = await submitVideo(videoUrl);
  
  // Wait for analysis to complete
  onProgress?.(10, 'Processing video...');
  await waitForAnalysis(taskId, onProgress);
  
  // Retrieve complete analysis
  onProgress?.(25, 'Extracting insights...');
  const analysis = await getAnalysis(taskId);
  
  onProgress?.(30, 'Video analysis complete');
  
  return analysis;
}

async function submitVideo(videoUrl) {
  const response = await axios.post(
    'https://api.twelvelabs.io/v1.2/tasks',
    {
      index_id: process.env.TWELVE_LABS_INDEX_ID,
      video_url: videoUrl,
      provide_transcription: false
    },
    {
      headers: {
        'x-api-key': process.env.TWELVE_LABS_API_KEY,
        'Content-Type': 'application/json'
      }
    }
  );
  
  console.log(`  Task created: ${response.data._id}`);
  return response.data._id;
}

async function waitForAnalysis(taskId, onProgress) {
  let attempts = 0;
  const maxAttempts = 120;
  
  while (attempts < maxAttempts) {
    await sleep(3000);
    attempts++;
    
    const response = await axios.get(
      `https://api.twelvelabs.io/v1.2/tasks/${taskId}`,
      {
        headers: { 'x-api-key': process.env.TWELVE_LABS_API_KEY }
      }
    );
    
    const status = response.data.status;
    
    if (status === 'ready') {
      console.log(`  Analysis complete (${attempts * 3}s)`);
      return response.data.video_id;
    }
    
    if (status === 'failed') {
      throw new Error(`Video analysis failed: ${response.data.error_message}`);
    }
    
    const progress = 10 + Math.min(15, Math.floor((attempts / maxAttempts) * 15));
    onProgress?.(progress, 'Analyzing video...');
  }
  
  throw new Error('Video analysis timeout');
}

async function getAnalysis(taskId) {
  const response = await axios.get(
    `https://api.twelvelabs.io/v1.2/tasks/${taskId}`,
    {
      headers: { 'x-api-key': process.env.TWELVE_LABS_API_KEY }
    }
  );
  
  const videoId = response.data.video_id;
  
  const searchResponse = await axios.post(
    'https://api.twelvelabs.io/v1.2/search',
    {
      index_id: process.env.TWELVE_LABS_INDEX_ID,
      query: "Describe every shot in detail including visual content, motion, energy, and timing",
      search_options: ["visual", "conversation", "text_in_video"],
      video_ids: [videoId]
    },
    {
      headers: { 'x-api-key': process.env.TWELVE_LABS_API_KEY }
    }
  );
  
  const videoData = searchResponse.data.data[0];
  
  return {
    duration: videoData.metadata.duration,
    shots: videoData.clips.map(clip => ({
      start: clip.start,
      end: clip.end,
      description: clip.metadata?.text || clip.metadata?.visual || '',
      score: clip.score
    })),
    metadata: videoData.metadata
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { analyzeVideo };
