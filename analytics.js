console.log('[Analytics] script loaded');

document.addEventListener('DOMContentLoaded', () => {
  console.log('[Analytics] DOMContentLoaded');

  const btnTikTok = document.getElementById('connect-tiktok');
  const btnInstagram = document.getElementById('connect-instagram');
  const btnYouTube = document.getElementById('connect-youtube');

  console.log('[Analytics] buttons:', { btnTikTok, btnInstagram, btnYouTube });
  console.log('[Analytics] PhylloConnect global:', !!window.PhylloConnect);

  async function openPhylloConnect() {
    console.log('[Analytics] openPhylloConnect() called');

    try {
      const res = await fetch('/api/phyllo/sdk-config', { credentials: 'include' });
      console.log('[Analytics] /api/phyllo/sdk-config status:', res.status);

      if (!res.ok) {
        console.error('[Analytics] sdk-config failed');
        return;
      }

      const cfg = await res.json();
      console.log('[Analytics] sdk-config payload:', cfg);

      if (!window.PhylloConnect) {
        console.error('[Analytics] window.PhylloConnect is missing');
        return;
      }

      const connect = window.PhylloConnect.initialize({
        userId: cfg.userId,
        token: cfg.token,
        environment: cfg.environment,
        clientDisplayName: cfg.clientDisplayName,
      });

      console.log('[Analytics] opening Phyllo Connect');
      connect.open();
    } catch (err) {
      console.error('[Analytics] Phyllo Connect error', err);
    }
  }

  [btnTikTok, btnInstagram, btnYouTube].forEach((btn) => {
    if (!btn) return;
    btn.addEventListener('click', openPhylloConnect);
    console.log('[Analytics] attached click handler to', btn.id);
  });
});
