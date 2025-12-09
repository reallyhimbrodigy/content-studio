document.addEventListener('DOMContentLoaded', () => {
  const btnTikTok = document.getElementById('connect-tiktok');
  const btnInstagram = document.getElementById('connect-instagram');
  const btnYouTube = document.getElementById('connect-youtube');

  let phylloInstance = null;

  async function ensurePhylloInstance() {
    if (phylloInstance) return phylloInstance;

    const res = await fetch('/api/phyllo/sdk-config');
    if (!res.ok) {
      console.error('[Phyllo] sdk-config failed', res.status);
      return null;
    }

    const cfg = await res.json();
    if (!cfg || !cfg.token) {
      console.error('[Phyllo] Missing token in sdk-config response', cfg);
      return null;
    }

    if (!window.PhylloConnect) {
      console.error('[Phyllo] PhylloConnect not available');
      return null;
    }

    phylloInstance = window.PhylloConnect.initialize({
      userId: cfg.userId,
      token: cfg.token,
      environment: cfg.environment,
      clientDisplayName: cfg.clientDisplayName,
      callbacks: {
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
      },
    });

    return phylloInstance;
  }

  async function openPhyllo() {
    try {
      const instance = await ensurePhylloInstance();
      if (!instance) return;
      instance.open();
    } catch (err) {
      console.error('[Phyllo] connect error', err);
    }
  }

  if (btnTikTok) btnTikTok.addEventListener('click', openPhyllo);
  if (btnInstagram) btnInstagram.addEventListener('click', openPhyllo);
  if (btnYouTube) btnYouTube.addEventListener('click', openPhyllo);
});
