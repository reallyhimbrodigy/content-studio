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

  function showOverlay() {
    if (doc.getElementById('promptly-ref-overlay')) return;
    var overlay = el('div',
      'position:fixed;inset:0;z-index:99999;background:#000;color:#fff;display:flex;' +
      'flex-direction:column;align-items:center;justify-content:center;padding:32px 24px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;');
    overlay.id = 'promptly-ref-overlay';

    var close = el('button',
      'position:absolute;top:16px;right:16px;width:36px;height:36px;border-radius:18px;' +
      'background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.6);border:none;' +
      'font-size:16px;cursor:pointer;', '✕');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', function () { overlay.remove(); });
    overlay.appendChild(close);

    overlay.appendChild(el('div',
      'font-size:15px;letter-spacing:0.14em;color:rgba(255,255,255,0.55);' +
      'text-transform:uppercase;margin-bottom:10px;', 'You’re invited to'));
    overlay.appendChild(el('div', 'font-size:34px;font-weight:800;margin-bottom:26px;', 'Promptly'));

    // The code — large, and the whole block is tap-to-copy.
    var codeWrap = el('button',
      'background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.18);' +
      'border-radius:16px;padding:18px 30px;cursor:pointer;color:#fff;margin-bottom:8px;');
    codeWrap.setAttribute('aria-label', 'Copy referral code ' + CODE.split('').join(' '));
    var codeText = el('div', 'font-size:40px;font-weight:800;letter-spacing:0.22em;', CODE);
    var copyHint = el('div', 'font-size:13px;color:rgba(255,255,255,0.5);margin-top:6px;', 'Tap to copy');
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
      'font-size:15px;color:rgba(255,255,255,0.75);max-width:340px;line-height:1.5;margin:18px 0 6px;',
      'Talk to Promptly like an editor — captions, cuts and graphics, done for you. ' +
      'Invite 3 friends who make a video and get a week of Pro.'));
    overlay.appendChild(el('div',
      'font-size:14px;color:rgba(255,255,255,0.55);margin-bottom:26px;',
      'Enter this code when you sign up.'));

    var store = el('a',
      'display:block;background:#fff;color:#000;font-size:17px;font-weight:700;' +
      'border-radius:16px;padding:16px 44px;text-decoration:none;margin-bottom:14px;',
      'Get Promptly on the App Store');
    store.href = APP_STORE_URL;
    overlay.appendChild(store);

    var open = el('a',
      'display:block;color:rgba(255,255,255,0.6);font-size:14px;text-decoration:none;',
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
