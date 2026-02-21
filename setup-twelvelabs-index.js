require('dotenv').config({ path: '.env.local' });
const axios = require('axios');

async function createIndex() {
  console.log('Creating Twelve Labs index with correct engines...');
  
  const apiKey = process.env.TWELVE_LABS_API_KEY;
  
  if (!apiKey) {
    console.error('❌ TWELVE_LABS_API_KEY not found in environment');
    process.exit(1);
  }
  
  console.log('API Key:', apiKey.substring(0, 10) + '...');
  
  try {
    const response = await axios.post(
      'https://api.twelvelabs.io/v1.2/indexes',
      {
        index_name: 'promptly-video-editor',
        engines: [
          {
            engine_name: 'marengo2.6',
            options: ['visual', 'conversation', 'text_in_video']
          }
        ]
      },
      {
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('\n✅ Index created successfully!');
    console.log('\nIndex Details:');
    console.log('  Name:', response.data.index_name);
    console.log('  ID:', response.data._id);
    console.log('  Engines:', JSON.stringify(response.data.engines, null, 2));
    console.log('\n📝 UPDATE YOUR .ENV.LOCAL:');
    console.log(`TWELVE_LABS_INDEX_ID=${response.data._id}`);
    console.log('\nCopy the line above and paste it into your .env.local file');
    
  } catch (error) {
    console.error('\n❌ Failed to create index:');
    console.error('Status:', error.response?.status);
    console.error('Error:', JSON.stringify(error.response?.data, null, 2));
    process.exit(1);
  }
}

createIndex();
