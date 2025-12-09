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
      clientDisplayName: cfg.clientDisplayName,
      environment: cfg.environment,
      userId: cfg.userId,
      token: cfg.token,
      // no callbacks here
    });

    instance.on('accountConnected', function (accountId, workPlatformId, userId) {
      console.log('[Phyllo] accountConnected', { accountId, workPlatformId, userId });
    });

    instance.on('accountDisconnected', function (accountId, workPlatformId, userId) {
      console.log('[Phyllo] accountDisconnected', { accountId, workPlatformId, userId });
    });

    instance.on('tokenExpired', function (userId) {
      console.log('[Phyllo] tokenExpired for user', userId);
      // later: refresh token via /api/phyllo/sdk-config
    });

    instance.on('exit', function (reason, userId) {
      console.log('[Phyllo] exit', { reason, userId });
    });

    instance.on('connectionFailure', function (reason, workPlatformId, userId) {
      console.log('[Phyllo] connectionFailure', { reason, workPlatformId, userId });
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
