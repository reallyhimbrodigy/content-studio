#!/bin/bash
# auth-verify-type-gate.sh — verify the OTP with the type that matches the token
# that was actually minted.
#
# THE OUTAGE (2026-09-20, P0). Second-device sign-in failed for every user with
# an existing account. 26 users sat at "That code didn't work"; 9 in 7 days.
#
# The chain, measured live rather than reasoned about:
#   device 2 is a fresh install, so it holds an ANONYMOUS session
#   user types their existing email
#   linkEmailIdentity -> PUT /auth/v1/user -> HTTP 422 error_code=email_exists
#   fallback -> sendOtp -> mints a MAGICLINK (verification_type=magiclink,
#     stored in the recovery slot, which is why these look like password-reset
#     tokens in auth.one_time_tokens — they are not)
#   verify -> type was chosen by `currentUser?.isAnonymous == true` -> TRUE
#     -> "email_change" -> refused
#
# A throwaway-user exchange settled the types: that magiclink token verifies
# HTTP 200 as `email`, and only a token minted by linkEmailIdentity verifies as
# `email_change`.
#
# WHY IT WAS INVISIBLE. `isAnonymous` is TRUE on BOTH paths at verify time — the
# device is anonymous whether the code came from the link flow or the recovery
# fallback, because signing in has not happened yet. It is a CONSISTENT field
# being used to discriminate. The value that does discriminate (which outcome
# linkEmailIdentity returned) was computed in AuthView as
# `isRecoveringExistingAccount` and then never read by anything.
#
# Exit 0 = clean. Exit 1 = the verify type can drift from the minting path.
set -uo pipefail
cd "$(dirname "$0")"
fail=0

python3 - <<'PY' || fail=1
import re, sys
otp  = open('Promptly/Views/OtpInputView.swift', encoding='utf8').read()
auth = open('Promptly/Views/AuthView.swift',    encoding='utf8').read()
bad = []

# 1. THE REGRESSION ITSELF: the verify type must not be derived from isAnonymous.
if re.search(r'linking:\s*[^\n]*isAnonymous', otp):
    bad.append('the verify type is derived from isAnonymous again — that is TRUE on '
               'both the link path and the recovery path at verify time, so it cannot '
               'tell a magiclink token from an email_change token')

# 2. the fact is passed IN, because it cannot be recovered at the sheet.
# The DECLARATION, not just the identifier: the first version of this check
# searched for the name anywhere in the file, so deleting the stored property
# while leaving it referenced in a comment passed clean.
if not re.search(r'^\s*let codeIsLinkToken:\s*Bool\s*$', otp, re.M):
    bad.append('OtpInputView no longer declares codeIsLinkToken as a stored property — '
               'the minting path is not being passed in at all')
if not re.search(r'linking:\s*isLinkToken', otp):
    bad.append('verifyOtp is not called with the passed-in minting path')

# 3. AuthView must set it from the ACTUAL outcome, not a constant.
if not re.search(r'isLinkToken:\s*outcome == \.linked', auth):
    bad.append('AuthView no longer derives isLinkToken from `outcome == .linked` — only '
               'that outcome minted an email_change token; every other path used sendOtp')
for lit in [r'isLinkToken:\s*true\b', r'isLinkToken:\s*false\b']:
    if re.search(lit, auth):
        bad.append('isLinkToken is hard-coded at the presentation site instead of read '
                   'from the outcome')

# 4. the presentation must CARRY it, so the sheet cannot be shown without it.
if not re.search(r'struct OtpPresentation[\s\S]{0,400}?let isLinkToken: Bool', auth):
    bad.append('OtpPresentation no longer carries isLinkToken — a second @State beside '
               'the email is exactly how the two drift apart')

# 5. a RESEND always mints a magiclink, so the link flag must not survive one.
if 'resentAsMagicLink' not in otp:
    bad.append('a resend no longer clears the link-token flag — resend goes through '
               'sendOtp, so after one the code is a magiclink whatever the first was')

# 6. the recovery fallback must still be reachable: 422 email_exists -> sendOtp.
svc = open('Promptly/Services/AuthService.swift', encoding='utf8').read()
if 'email_exists' not in svc:
    bad.append('the identity-already-exists detection is gone — the link attempt would '
               'throw instead of falling back to signing in')
if not re.search(r'case existingAccount', svc):
    bad.append('the existingAccount outcome is gone')

if bad:
    print('auth-verify-type-gate: FAIL')
    for b in bad: print('  -', b)
    sys.exit(1)
print('  the verify type is carried from the minting path, not re-derived from '
      'isAnonymous; the presentation carries it; a resend clears it; the '
      'email_exists fallback is intact.')
PY

[ "$fail" -eq 0 ] || { echo "auth-verify-type-gate: FAIL"; exit 1; }
echo "auth-verify-type-gate: PASS"
