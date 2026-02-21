const axios = require('axios');

async function renderVideo(timeline, onProgress) {
  console.log('🎥 Submitting to Creatomate...');
  onProgress?.(70, 'Starting render...');
  
  const renderId = await submitRender(timeline);
  
  onProgress?.(75, 'Rendering...');
  const videoUrl = await waitForRender(renderId, onProgress);
  
  console.log(`  ✅ Render complete: ${videoUrl}`);
  return videoUrl;
}

async function submitRender(timeline) {
  const response = await axios.post(
    'https://api.creatomate.com/v1/renders',
    timeline,
    {
      headers: {
        'Authorization': `Bearer ${process.env.CREATOMATE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  console.log(`  Render ID: ${response.data.id}`);
  return response.data.id;
}

async function waitForRender(renderId, onProgress) {
  let attempts = 0;
  const maxAttempts = 120;
  
  while (attempts < maxAttempts) {
    await sleep(2000);
    attempts++;
    
    const response = await axios.get(
      `https://api.creatomate.com/v1/renders/${renderId}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.CREATOMATE_API_KEY}`
        }
      }
    );
    
    const status = response.data.status;
    
    if (status === 'succeeded') {
      return response.data.url;
    }
    
    if (status === 'failed') {
      throw new Error(`Render failed: ${response.data.error_message || 'Unknown error'}`);
    }
    
    const progress = 75 + Math.min(20, Math.floor((attempts / maxAttempts) * 20));
    onProgress?.(progress, 'Rendering...');
  }
  
  throw new Error('Render timeout');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { renderVideo };
