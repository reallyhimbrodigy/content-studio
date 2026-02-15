import ffmpeg from 'fluent-ffmpeg';

/**
 * Extracts mono 16kHz WAV audio from a video file.
 * @param {string} videoPath - Local video file path.
 * @returns {Promise<string>} Local audio file path.
 */
export async function extractAudio(videoPath) {
  if (!videoPath || typeof videoPath !== 'string') {
    throw new Error('extractAudio: videoPath must be a non-empty string');
  }

  const audioPath = videoPath.replace(/\.mp4$/i, '.wav');

  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .audioCodec('pcm_s16le')
      .audioChannels(1)
      .audioFrequency(16000)
      .format('wav')
      .on('start', (commandLine) => {
        console.log(`FFmpeg started: ${commandLine}`);
      })
      .on('end', () => {
        console.log(`Audio extracted to: ${audioPath}`);
        resolve(audioPath);
      })
      .on('error', (error, stdout, stderr) => {
        reject(
          new Error(
            `Failed to extract audio from "${videoPath}". ${error?.message || 'Unknown ffmpeg error'}\nstdout: ${
              stdout || ''
            }\nstderr: ${stderr || ''}`
          )
        );
      })
      .save(audioPath);
  });
}

/**
 * Reads video metadata from a local file using ffprobe.
 * @param {string} videoPath - Local video file path.
 * @returns {Promise<{duration:number,width:number,height:number,fps:number,hasAudio:boolean,fileSize:number}>}
 */
export async function getVideoMetadata(videoPath) {
  if (!videoPath || typeof videoPath !== 'string') {
    throw new Error('getVideoMetadata: videoPath must be a non-empty string');
  }

  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (error, metadata) => {
      if (error) {
        reject(
          new Error(
            `Failed to read metadata for "${videoPath}": ${error?.message || 'Unknown ffprobe error'}`
          )
        );
        return;
      }

      try {
        const videoStream = metadata?.streams?.find((s) => s.codec_type === 'video');
        const audioStream = metadata?.streams?.find((s) => s.codec_type === 'audio');

        if (!videoStream) {
          throw new Error('No video stream found in metadata');
        }

        const duration = parseFloat(metadata?.format?.duration ?? '0');
        const width = videoStream.width ?? 0;
        const height = videoStream.height ?? 0;
        const fps = videoStream.r_frame_rate ? eval(videoStream.r_frame_rate) : 0;
        const hasAudio = Boolean(audioStream);
        const fileSize = parseInt(metadata?.format?.size ?? '0', 10);

        resolve({
          duration,
          width,
          height,
          fps,
          hasAudio,
          fileSize,
        });
      } catch (parseError) {
        reject(
          new Error(
            `Failed to parse metadata for "${videoPath}": ${parseError?.message || 'Unknown parse error'}`
          )
        );
      }
    });
  });
}
