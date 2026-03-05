import { signOut } from '/user-store.js';

const SIDEBAR_ROOT_ID = 'promptly-sidebar-root';
const MOBILE_BREAKPOINT = 768;

function currentPageKey() {
  const path = (window.location.pathname || '').toLowerCase();
  if (path.includes('/library')) return 'library';
  return 'editor';
}

function removeLegacySidebar() {
  const legacySelectors = [
    '#sidebar-toggle',
    '#app-sidebar',
    '#sidebar-backdrop',
    '.sidebar-toggle',
    '.app-sidebar',
    '.sidebar-backdrop',
  ];
  legacySelectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((el) => {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
  });
}

function closeMobileOverlay(root) {
  const overlay = root.querySelector('.sidebar-overlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  document.body.classList.remove('sidebar-mobile-open');
}

function openMobileOverlay(root) {
  const overlay = root.querySelector('.sidebar-overlay');
  if (!overlay) return;
  overlay.classList.add('open');
  document.body.classList.add('sidebar-mobile-open');
}

function buildSidebarHtml() {
  return `
    <div class="sidebar-root" id="${SIDEBAR_ROOT_ID}">
      <div class="sidebar-mobile-bar">
        <button class="sidebar-icon-btn" type="button" aria-label="Open menu" data-sidebar-open>
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
        </button>
      </div>

      <aside class="sidebar" aria-label="Sidebar navigation">
        <div class="sidebar-logo-wrap">
          <a class="sidebar-logo" href="/editor" aria-label="Promptly">
            <img src="/assets/promptly-mark-white.png" alt="" class="sidebar-logo-mark" aria-hidden="true" />
            <span class="sidebar-logo-text">Promptly</span>
          </a>
        </div>

        <nav class="sidebar-links" aria-label="Primary">
          <a class="sidebar-link" href="/editor" data-link="editor">
            <span class="sidebar-link-icon" aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8H4z"/><path d="m4 11-.88-2.87a2 2 0 0 1 1.33-2.5l11.48-3.5a2 2 0 0 1 2.5 1.32l.87 2.87L4 11z"/><path d="m6.6 4.99 3.38 4.2"/><path d="m11.86 3.38 3.38 4.2"/></svg>
            </span>
            <span class="sidebar-link-label">Editor</span>
          </a>
          <a class="sidebar-link" href="/library.html" data-link="library">
            <span class="sidebar-link-icon" aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>
            </span>
            <span class="sidebar-link-label">Library</span>
          </a>
        </nav>
      </aside>

      <div class="sidebar-overlay" aria-hidden="true">
        <div class="sidebar-overlay-backdrop" data-sidebar-close></div>
        <aside class="sidebar-overlay-panel" aria-label="Mobile sidebar navigation">
          <div class="sidebar-overlay-head">
            <a class="sidebar-logo is-open" href="/editor" aria-label="Promptly">
              <img src="/assets/promptly-mark-white.png" alt="" class="sidebar-logo-mark" aria-hidden="true" />
              <span class="sidebar-logo-text">Promptly</span>
            </a>
            <button class="sidebar-icon-btn" type="button" aria-label="Close menu" data-sidebar-close>
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
          <nav class="sidebar-links sidebar-links-mobile" aria-label="Mobile primary">
            <a class="sidebar-link" href="/editor" data-link="editor" data-mobile-link>
              <span class="sidebar-link-icon" aria-hidden="true">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8H4z"/><path d="m4 11-.88-2.87a2 2 0 0 1 1.33-2.5l11.48-3.5a2 2 0 0 1 2.5 1.32l.87 2.87L4 11z"/><path d="m6.6 4.99 3.38 4.2"/><path d="m11.86 3.38 3.38 4.2"/></svg>
              </span>
              <span class="sidebar-link-label">Editor</span>
            </a>
            <a class="sidebar-link" href="/library.html" data-link="library" data-mobile-link>
              <span class="sidebar-link-icon" aria-hidden="true">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>
              </span>
              <span class="sidebar-link-label">Library</span>
            </a>
          </nav>
        </aside>
      </div>
    </div>
  `;
}

export function initSidebar() {
  if (document.getElementById(SIDEBAR_ROOT_ID)) return;

  removeLegacySidebar();
  document.body.classList.add('has-sidebar');

  const mount = document.createElement('div');
  mount.innerHTML = buildSidebarHtml();
  const root = mount.firstElementChild;
  if (!root) return;
  document.body.prepend(root);

  const desktopSidebar = root.querySelector('.sidebar');
  if (desktopSidebar) {
    desktopSidebar.addEventListener('mouseenter', () => {
      if (window.innerWidth >= MOBILE_BREAKPOINT) {
        desktopSidebar.classList.add('expanded');
      }
    });
    desktopSidebar.addEventListener('mouseleave', () => {
      desktopSidebar.classList.remove('expanded');
    });
  }

  root.querySelectorAll('[data-sidebar-open]').forEach((btn) => {
    btn.addEventListener('click', () => openMobileOverlay(root));
  });
  root.querySelectorAll('[data-sidebar-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeMobileOverlay(root));
  });

  const activeKey = currentPageKey();
  root.querySelectorAll('[data-link]').forEach((link) => {
    if (link.getAttribute('data-link') === activeKey) {
      link.classList.add('is-active');
      link.setAttribute('aria-current', 'page');
    }
  });

  root.querySelectorAll('[data-mobile-link]').forEach((link) => {
    link.addEventListener('click', () => closeMobileOverlay(root));
  });

  root.querySelectorAll('[data-logout]').forEach((logoutLink) => {
    logoutLink.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        await signOut();
      } catch (err) {
        console.error('[sidebar] signOut failed:', err);
      }
      window.location.replace('/auth.html');
    });
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth >= MOBILE_BREAKPOINT) {
      closeMobileOverlay(root);
    }
  });
}
