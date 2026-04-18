/**
 * Mobile bottom tab navigation — injected on all app pages.
 * Three tabs: Editor (chat), Library, Account
 */
(function initMobileNav() {
  if (window.matchMedia('(min-width: 769px)').matches) return;

  const currentPath = window.location.pathname;

  const isActive = (paths) =>
    paths.some((p) => currentPath === p || currentPath.startsWith(p + '/'));

  const tabs = [
    {
      label: 'Edit',
      href: '/editor',
      active: isActive(['/editor', '/editor.html']),
      icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
    },
    {
      label: 'Library',
      href: '/library.html',
      active: isActive(['/library', '/library.html']),
      icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    },
    {
      label: 'Account',
      href: '/account.html',
      active: isActive(['/account', '/account.html']),
      icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    },
  ];

  const nav = document.createElement('nav');
  nav.className = 'mobile-tab-bar';
  nav.setAttribute('aria-label', 'Main navigation');

  nav.innerHTML = tabs
    .map(
      (t) => `<a href="${t.href}" class="${t.active ? 'active' : ''}" aria-current="${t.active ? 'page' : 'false'}">${t.icon}<span class="tab-label">${t.label}</span></a>`
    )
    .join('');

  document.body.appendChild(nav);
})();
