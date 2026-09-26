/**
 * Password-recovery rescue — usepromptly.app/#access_token=…&type=recovery
 *
 * WHY THIS FILE EXISTS. Supabase recovery emails have been landing on the
 * HOMEPAGE, which does nothing with them, so password reset was broken for every
 * user. 64 people requested recovery in 30 days and 17 never signed in again.
 *
 * THE CAUSE, MEASURED 2026-09-26 by probing /auth/v1/verify with each candidate:
 *
 *   redirect_to                                    Supabase sent it to
 *   https://usepromptly.app                        https://usepromptly.app/#…   ALLOWED
 *   https://usepromptly.app/reset-password.html    http://usepromptly.app/#…    REJECTED
 *   https://usepromptly.app/reset-password         http://usepromptly.app/#…    REJECTED
 *
 * The Redirect URLs allowlist contains the bare origin and NOT the reset paths,
 * so any redirectTo carrying a path is rejected and Supabase falls back to the
 * Site URL — which is `http://usepromptly.app`. That is the homepage. The web
 * app's own resetPassword() passes `${origin}/reset-password.html`
 * (user-store.js), so the WEB flow was broken by the same cause, not just iOS.
 *
 * THE PROPER FIX IS A DASHBOARD CHANGE AND THIS IS NOT IT. Adding the reset URL
 * to the allowlist is one field, and it should still happen. But it needs
 * Supabase dashboard access, and every recovery email ALREADY SENT points at the
 * homepage — so a config change alone leaves those links dead. This file makes
 * the link that users already have in their inbox work, tonight, from our side
 * only, and it keeps working whether or not the allowlist is ever fixed.
 *
 * WHY THE FRAGMENT FORM AND NOT ?code=. Measured, not assumed: the probe above
 * came back as `…/#error=access_denied&error_code=otp_expired…` — a FRAGMENT.
 * This project issues implicit-flow responses (supabase-client.js calls
 * createClient with no options, so flowType is the default 'implicit'), so
 * recovery material arrives in the hash. The reset page additionally handles
 * ?code= and ?token_hash= defensively, because a project setting can change
 * under us and a page that only knows one shape fails silently when it does.
 *
 * WHY IT MUST LOAD FIRST, SYNCHRONOUSLY, IN <head>. Any Supabase client created
 * on this page runs with detectSessionInUrl:true, which CONSUMES the recovery
 * fragment and then strips it from the URL. If that happens before this script,
 * there is nothing left to forward and the user is silently signed in on the
 * marketing page with no way to set a password. So: classic script, no defer, in
 * the head, above every module.
 *
 * FORWARDS ERRORS TOO. An expired or already-used link lands as
 * `#error=access_denied&error_code=otp_expired`. Leaving that on the homepage
 * shows the user nothing at all; forwarding it lets the reset page say the link
 * expired and offer a new one. A silent homepage is the worst of the outcomes.
 *
 * Self-hosted because the CSP is `script-src 'self'` — same reason
 * js/referral-landing.js is a file rather than inline.
 */
(function (global) {
  'use strict';

  var TARGET = '/reset-password.html';

  try {
    var loc = global.location;
    if (!loc) return;

    // NEVER LOOP. If we are already on the reset page, it owns the token.
    if (loc.pathname.indexOf('reset-password') !== -1) return;

    var hash = (loc.hash || '').replace(/^#/, '');
    var search = (loc.search || '').replace(/^\?/, '');
    if (!hash && !search) return;

    // Parse both halves. URLSearchParams handles the fragment fine — it is the
    // same application/x-www-form-urlencoded shape.
    var h, q;
    try { h = new global.URLSearchParams(hash); } catch (e) { return; }
    try { q = new global.URLSearchParams(search); } catch (e) { q = new global.URLSearchParams(''); }

    var get = function (k) { return h.get(k) || q.get(k); };

    var type = (get('type') || '').toLowerCase();
    var hasAccessToken = Boolean(get('access_token'));
    var hasTokenHash = Boolean(get('token_hash'));
    var errCode = (get('error_code') || '').toLowerCase();
    var err = (get('error') || '').toLowerCase();

    // WHAT COUNTS AS RECOVERY MATERIAL. Deliberately narrow: a bare ?code= is
    // NOT forwarded, because that shape is shared with OAuth sign-in and
    // hijacking every one of them would break Google/Apple login. The reset page
    // handles ?code= for anyone who arrives there carrying it.
    var isRecovery = (type === 'recovery' && (hasAccessToken || hasTokenHash));

    // An auth error with no type is almost always an expired recovery or magic
    // link — both want the same destination, which can offer a fresh link.
    var isAuthError = (err === 'access_denied' || errCode === 'otp_expired'
                       || errCode === 'otp_disabled');

    if (!isRecovery && !isAuthError) return;

    // CARRY EVERYTHING ACROSS, UNTOUCHED. The page needs the whole payload —
    // access_token AND refresh_token, or token_hash and type, or the error pair.
    // Rebuilding a subset is how a field nobody remembered goes missing.
    var next = TARGET
      + (search ? '?' + search : '')
      + (hash ? '#' + hash : '');

    // replace(), not assign(): the recovery URL must not sit in history where a
    // back button would re-run a now-consumed token and show a confusing error.
    loc.replace(next);
  } catch (e) {
    // A rescue that throws must not take the homepage with it. Any failure here
    // leaves the user exactly where they are — no worse than before this file.
  }
}(typeof window !== 'undefined' ? window : this));
