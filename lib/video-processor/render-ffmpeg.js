const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { supabaseAdmin } = require('../../services/supabase-admin');

/**
 * Renders an edited video using FFmpeg.
 * Phase 1: Trim clips from source, concatenate, output MP4.
 */
async function renderVideo(editPlan, videoUrl, jobId, onProgress) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `promptly-${jobId}-`));

  try {
    console.log('🎥 Starting FFmpeg render...');
    onProgress?.(65, 'Preparing source stream...');

    // 1. Trim each clip directly from source URL (streamed by FFmpeg)
    onProgress?.(70, 'Trimming clips...');
    const clipPaths = [];
    for (let i = 0; i < editPlan.cuts.length; i++) {
      const cut = editPlan.cuts[i];
      const clipPath = path.join(tmpDir, `clip_${i}.mp4`);
      const duration = cut.source_end - cut.source_start;

      await runFFmpeg([
        '-y',
        '-ss', String(cut.source_start),
        '-i', videoUrl,
        '-t', String(duration),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        clipPath
      ]);

      clipPaths.push(clipPath);
      console.log(`[ffmpeg] Trimmed clip ${i + 1}/${editPlan.cuts.length}: ${cut.source_start.toFixed(1)}s-${cut.source_end.toFixed(1)}s`);
    }

    // 2. Build concat file list
    onProgress?.(80, 'Concatenating clips...');
    const concatListPath = path.join(tmpDir, 'concat.txt');
    const concatContent = clipPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(concatListPath, concatContent);

    // 3. Concatenate all clips
    const outputPath = path.join(tmpDir, 'output.mp4');
    await runFFmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath
    ]);

    const outputSize = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
    console.log(`[ffmpeg] Output rendered: ${outputSize}MB`);

    // 4. Upload to Supabase storage
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
