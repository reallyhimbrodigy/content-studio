require('dotenv').config({ path: '.env.local' });
const axios = require('axios');

const key = process.env.TWELVE_LABS_API_KEY;
const indexId = process.env.TWELVE_LABS_INDEX_ID;
const videoId = '699a3a85c10245a321ffff4f'; // Use the video ID from logs

const endpoints = [
  {
    name: 'Generate - Text Summary',
    method: 'POST',
    url: `https://api.twelvelabs.io/v1.3/generate`,
    payload: {
      video_id: videoId,
      prompt: 'Describe every shot in this video with timing and visual details'
    }
  },
  {
    name: 'Generate - Gist',
    method: 'POST',
    url: `https://api.twelvelabs.io/v1.3/gist`,
    payload: {
      video_id: videoId,
      types: ['topic', 'hashtag', 'title']
    }
  },
  {
    name: 'Summarize',
    method: 'POST',
    url: `https://api.twelvelabs.io/v1.3/summarize`,
    payload: {
      video_id: videoId,
      type: 'summary'
    }
  },
  {
    name: 'Generate with Index',
    method: 'POST',
    url: `https://api.twelvelabs.io/v1.3/indexes/${indexId}/videos/${videoId}/generate`,
    payload: {
      prompt: 'List all the shots in this video with timestamps'
    }
  }
];

(async () => {
  for (const endpoint of endpoints) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing: ${endpoint.name}`);
    console.log(`Method: ${endpoint.method}`);
    console.log(`URL: ${endpoint.url}`);
    console.log(`Payload:`, JSON.stringify(endpoint.payload, null, 2));
    
    try {
      const response = await axios({
        method: endpoint.method,
        url: endpoint.url,
        data: endpoint.payload,
        headers: {
          'x-api-key': key,
          'Content-Type': 'application/json'
        }
      });
      
      console.log('\n✅ SUCCESS!');
      console.log('Status:', response.status);
      console.log('Response:', JSON.stringify(response.data, null, 2));
      console.log('\n🎯 THIS ENDPOINT WORKS - USE IT IN CODE!');
      process.exit(0);
      
    } catch (error) {
      console.log('\n❌ Failed');
      console.log('Status:', error.response?.status);
      console.log('Error:', error.response?.data);
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('❌ None of the endpoints worked');
  console.log('\nTry checking Twelve Labs docs for v1.3 API');
})();
