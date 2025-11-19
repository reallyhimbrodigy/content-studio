// Register the service worker to enable PWA features (offline, caching)
// Kept in a separate file to comply with strict CSP (no inline scripts)
(function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    const swUrl = '/sw.js';
    navigator.serviceWorker.register(swUrl, { scope: '/' })
      .then((reg) => {
        // Optional: listen for updates and prompt reload
        if (reg.waiting) {
          console.log('[SW] waiting service worker ready');
        }
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[SW] New content available; will use on next load');
            }
          });
        });
      })
      .catch((err) => console.warn('[SW] registration failed:', err));

    // Reload page when the new SW takes control (optional UX improvement)
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      // Avoid interrupting user actions; a gentle reload is usually fine for an app-shell
      // Comment out if you prefer manual refresh
      // location.reload();
    });
  });
})();
