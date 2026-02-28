const fs = require('fs');
const path = require('path');
const axios = require('axios');

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PEXELS_BASE = 'https://api.pexels.com/videos/search';

async function fetchBrollClip(keyword) {
  if (!PEXELS_API_KEY) {
    console.log('[broll] PEXELS_API_KEY not set, skipping b-roll');
    return null;
  }

  try {
    const url = `${PEXELS_BASE}?query=${encodeURIComponent(keyword)}&per_page=1&size=small&orientation=portrait`;
    const { data, status } = await axios.get(url, {
      headers: { Authorization: PEXELS_API_KEY },
      timeout: 12000,
      validateStatus: () => true,
    });

    if (status < 200 || status >= 300) {
      console.log(`[broll] Pexels API error (${status}) for "${keyword}"`);
      return null;
    }

    const video = data?.videos?.[0];
    if (!video) {
      console.log(`[broll] No results for "${keyword}"`);
      return null;
    }

    const file = (video.video_files || [])
      .filter((f) => f?.width >= 720)
      .sort((a, b) => a.width - b.width)[0];

    if (!file?.link) {
      console.log(`[broll] No suitable file for "${keyword}"`);
      return null;
    }

    return {
      keyword,
      url: file.link,
      width: file.width,
      height: file.height,
      duration: Number(video.duration || 0),
    };
  } catch (err) {
    console.log(`[broll] Fetch error for "${keyword}": ${err.message}`);
    return null;
  }
}

async function downloadBrollClip(clipInfo, outputPath) {
  const resp = await axios.get(clipInfo.url, {
    responseType: 'arraybuffer',
    timeout: 25000,
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(resp.data));
  const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`[broll] Downloaded "${clipInfo.keyword}": ${sizeMB}MB`);
  return outputPath;
}

module.exports = { fetchBrollClip, downloadBrollClip };

