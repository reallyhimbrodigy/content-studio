/*
 * inapp-browser-escape.js
 * ---------------------------------------------------------------------------
 * Meta (Instagram / Facebook / Threads / Messenger) and TikTok in-app browsers
 * silently swallow taps on iOS App Store links. The tap registers, nothing
 * happens, and the user assumes the app is broken. This module intercepts those
 * taps and breaks out to the real system browser, then falls back to explicit
 * instructions if the breakout is refused.
 *
 * No dependencies. Drop in a <script> tag, or import and call escapeInit().
 *
 * USAGE
 *   <a href="https://apps.apple.com/app/..." data-store-link>Get the app</a>
 *   <script src="/inapp-browser-escape.js"></script>
 *
 * The anchor keeps a real href, so normal browsers, crawlers, and
 * right-click/copy-link all behave exactly as they do today. The interception
 * only engages inside a detected in-app browser.
 *
 * CRITICAL IMPLEMENTATION NOTE
 *   The breakout MUST be issued synchronously inside the click handler. iOS
 *   discards navigation to a custom scheme that happens in a promise callback,
 *   a setTimeout, or after an await. Everything asynchronous in here runs
 *   AFTER the navigation attempt has already been fired. The analytics calls
 *   below use sendBeacon (non-blocking) and are issued AFTER the breakout so
 *   they can never delay or swallow it.
 */

(function (global) {
  'use strict';

  var UA = (global.navigator && global.navigator.userAgent) || '';

  /* ---------------------------------------------------------------------
   * Analytics — POST to /api/events (the same open mirror the app uses).
   * Fire-and-forget; must NEVER throw or block the escape. sendBeacon keeps
   * the request alive across the page backgrounding that a successful escape
   * causes, so escape_succeeded/escape_attempted don't get cancelled mid-flight.
   * ------------------------------------------------------------------ */

  function track(event, props) {
    try {
      var payload = JSON.stringify({
        event: event, platform: 'web', app_version: 'inapp-escape', props: props || {}
      });
      if (global.navigator && global.navigator.sendBeacon) {
        global.navigator.sendBeacon('/api/events', new Blob([payload], { type: 'application/json' }));
      } else if (global.fetch) {
        global.fetch('/api/events', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true
        }).catch(function () {});
      }
    } catch (e) { /* analytics must never break the escape */ }
  }

  /* ---------------------------------------------------------------------
   * Environment detection
   * ------------------------------------------------------------------ */

  function isIOS() {
    // iPadOS 13+ reports as MacIntel, so touch points disambiguate it.
    return (
      /iPad|iPhone|iPod/.test(UA) ||
      (global.navigator &&
        global.navigator.platform === 'MacIntel' &&
        global.navigator.maxTouchPoints > 1)
    );
  }

  function isAndroid() {
    return /Android/i.test(UA);
  }

  // Ordered most-specific first: Messenger UAs also contain FBAN.
  var HOSTS = [
    { id: 'messenger', test: /FBAN\/Messenger|Messenger[Ll]ite|MessengerForiOS/ },
    { id: 'instagram', test: /Instagram/ },
    { id: 'threads',   test: /Barcelona|Threads/ },
    { id: 'facebook',  test: /FBAN|FBAV|FB_IAB|FB4A/ },
    { id: 'tiktok',    test: /BytedanceWebview|musical_ly|Bytedance|TikTok/ },
    { id: 'snapchat',  test: /Snapchat/ },
    { id: 'linkedin',  test: /LinkedInApp/ },
    { id: 'twitter',   test: /Twitter for iPhone|TwitterAndroid/ }
  ];

  function detectHost() {
    for (var i = 0; i < HOSTS.length; i++) {
      if (HOSTS[i].test.test(UA)) return HOSTS[i].id;
    }
    return null;
  }

  function isInAppBrowser() {
    return detectHost() !== null;
  }

  /* ---------------------------------------------------------------------
   * Breakout strategies — all fired synchronously
   * ------------------------------------------------------------------ */

  function stripScheme(url) {
    return url.replace(/^https?:\/\//, '');
  }

  // Returns true if a breakout was attempted, false if no strategy exists for
  // this host and the caller should go straight to the instruction modal.
  function attemptEscape(url, host) {
    if (isIOS()) {
      if (host === 'instagram' || host === 'threads') {
        // The Instagram app registers this scheme and hands the URL to Safari.
        // x-safari- via location.href is silently dropped by IG's webview,
        // which is why this specific form is required.
        global.location.href =
          'instagram://extbrowser/?url=' + encodeURIComponent(url);
        return true;
      }

      if (host === 'facebook' || host === 'messenger') {
        // Facebook's webview honours the x-safari- prefix via window.open.
        global.open('x-safari-' + url, '_blank');
        return true;
      }

      // TikTok, Snapchat, LinkedIn and Twitter expose no documented escape
      // scheme on iOS. Try the plain navigation once — some builds honour it —
      // and let the fallback timer surface instructions if it does not.
      global.location.href = url;
      return true;
    }

    if (isAndroid()) {
      // Android intent:// hands the URL to the default browser.
      global.location.href =
        'intent://' + stripScheme(url) + '#Intent;scheme=https;end';
      return true;
    }

    return false;
  }

  /* ---------------------------------------------------------------------
   * Success detection
   *
   * There is no callback for "the system browser opened". The reliable proxy
   * is that our page goes to the background: visibilitychange, pagehide, or
   * blur. If none fire inside the window, the breakout was refused.
   * ------------------------------------------------------------------ */

  var ESCAPE_WINDOW_MS = 1500;

  function watchForEscape(host, onFailure) {
    var settled = false;

    function succeeded() {
      if (settled) return;
      settled = true;
      cleanup();
      track('escape_succeeded', { host: host }); // page backgrounded → browser opened
    }

    function cleanup() {
      document.removeEventListener('visibilitychange', onVisibility);
      global.removeEventListener('pagehide', succeeded);
      global.removeEventListener('blur', succeeded);
    }

    function onVisibility() {
      if (document.hidden) succeeded();
    }

    document.addEventListener('visibilitychange', onVisibility);
    global.addEventListener('pagehide', succeeded);
    global.addEventListener('blur', succeeded);

    global.setTimeout(function () {
      if (settled) return;
      settled = true;
      cleanup();
      onFailure();
    }, ESCAPE_WINDOW_MS);
  }

  /* ---------------------------------------------------------------------
   * Fallback modal
   * ------------------------------------------------------------------ */

  var MODAL_ID = 'inapp-escape-modal';

  var HOST_STEPS = {
    instagram: 'Tap ••• at the top right, then "Open in external browser".',
    threads:   'Tap ••• at the top right, then "Open in browser".',
    facebook:  'Tap ••• at the top right, then "Open in browser".',
    messenger: 'Tap ••• at the top right, then "Open in browser".',
    tiktok:    'Tap ••• at the top right, then "Open in browser".',
    snapchat:  'Tap ••• at the top right, then "Open in browser".',
    linkedin:  'Tap ••• at the top right, then "Open in browser".',
    twitter:   'Tap the share icon, then "Open in Safari".'
  };

  function injectStyles() {
    if (document.getElementById(MODAL_ID + '-styles')) return;
    var style = document.createElement('style');
    style.id = MODAL_ID + '-styles';
    style.textContent = [
      '#' + MODAL_ID + '{position:fixed;inset:0;z-index:2147483647;display:flex;',
      'align-items:flex-end;justify-content:center;background:rgba(0,0,0,.72);',
      '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);',
      'font:400 16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}',
      '#' + MODAL_ID + ' .iae-card{width:100%;max-width:420px;background:#141414;',
      'color:#f5f5f5;border-radius:20px 20px 0 0;padding:28px 24px calc(24px + env(safe-area-inset-bottom));',
      'box-shadow:0 -8px 40px rgba(0,0,0,.5);animation:iae-rise .28s cubic-bezier(.2,.8,.2,1);}',
      '@media(min-width:520px){#' + MODAL_ID + '{align-items:center;}',
      '#' + MODAL_ID + ' .iae-card{border-radius:20px;}}',
      '@keyframes iae-rise{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}',
      '@media(prefers-reduced-motion:reduce){#' + MODAL_ID + ' .iae-card{animation:none}}',
      '#' + MODAL_ID + ' h2{margin:0 0 8px;font-size:20px;font-weight:650;letter-spacing:-.01em;}',
      '#' + MODAL_ID + ' p{margin:0 0 20px;font-size:15px;color:#a8a8a8;}',
      '#' + MODAL_ID + ' .iae-steps{margin:0 0 20px;padding:14px 16px;background:#1e1e1e;',
      'border-radius:12px;font-size:14px;color:#d4d4d4;}',
      '#' + MODAL_ID + ' button{width:100%;border:0;border-radius:12px;padding:15px;',
      'font:inherit;font-size:16px;font-weight:600;cursor:pointer;-webkit-appearance:none;}',
      '#' + MODAL_ID + ' .iae-primary{background:#fff;color:#0a0a0a;margin-bottom:10px;}',
      '#' + MODAL_ID + ' .iae-secondary{background:#242424;color:#f5f5f5;margin-bottom:10px;}',
      '#' + MODAL_ID + ' .iae-dismiss{background:none;color:#8a8a8a;font-weight:500;font-size:15px;}',
      '#' + MODAL_ID + ' button:focus-visible{outline:2px solid #fff;outline-offset:2px;}'
    ].join('');
    document.head.appendChild(style);
  }

  function copyToClipboard(text) {
    if (global.navigator && global.navigator.clipboard) {
      return global.navigator.clipboard.writeText(text);
    }
    // Webviews frequently block the async clipboard API.
    var el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(el);
    el.select();
    el.setSelectionRange(0, text.length);
    try { document.execCommand('copy'); } catch (e) { /* nothing else to try */ }
    document.body.removeChild(el);
    return Promise.resolve();
  }

  function showFallbackModal(url, host, retry) {
    if (document.getElementById(MODAL_ID)) return;
    injectStyles();
    track('escape_fallback_shown', { host: host }); // breakout refused → instructions surfaced

    var overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', MODAL_ID + '-title');

    var card = document.createElement('div');
    card.className = 'iae-card';

    var title = document.createElement('h2');
    title.id = MODAL_ID + '-title';
    title.textContent = 'Open this in your browser';

    var body = document.createElement('p');
    body.textContent =
      'This app’s built-in browser blocks App Store links. Open the page in ' +
      (isIOS() ? 'Safari' : 'your browser') + ' to continue.';

    var steps = document.createElement('div');
    steps.className = 'iae-steps';
    steps.textContent = HOST_STEPS[host] || 'Open this page in your browser to continue.';

    var primary = document.createElement('button');
    primary.className = 'iae-primary';
    primary.type = 'button';
    primary.textContent = 'Try again';
    primary.addEventListener('click', function () {
      track('fallback_retry', { host: host });
      overlay.remove();
      retry();
    });

    var secondary = document.createElement('button');
    secondary.className = 'iae-secondary';
    secondary.type = 'button';
    secondary.textContent = 'Copy link';
    secondary.addEventListener('click', function () {
      track('fallback_copy', { host: host });
      copyToClipboard(url);
      secondary.textContent = 'Link copied';
      global.setTimeout(function () { secondary.textContent = 'Copy link'; }, 2000);
    });

    var dismiss = document.createElement('button');
    dismiss.className = 'iae-dismiss';
    dismiss.type = 'button';
    dismiss.textContent = 'Not now';
    dismiss.addEventListener('click', function () { overlay.remove(); });

    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(steps);
    card.appendChild(primary);
    card.appendChild(secondary);
    card.appendChild(dismiss);
    overlay.appendChild(card);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
    primary.focus();
  }

  /* ---------------------------------------------------------------------
   * Public API
   * ------------------------------------------------------------------ */

  /**
   * Open a URL, escaping the in-app browser if we are inside one.
   * MUST be called synchronously from within a user gesture.
   * Returns true if the tap was intercepted, false if the caller should let
   * the normal navigation proceed.
   */
  function escapeOpen(url) {
    var host = detectHost();
    if (!host) return false;

    var attempted = attemptEscape(url, host);
    // Fired AFTER the synchronous breakout above, so it can never delay it.
    track('escape_attempted', { host: host, attempted: attempted });
    if (!attempted) {
      showFallbackModal(url, host, function () { escapeOpen(url); });
      return true;
    }

    watchForEscape(host, function () {
      showFallbackModal(url, host, function () { escapeOpen(url); });
    });

    return true;
  }

  /**
   * Wire every matching anchor on the page. Anchors keep their real href, so
   * behaviour outside an in-app browser is completely unchanged.
   */
  function escapeInit(selector) {
    var sel = selector || 'a[data-store-link], a[href*="apps.apple.com"], a[href*="play.google.com"]';

    function wire() {
      // Size the problem (item 3): one landing event per page, tagged with the
      // detected in-app host (or 'none'), so a day of traffic shows which hosts
      // actually reach us. UA is truncated; no PII.
      track('inapp_landing', { host: detectHost() || 'none', ios: isIOS(), ua: UA.slice(0, 200) });

      var links = document.querySelectorAll(sel);
      for (var i = 0; i < links.length; i++) {
        (function (link) {
          if (link.__iaeWired) return;
          link.__iaeWired = true;
          link.addEventListener('click', function (e) {
            if (!isInAppBrowser()) return; // normal browser: real navigation
            var url = link.href;
            if (!url) return;
            e.preventDefault();
            escapeOpen(url);
          });
        })(links[i]);
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', wire);
    } else {
      wire();
    }
    return wire; // re-run after injecting new links
  }

  var api = {
    isIOS: isIOS,
    isAndroid: isAndroid,
    detectHost: detectHost,
    isInAppBrowser: isInAppBrowser,
    escapeOpen: escapeOpen,
    escapeInit: escapeInit
  };

  global.InAppEscape = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // Auto-wire on load. Set window.INAPP_ESCAPE_MANUAL = true before this script
  // to opt out and call escapeInit() yourself.
  if (!global.INAPP_ESCAPE_MANUAL) escapeInit();
})(typeof window !== 'undefined' ? window : this);
