const { readFile } = require('fs/promises');
const { createClient } = require('@deepgram/sdk');

/**
 * Transcribes an extracted WAV file with Deepgram and returns structured output.
 * @param {string} audioPath - Local WAV file path.
 * @returns {Promise<{words:Array<{word:string,start:number,end:number,confidence:number}>,utterances:Array<{text:string,start:number,end:number,confidence:number,words:Array<{word:string,start:number,end:number,confidence:number}>}>,fullText:string}>}
 */
async function transcribeAudio(audioPath) {
  if (!audioPath || typeof audioPath !== 'string') {
    throw new Error('transcribeAudio: audioPath must be a non-empty string');
  }

  if (!process.env.DEEPGRAM_API_KEY) {
    throw new Error('Missing DEEPGRAM_API_KEY');
  }

  try {
    const audioBuffer = await readFile(audioPath);
    const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

    const response = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
      model: 'nova-2',
      smart_format: true,
      punctuate: true,
      utterances: true,
      diarize: false,
    });

    const result = response?.result || response?.results ? response : response?.result;
    const root = result?.result?.results ? result.result : result;
    const dgResults = root?.results;

    const alternative = dgResults?.channels?.[0]?.alternatives?.[0];
    if (!alternative) {
      console.log('Transcription complete with no recognized speech.');
      return { words: [], utterances: [], fullText: '' };
    }

    const words = (alternative.words || []).map((w) => ({
      word: w.word,
      start: w.start,
      end: w.end,
      confidence: w.confidence,
    }));

    const utterances = (dgResults?.utterances || []).map((u) => ({
      text: u.transcript,
      start: u.start,
      end: u.end,
      confidence: u.confidence,
      words: words.filter((w) => w.start >= u.start && w.end <= u.end),
    }));

    const fullText = alternative.transcript || '';

    console.log(`Transcribed ${words.length} words in ${utterances.length} utterances`);
    return { words, utterances, fullText };
  } catch (error) {
    const message = error?.message || 'Unknown transcription error';
    throw new Error(`Failed to transcribe audio "${audioPath}": ${message}`);
  }
}

module.exports = {
  transcribeAudio,
};
