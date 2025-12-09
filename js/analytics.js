document.addEventListener('DOMContentLoaded', () => {
  const btnTikTok = document.getElementById('connect-tiktok');
  const btnInstagram = document.getElementById('connect-instagram');
  const btnYouTube = document.getElementById('connect-youtube');

  let phylloConnectInstance = null;

  async function getPhylloInstance() {
    if (phylloConnectInstance) return phylloConnectInstance;

    const res = await fetch('/api/phyllo/sdk-config');
    if (!res.ok) {
      console.error('[Phyllo] sdk-config failed', res.status);
      return null;
    }

    const cfg = await res.json();
    if (!window.PhylloConnect) {
      console.error('[Phyllo] PhylloConnect not available');
      return null;
    }

    const instance = window.PhylloConnect.initialize({
      userId: cfg.userId,
      token: cfg.token,
      environment: cfg.environment,
      clientDisplayName: cfg.clientDisplayName,
    });

    instance.on('accountConnected', (accountId, workPlatformId, userId) => {
      console.log('[Phyllo] accountConnected', { accountId, workPlatformId, userId });
    });

    instance.on('accountDisconnected', (accountId, workPlatformId, userId) => {
      console.log('[Phyllo] accountDisconnected', { accountId, workPlatformId, userId });
    });

    instance.on('tokenExpired', () => {
      console.log('[Phyllo] tokenExpired');
    });

    instance.on('exit', () => {
      console.log('[Phyllo] exit');
    });

    phylloConnectInstance = instance;
    return instance;
  }

  async function openPhyllo() {
    try {
      const instance = await getPhylloInstance();
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
