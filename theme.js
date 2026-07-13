// Shared theme utilities for cross-page persistence
//
// Restored 2026-07-13: this module was deleted in b8888e8 ("Remove web
// editor/library — mobile-only app"), which orphaned the ES-module imports in
// auth.js + reset-password.js (they 404'd, so those scripts never executed — the
// web sign-in / reset-password forms were dead). Self-contained (browser APIs +
// localStorage only), so restored verbatim.

/**
 * Initialize theme on page load - reads from localStorage and applies to :root
 * Call this at the top of every page's JS entry point
 */
export function initTheme() {
  applyFaviconForScheme();
  if (window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyFaviconForScheme();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
    } else if (typeof media.addListener === 'function') {
      media.addListener(onChange);
    }
  }

  let saved;
  try {
    saved = localStorage.getItem('promptly_theme');
  } catch {}

  if (!saved) {
    // Default to system preference
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    saved = prefersLight ? 'light' : 'dark';
  }

  const root = document.documentElement;
  if (saved === 'light') {
    root.setAttribute('data-theme', 'light');
  } else {
    root.removeAttribute('data-theme');
  }

  return saved;
}

function applyFaviconForScheme() {
  const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const iconHref = isDark ? '/assets/promptly-mark-white.png' : '/assets/promptly-logo.svg';
  const iconLink = document.querySelector('link[rel="icon"]');
  if (iconLink) {
    iconLink.setAttribute('href', iconHref);
  }
}

/**
 * Apply a theme and persist to localStorage
 * @param {string} mode - 'light' or 'dark'
 */
export function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light') {
    root.setAttribute('data-theme', 'light');
  } else {
    root.removeAttribute('data-theme');
  }

  try {
    localStorage.setItem('promptly_theme', mode);
  } catch {}

  return mode;
}

/**
 * Toggle between light and dark themes
 * @returns {string} The new theme mode
 */
export function toggleTheme() {
  const current = document.documentElement.hasAttribute('data-theme') ? 'light' : 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  return applyTheme(next);
}
