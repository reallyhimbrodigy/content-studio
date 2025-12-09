document.addEventListener('DOMContentLoaded', () => {
  const buttons = [
    document.getElementById('connect-tiktok'),
    document.getElementById('connect-instagram'),
    document.getElementById('connect-youtube'),
  ];

  async function openPhyllo() {
    try {
      const res = await fetch('/api/phyllo/sdk-config', { credentials: 'include' });
      if (!res.ok) {
        console.error('sdk-config failed', res.status);
        return;
      }
      const cfg = await res.json();
      if (!cfg || !cfg.token) {
        console.error('[Phyllo] Missing token in sdk-config response', cfg);
        return;
      }
    if (!window.PhylloConnect) {
      console.error('PhylloConnect global missing');
      return;
    }
    const connect = window.PhylloConnect.initialize({
      userId: cfg.userId,
      token: cfg.token,
      environment: cfg.environment,
      clientDisplayName: cfg.clientDisplayName,
      accountConnected: (account) => {
        console.log('[Phyllo] accountConnected', account);
      },
      accountDisconnected: (account) => {
        console.log('[Phyllo] accountDisconnected', account);
      },
      exit: () => {
        console.log('[Phyllo] connect widget closed');
      },
    });
    connect.open();
  } catch (err) {
    console.error('[Phyllo] connect error', err);
  }
  }

  buttons.forEach((btn) => {
    if (btn) btn.addEventListener('click', openPhyllo);
  });
});
