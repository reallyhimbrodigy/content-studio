import { downloadVideo, cleanupFile } from './download.js';
import { extractAudio, getVideoMetadata } from './extract-audio.js';
import { transcribeAudio } from './transcribe.js';

/**
 * Simple beat detection for MVP. TODO: Replace with proper beat detection library
 * @param {number} duration - Clip duration in seconds.
 * @returns {number[]} Beat timestamps.
 */
function detectSimpleBeats(duration) {
  const beats = [];
  const beatInterval = 0.5;

  for (let t = 0; t <= duration; t += beatInterval) {
    beats.push(parseFloat(t.toFixed(2)));
  }

  return beats;
}

/**
 * Returns high-confidence words as emphasis moments.
 * @param {Array<{word:string,start:number,end:number,confidence:number}>} words - Word timings.
 * @returns {Array<{timestamp:number,word:string,confidence:number}>}
 */
function identifyEmphasis(words) {
  return (words || [])
    .filter((w) => w.confidence > 0.9)
    .map((w) => ({
      timestamp: w.start,
      word: w.word,
      confidence: w.confidence,
    }));
}

/**
 * Runs the full analysis pipeline for a clip URL.
 * @param {string} videoUrl - Public URL of the source clip.
 * @returns {Promise<{duration:number,dimensions:{width:number,height:number},fps:number,audio:{transcript:Array,words:Array,fullText:string,beats:number[],emphasisMoments:Array},visual:{hasAudio:boolean}}>}
 */
export async function analyzeClip(videoUrl) {
  let videoPath = null;
  let audioPath = null;

  try {
    console.log('Starting clip analysis...');

    videoPath = await downloadVideo(videoUrl);
    const metadata = await getVideoMetadata(videoPath);
    console.log('Video metadata:', metadata);

    audioPath = await extractAudio(videoPath);
    const transcript = await transcribeAudio(audioPath);

    const beats = detectSimpleBeats(metadata.duration);
    const emphasisMoments = identifyEmphasis(transcript.words);

    const analysis = {
      duration: metadata.duration,
      dimensions: {
        width: metadata.width,
        height: metadata.height,
      },
      fps: metadata.fps,
      audio: {
        transcript: transcript.utterances,
        words: transcript.words,
        fullText: transcript.fullText,
        beats: beats,
        emphasisMoments: emphasisMoments,
      },
      visual: {
        hasAudio: metadata.hasAudio,
      },
    };

    console.log('Clip analysis complete');
    return analysis;
  } catch (error) {
    console.error('Clip analysis failed:', error);
    throw error;
  } finally {
    if (videoPath) {
      await cleanupFile(videoPath);
    }
    if (audioPath) {
      await cleanupFile(audioPath);
    }
  }
}
