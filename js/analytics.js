document.addEventListener('DOMContentLoaded', () => {
  const btnTikTok = document.getElementById('connect-tiktok');
  const btnInstagram = document.getElementById('connect-instagram');
  const btnYouTube = document.getElementById('connect-youtube');

  async function openPhyllo(platform) {
    try {
      const res = await fetch('/api/phyllo/sdk-config');
      if (!res.ok) {
        console.error('[Phyllo] sdk-config failed', res.status);
        return;
      }

      const cfg = await res.json();
      if (!cfg || !cfg.token) {
        console.error('[Phyllo] Missing token in sdk-config response', cfg);
        return;
      }

      if (!window.PhylloConnect) {
        console.error('[Phyllo] PhylloConnect not available');
        return;
      }

      window.PhylloConnect.open({
        userId: cfg.userId,
        token: cfg.token,
        environment: cfg.environment,
        clientDisplayName: cfg.clientDisplayName,

        accountConnected: function (account) {
          console.log('[Phyllo] accountConnected', account);
        },
        accountDisconnected: function (account) {
          console.log('[Phyllo] accountDisconnected', account);
        },
        tokenExpired: function () {
          console.log('[Phyllo] tokenExpired');
        },
        exit: function () {
          console.log('[Phyllo] exit');
        },

        platform: platform || null,
      });
    } catch (err) {
      console.error('[Phyllo] connect error', err);
    }
  }

  if (btnTikTok) btnTikTok.addEventListener('click', () => openPhyllo('tiktok'));
  if (btnInstagram) btnInstagram.addEventListener('click', () => openPhyllo('instagram'));
  if (btnYouTube) btnYouTube.addEventListener('click', () => openPhyllo('youtube'));
});
