#!/bin/bash
# validate-auth-gate.sh — the worker credential is a PRECONDITION of /validate,
# not a field attached when it happens to be available.
#
# WHAT SHIPPED BEFORE. validateVideo() read UsageService.validateToken, refreshed
# once if nil, and then built the body as:
#     if let workerAuth { body["_worker_auth"] = workerAuth }
# So when the snapshot had not landed — a pick in the first seconds of a cold
# launch — the request WENT OUT ANYWAY, just without the field.
#
# WHY THAT IS THE WORST AVAILABLE SHAPE. The worker cannot distinguish "no
# credential" from "wrong credential" without special-casing an absent field,
# and an unauthenticated call that happens to succeed teaches everyone that the
# credential is optional. The refusal and the verdict also become confusable:
# a failed validate reads to the caller like a validation result, when in fact
# no validation happened.
#
# NOT THE SUPABASE TOKEN, and never was. This call carries no Authorization
# header and no user identity; the worker learns only that the caller holds the
# worker credential. Asserted here so nobody "fixes" it by attaching the session
# token, which would send a user credential to a third-party host.
#
# Exit 0 = clean. Exit 1 = /validate can go out unauthenticated again.
set -uo pipefail
cd "$(dirname "$0")"
fail=0

python3 - <<'PY' || fail=1
import re, sys
src = open('Promptly/Services/APIService.swift', encoding='utf8').read()
m = re.search(r'func validateVideo\([\s\S]*?\n    \}\n', src)
if not m:
    print('  FAIL  validateVideo not found'); sys.exit(1)
fn = m.group(0)
bad = []

# 1. THE REGRESSION: the credential must not be conditionally attached.
# Tested as a PROPERTY, not a spelling. The first version matched one shape of
# conditional attach (`if let x { body[...] }`) and a mutation that merely added
# a type annotation — `if let a2: String? = auth { ... }` — walked straight
# through it. What must be true is that the assignment STANDS ALONE on its line
# and assigns the non-optional value the guard bound, so there is no branch in
# which the body is built without it.
if not re.search(r'^\s*body\["_worker_auth"\]\s*=\s*auth\s*$', fn, re.M):
    bad.append('_worker_auth is no longer an unconditional assignment of the guarded '
               'credential — if anything guards or defaults it, the request can go out '
               'without the field again')
if re.search(r'^\s*(if|guard)\b.*body\["_worker_auth"\]', fn, re.M):
    bad.append('_worker_auth is assigned inside a conditional on the same line')

# 2. it must be sent, unconditionally, once we are past the guard
if '_worker_auth' not in fn:
    bad.append('the request no longer carries _worker_auth at all')

# 3. THE CALL IS REFUSED when there is no credential — a throw BEFORE the send.
guard = re.search(r'guard\s+var\s+auth\s*=\s*\w+\s+else\s*\{[\s\S]{0,300}?throw', fn)
if not guard:
    bad.append('there is no guard refusing the call when the credential is unavailable — '
               'the pick must wait on the refresh, not go out without it')

# 4. ONE refresh, ONE retry on 401 — bounded.
if 'refreshedOnce' not in fn:
    bad.append('the 401 retry is no longer bounded — a credential the worker keeps '
               'rejecting would spin')
if not re.search(r'status\s*==\s*401\s*&&\s*!refreshedOnce', fn):
    bad.append('the 401 branch no longer checks the once-only flag')
if not re.search(r'refreshedOnce\s*=\s*true', fn):
    bad.append('the once-only flag is never set, so the retry is unbounded in practice')

# 5. NO user credential on this third-party call.
if re.search(r'setValue\([^)]*Authorization', fn) or 'accessToken' in fn:
    bad.append('an Authorization header or access token is being sent to the worker — '
               'this call must carry the worker credential only, never user identity')

if bad:
    print('validate-auth-gate: FAIL')
    for b in bad: print('  -', b)
    sys.exit(1)
print('  _worker_auth is unconditional; the call is refused without a credential; the 401 '
      'retry is one refresh and one attempt; no user token is sent to the worker.')
PY

[ "$fail" -eq 0 ] || { echo "validate-auth-gate: FAIL"; exit 1; }
echo "validate-auth-gate: PASS"
