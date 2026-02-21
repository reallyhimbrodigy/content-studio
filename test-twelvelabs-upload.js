require('dotenv').config({ path: '.env.local' });
const axios = require('axios');

const key = process.env.TWELVE_LABS_API_KEY;
const indexId = process.env.TWELVE_LABS_INDEX_ID;
const testVideoUrl = 'https://sample-videos.com/video123/mp4/240/big_buck_bunny_240p_1mb.mp4';

const endpoints = [
  {
    name: 'tasks endpoint',
    url: `https://api.twelvelabs.io/v1.3/tasks`,
    payload: {
      index_id: indexId,
      video_url: testVideoUrl
    }
  },
  {
    name: 'indexes videos endpoint',
    url: `https://api.twelvelabs.io/v1.3/indexes/${indexId}/videos`,
    payload: {
      url: testVideoUrl
    }
  },
  {
    name: 'indexes tasks endpoint',
    url: `https://api.twelvelabs.io/v1.3/indexes/${indexId}/tasks`,
    payload: {
      url: testVideoUrl
    }
  },
  {
    name: 'videos endpoint',
    url: `https://api.twelvelabs.io/v1.3/videos`,
    payload: {
      index_id: indexId,
      url: testVideoUrl
    }
  }
];

(async () => {
  for (const endpoint of endpoints) {
    console.log(`\nTesting: ${endpoint.name}`);
    console.log(`URL: ${endpoint.url}`);
    
    try {
      const response = await axios.post(endpoint.url, endpoint.payload, {
        headers: {
          'x-api-key': key,
          'Content-Type': 'application/json'
        }
      });
      
      console.log('✅ SUCCESS!');
      console.log('Status:', response.status);
      console.log('Response:', JSON.stringify(response.data, null, 2));
      console.log('\n🎯 USE THIS ENDPOINT IN CODE');
      process.exit(0);
      
    } catch (error) {
      console.log('❌ Failed');
      console.log('Status:', error.response?.status);
      console.log('Error:', error.response?.data);
    }
  }
  
  console.log('\n❌ None of the endpoints worked');
})();
