#!/bin/bash
# oauth-second-device-gate.sh — social sign-in on a SECOND device must sign in
# as the existing user and discard the device's anonymous one. It must never
# mint a new account, and it must never leave the user stranded on a link error.
#
# THE SHAPE. A fresh install holds an anonymous session, so "sign in with
# Apple/Google" is ambiguous: link this identity to the anonymous user, or sign
# in as the user who already owns it? Only the second is right when the identity
# exists. The two providers reach that answer differently:
#
#   APPLE  — signInWithIdToken directly, with NO Authorization header, so it is
#            a plain sign-in by construction and can never link.
#   GOOGLE — attempts a link first (manual linking is ON: /user/identities/
#            authorize returns 302 for both providers), then falls back to plain
#            sign-in when the identity already belongs to someone.
#
# WHAT ALREADY BROKE HERE ONCE (2026-09-07). GoTrue returns
# `error_code=identity_already_exists` in its OWN callback parameter, next to a
# PROSE `error_description` ("Identity is already linked to another user"). The
# fallback matched the code against the description, so it never fired and the
# user saw the raw provider message instead of being signed in — the exact case
# the fallback exists for. That fix had no gate. This is it.
#
# NOT COVERED HERE: a real provider round-trip. A valid Apple/Google id_token
# cannot be minted off-device, so the end-to-end pass is Zac's on TestFlight.
#
# Exit 0 = clean. Exit 1 = a second device can mint an account or strand a user.
set -uo pipefail
cd "$(dirname "$0")"
fail=0

python3 - <<'PY' || fail=1
import re, sys
auth = open('Promptly/Views/AuthView.swift',    encoding='utf8').read()
svc  = open('Promptly/Services/AuthService.swift', encoding='utf8').read()
bad = []

# 1. THE 2026-09-07 REGRESSION: the code must be read from its own parameter.
if not re.search(r'dict\["error_code"\]', auth):
    bad.append('the callback no longer reads `error_code` as its own parameter — matching '
               'the code against the prose error_description is what stopped the fallback '
               'firing last time, and the description is free to be reworded')
m = re.search(r'let code = [\s\S]{0,400}?identity_already_exists', auth)
if not m:
    bad.append('identity_already_exists is no longer matched against the code parameter')

# 2. it must be raised as a TYPED error, so callers match a case not a string.
if 'throw AuthService.OAuthLinkError.identityAlreadyExists' not in auth:
    bad.append('the already-linked case is no longer a typed error')

# 3. and the caller must FALL BACK TO SIGNING IN, not surface the error.
fb = re.search(r'case AuthService\.OAuthLinkError\.identityAlreadyExists = error[\s\S]{0,400}?plainSignInURL', auth)
if not fb:
    bad.append('the identity-already-exists branch no longer falls back to a plain sign-in '
               '— the user would see a raw provider error instead of being signed in')
# ...and the fallback must actually RUN, not merely be mentioned. The first
# version of this check matched the identifier anywhere, so disabling the branch
# with `if false` while leaving the name in place passed clean.
if not re.search(r'guard let plain = Self\.plainSignInURL\(', auth):
    bad.append('plainSignInURL is no longer bound by the guard that reaches the sign-in')
if len(re.findall(r'run\(plain, linking: false\)', auth)) < 2:
    bad.append('a plain sign-in is no longer run on both the link-failed and the '
               'no-anonymous-session routes')

# 4. a link attempt is only made when there IS an anonymous session to preserve.
if not re.search(r'if AuthService\.shared\.hasAnonymousSession[\s\S]{0,300}?oauthLinkURL', auth):
    bad.append('the link attempt is no longer gated on holding an anonymous session')

# 5. EVERY failure of the link path still reaches a plain sign-in. A `catch` that
#    returns instead of falling through strands the user on a dead button.
tail = auth[auth.find('if AuthService.shared.hasAnonymousSession'):]
tail = tail[:tail.find('run(plain, linking: false)') + 40] if 'run(plain, linking: false)' in tail else ''
if not tail or 'plainSignInURL' not in tail:
    bad.append('the anonymous-session branch no longer reaches plainSignInURL on failure')

# 6. APPLE must stay a plain sign-in: signInWithIdToken sends only the anon key.
idt = re.search(r'func signInWithIdToken[\s\S]{0,900}', svc)
if not idt:
    bad.append('signInWithIdToken is gone')
elif re.search(r'Authorization', idt.group(0)):
    bad.append('signInWithIdToken now sends an Authorization header — that turns a plain '
               'sign-in into a link against the anonymous session, which is exactly how a '
               'second device would fail to reach the account that already exists')

# 7. adopting the provider session must REPLACE the session, not merge into it.
if not re.search(r'func adoptOAuthSession\s*\(', svc):
    bad.append('adoptOAuthSession is gone — the anonymous session would survive the sign-in')

if bad:
    print('oauth-second-device-gate: FAIL')
    for b in bad: print('  -', b)
    sys.exit(1)
print('  error_code is read from its own parameter and raised typed; both providers reach a '
      'plain sign-in when the identity exists; the link attempt is gated on an anonymous '
      'session; Apple never sends an Authorization header.')
PY

[ "$fail" -eq 0 ] || { echo "oauth-second-device-gate: FAIL"; exit 1; }
echo "oauth-second-device-gate: PASS"
