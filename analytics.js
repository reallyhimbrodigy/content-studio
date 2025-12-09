document.addEventListener('DOMContentLoaded', () => {
  const tiktokBtn = document.getElementById('connect-tiktok');
  const instagramBtn = document.getElementById('connect-instagram');
  const youtubeBtn = document.getElementById('connect-youtube');

  if (tiktokBtn) {
    tiktokBtn.addEventListener('click', () => console.log('[Analytics] Connect TikTok clicked'));
  }
  if (instagramBtn) {
    instagramBtn.addEventListener('click', () => console.log('[Analytics] Connect Instagram clicked'));
  }
  if (youtubeBtn) {
    youtubeBtn.addEventListener('click', () => console.log('[Analytics] Connect YouTube clicked'));
  }
});
