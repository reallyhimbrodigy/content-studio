const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { supabaseAdmin } = require('../../services/supabase-admin');

/**
 * Renders an edited video using FFmpeg.
 * Phase 1: Trim clips from source, concatenate, output MP4.
 */
async function renderVideo(editPlan, videoUrl, jobId, onProgress) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `promptly-${jobId}-`));

  try {
    console.log('🎥 Starting FFmpeg render...');
    onProgress?.(65, 'Downloading source video...');

    // 1. Download source video
    const sourcePath = path.join(tmpDir, 'source.mp4');
    await downloadFile(videoUrl, sourcePath);
    console.log(`[ffmpeg] Downloaded source: ${(fs.statSync(sourcePath).size / 1024 / 1024).toFixed(1)}MB`);

    // 2. Trim each clip
    onProgress?.(70, 'Trimming clips...');
    const clipPaths = [];
    for (let i = 0; i < editPlan.cuts.length; i++) {
      const cut = editPlan.cuts[i];
      const clipPath = path.join(tmpDir, `clip_${i}.mp4`);
      const duration = cut.source_end - cut.source_start;

      await runFFmpeg([
        '-y',
        '-ss', String(cut.source_start),
        '-i', sourcePath,
        '-t', String(duration),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-r', '30',
        '-movflags', '+faststart',
        clipPath
      ]);

      clipPaths.push(clipPath);
      console.log(`[ffmpeg] Trimmed clip ${i + 1}/${editPlan.cuts.length}: ${cut.source_start.toFixed(1)}s-${cut.source_end.toFixed(1)}s`);
    }

    // 3. Build concat file list
    onProgress?.(80, 'Concatenating clips...');
    const concatListPath = path.join(tmpDir, 'concat.txt');
    const concatContent = clipPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(concatListPath, concatContent);

    // 4. Concatenate all clips
    const outputPath = path.join(tmpDir, 'output.mp4');
    await runFFmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      outputPath
    ]);

    const outputSize = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
    console.log(`[ffmpeg] Output rendered: ${outputSize}MB`);

    // 5. Upload to Supabase storage
    onProgress?.(90, 'Uploading...');
    const publicUrl = await uploadToSupabase(outputPath, jobId);
    console.log(`[ffmpeg] Uploaded: ${publicUrl}`);

    onProgress?.(95, 'Done!');
    return publicUrl;

  } finally {
    // Cleanup temp files
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      console.log('[ffmpeg] Cleaned up temp files');
    } catch (e) {
      console.warn('[ffmpeg] Cleanup warning:', e.message);
    }
  }
}

function downloadFile(url, dest) {
  return new Promise(async (resolve, reject) => {
    try {
      const response = await axios({ method: 'GET', url, responseType: 'stream' });
      const writer = fs.createWriteStream(dest);
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`[ffmpeg] Running: ffmpeg ${args.join(' ').slice(0, 200)}...`);
    const proc = execFile('ffmpeg', args, {
      maxBuffer: 50 * 1024 * 1024, // 50MB stderr buffer
      timeout: 300_000, // 5 min max
    }, (error, stdout, stderr) => {
      if (error) {
        console.error('[ffmpeg] stderr:', stderr?.slice(-500));
        reject(new Error(`FFmpeg failed: ${error.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function uploadToSupabase(filePath, jobId) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = `rendered/${jobId}-${Date.now()}.mp4`;

  const { error } = await supabaseAdmin.storage
    .from('videos')
    .upload(fileName, fileBuffer, {
      contentType: 'video/mp4',
      upsert: true
    });

  if (error) {
    throw new Error(`Supabase upload failed: ${error.message}`);
  }

  const { data } = supabaseAdmin.storage
    .from('videos')
    .getPublicUrl(fileName);

  return data.publicUrl;
}

module.exports = { renderVideo };
