require('dotenv').config({ path: '.env.local' });
const axios = require('axios');

const key = process.env.TWELVE_LABS_API_KEY;

console.log('Creating Twelve Labs index with GENERATE capabilities...');
console.log('API Key:', key.substring(0, 10) + '...');

async function createGenerateIndex() {
  try {
    // Try Pegasus 1.2 which supports generation
    const response = await axios.post(
      'https://api.twelvelabs.io/v1.3/indexes',
      {
        index_name: 'promptly-video-editor-generate',
        models: [
          {
            model_name: 'pegasus1.2',
            model_options: ['visual', 'conversation']
          }
        ],
        addons: ['generate']  // Enable generate addon
      },
      {
        headers: {
          'x-api-key': key,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('\n✅ Index created successfully!');
    console.log('\nIndex Details:');
    console.log('  Name:', response.data.index_name);
    console.log('  ID:', response.data._id);
    console.log('  Models:', JSON.stringify(response.data.models, null, 2));
    console.log('  Addons:', JSON.stringify(response.data.addons, null, 2));
    
    console.log('\n📝 UPDATE YOUR .ENV.LOCAL:');
    console.log(`TWELVE_LABS_INDEX_ID=${response.data._id}`);
    
    return response.data._id;
    
  } catch (error) {
    console.error('\n❌ Failed to create index:');
    console.error('Status:', error.response?.status);
    console.error('Error:', JSON.stringify(error.response?.data, null, 2));
    
    // If pegasus1.2 doesn't work, try other combinations
    console.log('\nTrying alternative configurations...');
    
    const alternatives = [
      {
        index_name: 'promptly-generate-v2',
        models: [{ model_name: 'marengo2.7', model_options: ['visual', 'conversation'] }],
        addons: ['generate']
      },
      {
        index_name: 'promptly-generate-v3',
        models: [{ model_name: 'pegasus1.2' }],
        addons: ['generate']
      }
    ];
    
    for (const config of alternatives) {
      try {
        console.log(`\nTrying: ${JSON.stringify(config, null, 2)}`);
        const resp = await axios.post(
          'https://api.twelvelabs.io/v1.3/indexes',
          config,
          {
            headers: {
              'x-api-key': key,
              'Content-Type': 'application/json'
            }
          }
        );
        
        console.log('\n✅ Alternative config worked!');
        console.log('Index ID:', resp.data._id);
        console.log(`\nTWELVE_LABS_INDEX_ID=${resp.data._id}`);
        return resp.data._id;
        
      } catch (err) {
        console.log('❌ Failed:', err.response?.data?.message);
      }
    }
    
    process.exit(1);
  }
}

createGenerateIndex().then(async (indexId) => {
  // Update .env.local
  const fs = require('fs');
  const envPath = '.env.local';
  let envContent = fs.readFileSync(envPath, 'utf8');
  
  // Replace the TWELVE_LABS_INDEX_ID line
  envContent = envContent.replace(
    /TWELVE_LABS_INDEX_ID=.*/,
    `TWELVE_LABS_INDEX_ID=${indexId}`
  );
  
  fs.writeFileSync(envPath, envContent);
  console.log('\n✅ .env.local updated with new index ID');
});
