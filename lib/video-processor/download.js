import path from 'path';
import { mkdir, unlink } from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import axios from 'axios';

/**
 * Downloads a video from a URL to the project tmp directory.
 * @param {string} videoUrl - Public video URL to download.
 * @returns {Promise<string>} Absolute local path to the downloaded video file.
 */
export async function downloadVideo(videoUrl) {
  if (!videoUrl || typeof videoUrl !== 'string') {
    throw new Error('downloadVideo: videoUrl must be a non-empty string');
  }

  const tmpDir = path.join(process.cwd(), 'tmp');
  await mkdir(tmpDir, { recursive: true });

  const fileName = `video-${Date.now()}.mp4`;
  const outputPath = path.join(tmpDir, fileName);

  try {
    const response = await axios.get(videoUrl, { responseType: 'stream' });
    await pipeline(response.data, createWriteStream(outputPath));
    console.log(`Video downloaded to: ${outputPath}`);
    return outputPath;
  } catch (error) {
    const message = error?.message || 'Unknown download error';
    throw new Error(`Failed to download video from URL "${videoUrl}": ${message}`);
  }
}

/**
 * Deletes a file path during cleanup without throwing.
 * @param {string} filePath - Absolute or relative file path to delete.
 * @returns {Promise<void>}
 */
export async function cleanupFile(filePath) {
  if (!filePath) return;

  try {
    await unlink(filePath);
    console.log(`Cleaned up: ${filePath}`);
  } catch (error) {
    console.error(`Cleanup warning for ${filePath}:`, error);
  }
}
