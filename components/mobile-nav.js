/**
 * Mobile bottom tab navigation — toggles between views on the same page.
 * No page navigation. All views live in editor.html.
 */
(function initMobileNav() {
  if (window.matchMedia('(min-width: 769px)').matches) return;

  const tabs = [
    {
      id: 'tab-edit',
      label: 'Edit',
      view: 'mobile-chat',
      icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
    },
    {
      id: 'tab-library',
      label: 'Library',
      view: 'mobile-library-view',
      icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    },
    {
      id: 'tab-account',
      label: 'Account',
      view: 'mobile-account-view',
      icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    },
  ];

  const nav = document.createElement('nav');
  nav.className = 'mobile-tab-bar';
  nav.setAttribute('aria-label', 'Main navigation');

  nav.innerHTML = tabs
    .map((t, i) => `<button id="${t.id}" class="mobile-tab${i === 0 ? ' active' : ''}" data-view="${t.view}" aria-label="${t.label}">${t.icon}<span class="tab-label">${t.label}</span></button>`)
    .join('');

  document.body.appendChild(nav);

  // Track which views have been loaded
  const loaded = { 'mobile-chat': true };

  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.mobile-tab');
    if (!btn) return;

    const viewId = btn.dataset.view;

    // Haptic feedback on tab switch
    try { window.Capacitor?.Plugins?.Haptics?.selectionChanged(); } catch (_) {}

    // Update active tab
    nav.querySelectorAll('.mobile-tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');

    // Toggle views
    tabs.forEach((t) => {
      const el = document.getElementById(t.view);
      if (!el) return;
      if (t.view === viewId) {
        if (t.view === 'mobile-chat') {
          el.style.display = 'flex';
        } else {
          el.style.display = 'flex';
          el.classList.add('active');
        }
      } else {
        if (t.view === 'mobile-chat') {
          el.style.display = 'none';
        } else {
          el.style.display = 'none';
          el.classList.remove('active');
        }
      }
    });

    // Load content on first tap
    if (viewId === 'mobile-library-view' && !loaded[viewId]) {
      loaded[viewId] = true;
      if (typeof window.loadMobileLibrary === 'function') window.loadMobileLibrary();
    }
    if (viewId === 'mobile-account-view' && !loaded[viewId]) {
      loaded[viewId] = true;
      if (typeof window.loadMobileAccount === 'function') window.loadMobileAccount();
    }
  });
})();
