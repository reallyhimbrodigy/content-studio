(function(){
  // Show a small install prompt when PWA is installable
  const LS_KEY_DISMISSED = 'pwa_install_dismissed_v1';
  let deferredPrompt = null;

  function isStandalone(){
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function createBanner(){
    if (document.getElementById('pwa-install-banner')) return null;
    const wrap = document.createElement('div');
    wrap.id = 'pwa-install-banner';
    wrap.style.position = 'fixed';
    wrap.style.right = '16px';
    wrap.style.bottom = '16px';
    wrap.style.zIndex = '9999';
    wrap.style.maxWidth = '360px';
    wrap.style.borderRadius = '12px';
    wrap.style.border = '1px solid rgba(255,255,255,0.12)';
    wrap.style.background = 'rgba(28,28,34,0.92)';
    wrap.style.backdropFilter = 'blur(10px)';
    wrap.style.boxShadow = '0 12px 28px rgba(0,0,0,0.35)';
    wrap.style.padding = '12px';
    wrap.style.color = 'rgba(245,246,248,0.95)';
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '10px';

    const text = document.createElement('div');
    text.style.flex = '1';
    text.style.fontSize = '0.95rem';
    text.style.lineHeight = '1.3';
    text.innerHTML = '<strong>Install Promptly</strong><br/>Add it to your home screen for a faster, app-like experience.';

    const installBtn = document.createElement('button');
    installBtn.textContent = 'Install';
    installBtn.style.border = 'none';
    installBtn.style.cursor = 'pointer';
    installBtn.style.borderRadius = '999px';
    installBtn.style.fontWeight = '700';
    installBtn.style.padding = '0.5rem 1rem';
    installBtn.style.fontSize = '0.9rem';
    installBtn.style.background = 'linear-gradient(135deg, #7f5af0, #2cb1bc)';
    installBtn.style.color = '#06060a';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Dismiss install prompt');
    closeBtn.style.width = '28px';
    closeBtn.style.height = '28px';
    closeBtn.style.borderRadius = '50%';
    closeBtn.style.fontSize = '1rem';
    closeBtn.style.display = 'flex';
    closeBtn.style.alignItems = 'center';
    closeBtn.style.justifyContent = 'center';
    // grid-based centering caused the × to sit slightly off-center due to font metrics; flex keeps it perfectly centered.
    closeBtn.style.border = '1px solid rgba(255,255,255,0.15)';
    closeBtn.style.background = 'rgba(255,255,255,0.05)';
    closeBtn.style.color = 'inherit';
    closeBtn.style.cursor = 'pointer';

    installBtn.addEventListener('click', async () => {
      try {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        deferredPrompt = null;
        hideBanner();
        localStorage.setItem(LS_KEY_DISMISSED, '1');
      } catch (_) { hideBanner(); }
    });

    closeBtn.addEventListener('click', () => {
      hideBanner();
      localStorage.setItem(LS_KEY_DISMISSED, '1');
    });

    wrap.appendChild(text);
    wrap.appendChild(installBtn);
    wrap.appendChild(closeBtn);
    document.body.appendChild(wrap);
    return wrap;
  }

  function hideBanner(){
    const el = document.getElementById('pwa-install-banner');
    if (el) el.remove();
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    // Do not show if installed or user dismissed
    if (isStandalone() || localStorage.getItem(LS_KEY_DISMISSED) === '1') return;
    e.preventDefault();
    deferredPrompt = e;
    createBanner();
  });

  window.addEventListener('appinstalled', () => {
    localStorage.setItem(LS_KEY_DISMISSED, '1');
    hideBanner();
  });
})();
