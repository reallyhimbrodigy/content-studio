const axios = require('axios');
const FormData = require('form-data');

async function analyzeVideo(videoUrl, onProgress) {
  console.log('🎬 Starting deep video analysis...');
  onProgress?.(5, 'Analyzing video...');
  
  // Submit video to Twelve Labs
  const taskId = await submitVideo(videoUrl);
  
  // Wait for analysis to complete
  onProgress?.(10, 'Processing video...');
  const videoId = await waitForAnalysis(taskId, onProgress);
  
  // Retrieve complete analysis
  onProgress?.(25, 'Extracting insights...');
  const analysis = await getAnalysis(videoId);
  
  onProgress?.(30, 'Video analysis complete');
  
  return analysis;
}

async function submitVideo(videoUrl) {
  console.log('📡 Submitting video to Twelve Labs...');
  console.log('  API Key present:', !!process.env.TWELVE_LABS_API_KEY);
  console.log('  API Key length:', process.env.TWELVE_LABS_API_KEY?.length || 0);
  console.log('  API Key first 10 chars:', process.env.TWELVE_LABS_API_KEY?.substring(0, 10) || 'MISSING');
  console.log('  Index ID present:', !!process.env.TWELVE_LABS_INDEX_ID);
  console.log('  Index ID:', process.env.TWELVE_LABS_INDEX_ID || 'MISSING');
  console.log('  Video URL:', videoUrl);
  
  const indexId = process.env.TWELVE_LABS_INDEX_ID;
  const url = 'https://api.twelvelabs.io/v1.3/tasks';
  const form = new FormData();
  form.append('index_id', indexId);
  form.append('video_url', videoUrl);
  
  const headers = {
    'x-api-key': process.env.TWELVE_LABS_API_KEY,
    ...form.getHeaders()
  };
  
  console.log('  Request URL:', url);
  console.log('  Request payload:', JSON.stringify({ index_id: indexId, video_url: videoUrl }, null, 2));
  console.log('  Request headers:', { 
    'x-api-key': headers['x-api-key'] ? `${headers['x-api-key'].substring(0, 10)}...` : 'MISSING',
    'Content-Type': headers['content-type']
  });
  
  try {
    const response = await axios.post(url, form, { headers });
    
    console.log('  ✅ Response status:', response.status);
    console.log('  Response data:', response.data);
    console.log(`  Video ID: ${response.data._id}`);
    
    return response.data._id;
  } catch (error) {
    console.error('  ❌ Twelve Labs API Error:');
    console.error('  Status:', error.response?.status);
    console.error('  Status Text:', error.response?.statusText);
    console.error('  Response data:', JSON.stringify(error.response?.data, null, 2));
    console.error('  Request URL:', url);
    console.error('  Request method:', 'POST');
    throw error;
  }
}

async function waitForAnalysis(taskId, onProgress) {
  let attempts = 0;
  const maxAttempts = 120;
  
  while (attempts < maxAttempts) {
    await sleep(3000);
    attempts++;
    
    const url = `https://api.twelvelabs.io/v1.3/tasks/${taskId}`;
    
    const response = await axios.get(url, {
      headers: { 'x-api-key': process.env.TWELVE_LABS_API_KEY }
    });
    
    const status = response.data.status;
    
    if (status === 'ready') {
      console.log(`  Analysis complete (${attempts * 3}s)`);
      return response.data.video_id || taskId;
    }
    
    if (status === 'failed') {
      throw new Error(`Video analysis failed: ${response.data.error || 'Unknown error'}`);
    }
    
    const progress = 10 + Math.min(15, Math.floor((attempts / maxAttempts) * 15));
    onProgress?.(progress, 'Analyzing video...');
  }
  
  throw new Error('Video analysis timeout');
}

async function getAnalysis(videoId) {
  console.log('📊 Getting analysis results...');
  console.log('  Video ID:', videoId);
  
  const indexId = process.env.TWELVE_LABS_INDEX_ID;
  
  // First try to get video details
  const videoUrl = `https://api.twelvelabs.io/v1.3/indexes/${indexId}/videos/${videoId}`;
  console.log('  Video details URL:', videoUrl);
  
  try {
    const response = await axios.get(videoUrl, {
      headers: { 'x-api-key': process.env.TWELVE_LABS_API_KEY }
    });
    
    console.log('  ✅ Video details retrieved');
    console.log('  Video data:', JSON.stringify(response.data, null, 2));
    
    const videoData = response.data;
    
    // Now try search
    const searchUrl = 'https://api.twelvelabs.io/v1.3/search';
    console.log('  Search URL:', searchUrl);
    
    const formData = new FormData();
    
    formData.append('index_id', indexId);
    formData.append('query', "Describe every shot in detail including visual content, motion, energy, and timing");
    formData.append('search_options', JSON.stringify(["visual", "conversation", "text_in_video"]));
    formData.append('video_ids', JSON.stringify([videoId]));
    
    console.log('  Search payload:', JSON.stringify({
      index_id: indexId,
      query: "Describe every shot in detail including visual content, motion, energy, and timing",
      search_options: ["visual", "conversation", "text_in_video"],
      video_ids: [videoId]
    }, null, 2));
    console.log('  Sending search request with form-data...');
    
    const searchResponse = await axios.post(
      searchUrl,
      formData,
      {
        headers: {
          'x-api-key': process.env.TWELVE_LABS_API_KEY,
          ...formData.getHeaders()
        }
      }
    );
    
    console.log('  ✅ Search completed');
    console.log('  Search results:', JSON.stringify(searchResponse.data, null, 2));
    
    const searchData = searchResponse.data.data[0];
    
    return {
      duration: videoData.metadata?.duration || 0,
      shots: searchData.clips.map(clip => ({
        start: clip.start,
        end: clip.end,
        description: clip.metadata?.text || clip.metadata?.visual || '',
        score: clip.score
      })),
      metadata: videoData.metadata
    };
  } catch (error) {
    console.error('  ❌ getAnalysis Error:');
    console.error('  Status:', error.response?.status);
    console.error('  Status Text:', error.response?.statusText);
    console.error('  Response data:', JSON.stringify(error.response?.data, null, 2));
    console.error('  Request URL:', error.config?.url);
    console.error('  Request method:', error.config?.method);
    console.error('  Request data:', error.config?.data);
    throw error;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { analyzeVideo };
