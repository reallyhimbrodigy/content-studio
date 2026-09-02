/**
 * Referral landing — usepromptly.app/?ref=CODE
 *
 * The one web piece of the referral loop: an https share link is the only thing
 * that reaches people WITHOUT the app, and the app cannot observe an App Store
 * install — so this page carries the code across the gap. The app's manual
 * entry path ("enter the code at signup") is the mechanism; this page's whole
 * job is to make the code survive the round trip.
 *
 * Behaviour:
 *   - No ?ref= (or an invalid one): DO NOTHING. The generic landing renders
 *     untouched — never a broken page.
 *   - Valid ?ref=: first try to deep-link an already-installed app via the
 *     registered custom scheme (app.usepromptly.ios://open?ref=CODE — the iOS
 *     root onOpenURL accepts ?ref= on any URL). If the page is still visible
 *     ~1.4s later, the app isn't installed (or the OS blocked the hop) →
 *     render the referral overlay: code LARGE and tap-to-copy, the offer line,
 *     the enter-at-signup instruction, and the App Store button.
 *
 * Code alphabet: A-Z minus O/I/L, digits 2-9 (no 0/1) — unambiguous when read
 * aloud or retyped. Validation mirrors it so garbage in the URL renders the
 * generic page, not a broken overlay.
 *
 * Self-hosted (CSP script-src 'self'); inline styles (style-src allows them).
 */
(function (global) {
  'use strict';
  var doc = global.document;
  if (!doc) return;

  // ── Code intake + validation (the unambiguous alphabet, 4-12 chars) ───────
  var params;
  try { params = new URLSearchParams(global.location.search); } catch (e) { return; }
  var raw = (params.get('ref') || '').trim().toUpperCase();
  if (!raw) return;                                    // generic page, untouched
  if (!/^[A-HJ-KM-NP-Z2-9]{4,12}$/.test(raw)) return;  // invalid → generic page
  var CODE = raw;

  var APP_STORE_URL = 'https://apps.apple.com/app/id6762497454';
  var SCHEME_URL = 'app.usepromptly.ios://open?ref=' + encodeURIComponent(CODE);

  // ── Analytics (the same open mirror the app + escape module use) ──────────
  function track(event, props) {
    try {
      var payload = JSON.stringify({
        event: event, platform: 'web', app_version: 'referral-landing', props: props || {}
      });
      if (global.navigator && global.navigator.sendBeacon) {
        global.navigator.sendBeacon('/api/events', new Blob([payload], { type: 'application/json' }));
      } else if (global.fetch) {
        global.fetch('/api/events', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true
        }).catch(function () {});
      }
    } catch (e) { /* analytics must never break the page */ }
  }

  // ── Overlay ───────────────────────────────────────────────────────────────
  function el(tag, style, text) {
    var n = doc.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (text) n.textContent = text;
    return n;
  }

  // Theme tokens for the overlay, resolved by the OS rather than hardcoded.
  //
  // This panel used to be `background:#000;color:#fff` with every nested colour
  // written as rgba(255,255,255,…). The site itself is NOT permanently dark:
  // css/theme.css defaults `--bg-body` to #ffffff and only switches under
  // `prefers-color-scheme: dark`, and the page declares `color-scheme: light
  // dark`, so a light-mode visitor got a black full-screen slab and light
  // browser chrome around it. Injected as a stylesheet with a dark media query
  // rather than computed once in JS, so it follows a mid-session OS change.
  function injectStyles() {
    if (doc.getElementById('promptly-ref-style')) return;
    var s = doc.createElement('style');
    s.id = 'promptly-ref-style';
    s.textContent =
      '#promptly-ref-overlay{' +
        '--ref-bg:#ffffff;--ref-fg:#111111;--ref-dim:rgba(17,17,17,0.62);' +
        '--ref-faint:rgba(17,17,17,0.45);--ref-panel:rgba(17,17,17,0.04);' +
        '--ref-line:rgba(17,17,17,0.14);--ref-btn-bg:#111111;--ref-btn-fg:#ffffff;}' +
      '@media (prefers-color-scheme: dark){#promptly-ref-overlay{' +
        '--ref-bg:#0a0a0a;--ref-fg:#ffffff;--ref-dim:rgba(255,255,255,0.75);' +
        '--ref-faint:rgba(255,255,255,0.55);--ref-panel:rgba(255,255,255,0.07);' +
        '--ref-line:rgba(255,255,255,0.18);--ref-btn-bg:#ffffff;--ref-btn-fg:#000000;}}';
    doc.head.appendChild(s);
  }

  function showOverlay() {
    if (doc.getElementById('promptly-ref-overlay')) return;
    injectStyles();
    var overlay = el('div',
      'position:fixed;inset:0;z-index:99999;background:var(--ref-bg);color:var(--ref-fg);display:flex;' +
      'flex-direction:column;align-items:center;justify-content:center;padding:32px 24px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;');
    overlay.id = 'promptly-ref-overlay';

    var close = el('button',
      'position:absolute;top:16px;right:16px;width:36px;height:36px;border-radius:18px;' +
      'background:var(--ref-panel);color:var(--ref-faint);border:none;' +
      'font-size:16px;cursor:pointer;', '✕');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', function () { overlay.remove(); });
    overlay.appendChild(close);

    overlay.appendChild(el('div',
      'font-size:15px;letter-spacing:0.14em;color:var(--ref-faint);' +
      'text-transform:uppercase;margin-bottom:10px;', 'You’re invited to'));
    overlay.appendChild(el('div', 'font-size:34px;font-weight:800;margin-bottom:26px;', 'Promptly'));

    // The code — large, and the whole block is tap-to-copy.
    var codeWrap = el('button',
      'background:var(--ref-panel);border:1px solid var(--ref-line);' +
      'border-radius:16px;padding:18px 30px;cursor:pointer;color:var(--ref-fg);margin-bottom:8px;');
    codeWrap.setAttribute('aria-label', 'Copy referral code ' + CODE.split('').join(' '));
    var codeText = el('div', 'font-size:40px;font-weight:800;letter-spacing:0.22em;', CODE);
    var copyHint = el('div', 'font-size:13px;color:var(--ref-faint);margin-top:6px;', 'Tap to copy');
    codeWrap.appendChild(codeText);
    codeWrap.appendChild(copyHint);
    codeWrap.addEventListener('click', function () {
      function done() { copyHint.textContent = 'Copied ✓'; }
      try {
        if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
          global.navigator.clipboard.writeText(CODE).then(done, fallbackCopy);
        } else { fallbackCopy(); }
      } catch (e) { fallbackCopy(); }
      function fallbackCopy() {
        try {
          var ta = doc.createElement('textarea');
          ta.value = CODE;
          ta.setAttribute('style', 'position:fixed;opacity:0;');
          doc.body.appendChild(ta); ta.select();
          doc.execCommand('copy'); ta.remove(); done();
        } catch (e2) { /* the code is still on screen — copy by eye works */ }
      }
    });
    overlay.appendChild(codeWrap);

    overlay.appendChild(el('div',
      'font-size:15px;color:var(--ref-dim);max-width:340px;line-height:1.5;margin:18px 0 6px;',
      // Says nothing about a reward. This panel is read by the person being
      // INVITED, and promising them anything for installing is the two-sided
      // shape guideline 3.2.2 rejects. It also used to read "Invite 3 friends
      // who make a video and get a week of Pro" — a quota the ladder was built
      // to remove, describing a reward we no longer grant, addressed to the
      // wrong person. The product claim alone is the stronger opening anyway.
      'Talk to Promptly like an editor — captions, cuts and graphics, done for you.'));
    overlay.appendChild(el('div',
      'font-size:14px;color:var(--ref-faint);margin-bottom:26px;',
      'Enter this code when you sign up.'));

    var store = el('a',
      'display:block;background:var(--ref-btn-bg);color:var(--ref-btn-fg);font-size:17px;font-weight:700;' +
      'border-radius:16px;padding:16px 44px;text-decoration:none;margin-bottom:14px;',
      'Get Promptly on the App Store');
    store.href = APP_STORE_URL;
    overlay.appendChild(store);

    var open = el('a',
      'display:block;color:var(--ref-dim);font-size:14px;text-decoration:none;',
      'Already have Promptly? Open the app');
    open.href = SCHEME_URL;
    overlay.appendChild(open);

    doc.body.appendChild(overlay);
  }

  // ── Flow: page renders IMMEDIATELY; the app hop runs in parallel ──────────
  // There is no web API to test for a custom scheme — the attempt IS the
  // check. Installed users hop straight through (the page is behind the app a
  // beat later); everyone else already has the full referral page on screen,
  // so the OS's "cannot open" alert (when it appears at all) dismisses onto
  // content, never onto a blank screen.
  function run() {
    track('referral_link_opened', { source: 'web' });
    showOverlay();
    try { global.location.href = SCHEME_URL; } catch (e) { /* page already up */ }
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
}(typeof window !== 'undefined' ? window : this));
