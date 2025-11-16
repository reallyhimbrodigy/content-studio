const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

(async function main(){
  try {
    const root = path.resolve(__dirname, '..');
    const outDir = path.join(root, 'assets', 'png');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const tasks = [
      {
        src: path.join(root, 'assets', 'promptly-logo.svg'),
        outputs: [
          { w: 1024, h: 176, name: 'promptly-wordmark-1024x176.png' },
          { w: 512, h: 88, name: 'promptly-wordmark-512x88.png' }
        ]
      },
      {
        src: path.join(root, 'assets', 'promptly-icon.svg'),
        outputs: [
          { w: 512, h: 512, name: 'promptly-icon-512.png' },
          { w: 256, h: 256, name: 'promptly-icon-256.png' },
          { w: 128, h: 128, name: 'promptly-icon-128.png' }
        ]
      }
    ];

    for (const t of tasks) {
      if (!fs.existsSync(t.src)) {
        console.warn('Source not found, skipping:', t.src);
        continue;
      }
      const svg = fs.readFileSync(t.src);
      for (const out of t.outputs) {
        const outPath = path.join(outDir, out.name);
        console.log(`Rendering ${path.basename(t.src)} → ${out.name} (${out.w}x${out.h})`);
        // Use a higher density to get cleaner rasterization for large sizes
        await sharp(svg, { density: 300 })
          .resize(out.w, out.h, { fit: 'contain' })
          .png({ quality: 100 })
          .toFile(outPath);
      }
    }

    console.log('\nAll done. PNGs written to:', outDir);
  } catch (err) {
    console.error('Export failed:', err);
    process.exitCode = 1;
  }
})();
