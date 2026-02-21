const { createClient } = require('@deepgram/sdk');
const axios = require('axios');

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

async function transcribeIfNeeded(videoUrl, analysis, onProgress) {
  const hasSpeech = checkForSpeech(analysis);
  
  if (!hasSpeech) {
    console.log('  No speech detected, skipping transcription');
    return { text: '', words: [] };
  }
  
  console.log('📝 Transcribing speech...');
  onProgress?.(32, 'Transcribing speech...');
  
  try {
    const response = await axios({
      method: 'GET',
      url: videoUrl,
      responseType: 'arraybuffer'
    });
    
    const buffer = Buffer.from(response.data);
    
    const { result } = await deepgram.listen.prerecorded.transcribeFile(buffer, {
      model: 'nova-2',
      smart_format: true,
      utterances: true,
      punctuate: true,
      diarize: false
    });
    
    const alt = result.results.channels[0].alternatives[0];
    
    console.log(`  Transcribed ${alt.words?.length || 0} words`);
    onProgress?.(40, 'Transcription complete');
    
    return {
      text: alt.transcript || '',
      words: (alt.words || []).map(w => ({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence
      }))
    };
    
  } catch (error) {
    console.warn('  Transcription failed:', error.message);
    return { text: '', words: [] };
  }
}

function checkForSpeech(analysis) {
  const hasConversation = analysis.shots.some(shot => 
    shot.description.toLowerCase().includes('speaking') ||
    shot.description.toLowerCase().includes('talking') ||
    shot.description.toLowerCase().includes('saying')
  );
  
  return hasConversation;
}

module.exports = { transcribeIfNeeded };
