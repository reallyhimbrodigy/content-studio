const { createClient } = require('@deepgram/sdk');
const fs = require('fs');

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

async function transcribeIfNeeded(audioPath, analysis, onProgress) {
  // If analysis is available, check for speech. Otherwise, always transcribe.
  if (analysis) {
    const hasSpeech = checkForSpeech(analysis);
    if (!hasSpeech) {
      console.log('  No speech detected, skipping transcription');
      return { text: '', words: [] };
    }
  }

  console.log('📝 Transcribing speech...');
  onProgress?.(32, 'Transcribing speech...');

  try {
    if (!audioPath || !fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found for transcription: ${audioPath}`);
    }

    const audioBuffer = fs.readFileSync(audioPath);
    const { result } = await deepgram.listen.prerecorded.transcribeFile(
      audioBuffer,
      {
        model: 'nova-3',
        detect_language: true,
        words: true,
        smart_format: true,
        utterances: true,
        punctuate: true,
        diarize: false,
        mimetype: 'audio/wav',
      }
    );

    const detectedLang = result?.results?.channels?.[0]?.detected_language;
    if (detectedLang) {
      console.log(`[deepgram] Detected language: ${detectedLang}`);
    }

    const alt = result.results.channels[0].alternatives[0];
    console.log(`  Transcribed ${alt.words?.length || 0} words`);
    onProgress?.(40, 'Transcription complete');

    return {
      text: alt.transcript || '',
      words: (alt.words || []).map((w) => ({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence,
      })),
    };
  } catch (error) {
    console.warn('  Transcription failed:', error.message);
    return { text: '', words: [] };
  }
}

function checkForSpeech(analysis) {
  // Primary: check Gemini's explicit speech detection
  if (analysis.speech?.has_speech === true) return true;
  if (analysis.speech?.segments?.length > 0) return true;

  // Fallback: check shot descriptions for speech-related keywords
  const speechKeywords = ['speaking', 'talking', 'saying', 'narrat', 'interview', 'address', 'explain', 'discuss', 'convers', 'voice', 'speech', 'dialogue', 'monologue', 'presenter', 'host'];
  const hasConversation = analysis.shots.some((shot) => {
    const desc = shot.description.toLowerCase();
    return speechKeywords.some((kw) => desc.includes(kw));
  });

  // Also check video_profile content_type
  const speechTypes = ['talking_head', 'vlog', 'tutorial', 'interview', 'product_demo'];
  const contentType = analysis.video_profile?.content_type?.toLowerCase() || '';
  if (speechTypes.includes(contentType)) return true;

  return hasConversation;
}

module.exports = { transcribeIfNeeded };
