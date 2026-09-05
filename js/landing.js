const isProdHost = () => {
  const host = window.location.hostname;
  return window.location.protocol === 'https:' && (host === 'usepromptly.app' || host === 'www.usepromptly.app');
};

const analyticsEnabled = isProdHost();
const analyticsDebug =
  analyticsEnabled &&
  new URLSearchParams(window.location.search || '').get('analytics_debug') === '1';

const getAnalyticsPath = () => `${window.location.pathname}${window.location.search}${window.location.hash || ''}`;

const emitAnalytics = window.emitPromptlyAnalytics || ((eventName, payload = {}) => {
  if (!analyticsEnabled) return;
  const detail = {
    event: eventName,
    path: getAnalyticsPath(),
    title: document.title,
    ...payload,
    ts: Date.now(),
  };
  window.dispatchEvent(new CustomEvent('promptly_analytics', { detail }));
  if (analyticsDebug) console.info('[PromptlyAnalytics]', eventName, detail);
});

window.emitPromptlyAnalytics = emitAnalytics;

const initAnalyticsPageviews = () => {
  if (!analyticsEnabled || window.__promptlyAnalyticsPageviews) return;
  window.__promptlyAnalyticsPageviews = true;
  let lastPath = getAnalyticsPath();
  emitAnalytics('pageview', { path: lastPath, title: document.title, referrer: document.referrer || '' });
  const handleRouteChange = () => {
    const nextPath = getAnalyticsPath();
    if (nextPath === lastPath) return;
    const referrer = lastPath;
    lastPath = nextPath;
    emitAnalytics('virtual_pageview', { path: nextPath, title: document.title, referrer });
  };
  const wrapHistory = (method) => {
    if (!history[method] || history[method].__promptlyWrapped) return;
    const original = history[method];
    const wrapped = function (...args) {
      const result = original.apply(this, args);
      handleRouteChange();
      return result;
    };
    wrapped.__promptlyWrapped = true;
    history[method] = wrapped;
  };
  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('popstate', handleRouteChange);
  window.addEventListener('hashchange', handleRouteChange);
};

const initFrustrationSignals = () => {
  if (!analyticsEnabled || window.__promptlyAnalyticsFrustration) return;
  window.__promptlyAnalyticsFrustration = true;
  const getTargetSelector = (el) => {
    if (!el || !el.tagName) return '';
    if (el.dataset?.analytics) return `[data-analytics="${el.dataset.analytics}"]`;
    if (el.id) return `#${el.id}`;
    const className = typeof el.className === 'string' ? el.className.trim() : '';
    if (className) {
      const short = className.split(/\s+/).slice(0, 2).join('.');
      return `${el.tagName.toLowerCase()}.${short}`;
    }
    return el.tagName.toLowerCase();
  };
  const isInteractive = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const selector = 'a,button,input,select,textarea,summary,[role="button"],[data-analytics],label';
    if (el.matches(selector) || el.closest(selector)) return true;
    if (typeof el.onclick === 'function') return true;
    const tabindex = el.getAttribute?.('tabindex');
    return tabindex === '0';
  };
  let rageClicks = [];
  let lastRageEmit = 0;
  document.addEventListener('click', (event) => {
    const now = Date.now();
    const x = typeof event.clientX === 'number' ? event.clientX : 0;
    const y = typeof event.clientY === 'number' ? event.clientY : 0;
    rageClicks = rageClicks.filter((c) => now - c.ts <= 2000);
    rageClicks.push({ ts: now, x, y });
    const nearby = rageClicks.filter((c) => Math.hypot(c.x - x, c.y - y) <= 40);
    if (nearby.length >= 5 && now - lastRageEmit > 2000) {
      lastRageEmit = now;
      rageClicks = [];
      emitAnalytics('rage_click', { x, y, targetSelector: getTargetSelector(event.target) });
    }
    const target = event.target;
    if (!isInteractive(target)) {
      const startHref = window.location.href;
      const startActive = document.activeElement;
      setTimeout(() => {
        if (window.location.href !== startHref) return;
        if (document.activeElement && document.activeElement !== startActive) return;
        emitAnalytics('dead_click', {
          targetTag: target?.tagName?.toLowerCase() || '',
          targetSelector: getTargetSelector(target),
        });
      }, 350);
    }
  });

  window.addEventListener('error', (event) => {
    emitAnalytics('js_error', {
      message: event.message || 'Script error',
      source: event.filename || '',
      lineno: event.lineno || 0,
      colno: event.colno || 0,
      stack: event.error?.stack || '',
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    emitAnalytics('js_error', {
      message: reason?.message || String(reason || 'Unhandled rejection'),
      stack: reason?.stack || '',
      source: 'unhandledrejection',
      lineno: 0,
      colno: 0,
    });
  });
};

initAnalyticsPageviews();
initFrustrationSignals();

(function () {
  if (!document.body.classList.contains('view-landing')) return;
  const modal = document.getElementById('upgrade-modal');
  const closeBtn = document.getElementById('upgrade-close');
  if (!modal || !closeBtn) return;
  const toggle = (show) => {
    modal.style.display = show ? 'block' : 'none';
    if (show) document.body.classList.add('no-scroll');
    else document.body.classList.remove('no-scroll');
    if (show) emitAnalytics('upgrade_modal_open');
  };
  if (typeof window.showUpgradeModal !== 'function') {
    window.showUpgradeModal = () => toggle(true);
    window.hideUpgradeModal = () => toggle(false);
  }
  closeBtn.addEventListener('click', () => toggle(false));
  modal.addEventListener('click', (event) => {
    if (event.target === modal) toggle(false);
  });
})();

document.addEventListener('DOMContentLoaded', () => {
  if (!document.body.classList.contains('view-landing')) return;
  const signupTriggers = document.querySelectorAll('[data-analytics="cta_signup"]');
  if (signupTriggers.length > 0) {
    signupTriggers.forEach((trigger) => {
      trigger.addEventListener('click', () => {
        emitAnalytics('signup_start');
      });
    });
  }
  const triggers = document.querySelectorAll('[data-upgrade-trigger]');
  if (triggers.length > 0) {
    triggers.forEach((trigger) => {
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        if (typeof window.showUpgradeModal === 'function') {
          window.showUpgradeModal();
        }
      });
    });
  }

  const upgradeBtn = document.getElementById('upgrade-btn');
  if (!upgradeBtn) return;
  upgradeBtn.addEventListener('click', async (event) => {
    event.preventDefault();
    emitAnalytics('upgrade_click');
    // NO STRIPE FALLBACK (removed 2026-09-05). The standalone payment link took
    // money and granted nothing — no webhook writes pro_until. Until RevenueCat
    // Web Billing serves a real checkout URL from /api/billing/checkout, this
    // button goes nowhere rather than to a checkout that can't deliver.
    try {
      const resp = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: '', priceLookupKey: 'promptly_pro_monthly' })
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data && data.url) {
        window.location.href = data.url;   // Web Billing, once it exists
        return;
      }
      // No checkout URL yet: do not navigate. (Web Billing not wired.)
      emitAnalytics('upgrade_click_no_checkout');
    } catch (_) {
      emitAnalytics('upgrade_click_no_checkout');
    }
  });
});
