#!/usr/bin/env bash
# AUTH REFRESH STORE — one reader for the refresh token, Keychain first.
#
# WHY THIS EXISTS (2026-09-07). The session moved to the Keychain because
# UserDefaults is wiped by a delete-and-reinstall, and an ANONYMOUS user whose
# UserDefaults is wiped has no email to sign back in with — their identity and
# every job under it is gone. `checkSession` was taught to read the Keychain
# first. The two paths that RENEW the session were not:
#
#   getValidToken()        UserDefaults.standard.string(forKey: refreshKey)
#   scheduleTokenRefresh() UserDefaults.standard.string(forKey: refreshKey)
#
# So on the exact case the Keychain exists for — container wiped, Keychain
# intact — `checkSession` restores the session, `expiry == 0` (the expiry lived
# in the wiped UserDefaults) makes needsRefresh permanently true, and if the
# launch refresh fails SOFTLY the session is kept while neither refresh path can
# find a token. Every API call then rides an expired JWT and returns 401.
#
# It is also a landmine for the release that drops the UserDefaults mirror
# `saveSession` writes "for one release": on that build both paths would find
# nothing for EVERY user and no session could ever refresh.
#
# The gate: exactly one Keychain-first reader, and every consumer goes through
# it. `migrateSessionToKeychainIfNeeded` is the one allowed direct UserDefaults
# read — it is asking a different question ("is there a legacy session to
# move?"), and answering it from the Keychain would make it a tautology.
set -uo pipefail
cd "$(dirname "$0")"

F=Promptly/Services/AuthService.swift
[ -f "$F" ] || { echo "  missing $F"; exit 1; }
FAIL=0

# Comments are not code. auth-seam-gate was once satisfied by its own comment.
BODY=$(sed -E 's://.*::' "$F")

# 1. THE ACCESSOR EXISTS AND IS KEYCHAIN-FIRST.
grep -q "private var storedRefreshToken: String?" <<< "$BODY" || {
  echo "  storedRefreshToken is gone — there is no single reader any more"; FAIL=1; }
grep -qE "Keychain\.get\(refreshKey\) \?\? UserDefaults\.standard\.string\(forKey: refreshKey\)" <<< "$BODY" || {
  echo "  the refresh-token read is no longer Keychain-first with a UserDefaults fallback"; FAIL=1; }

# 2. EXACTLY ONE KEYCHAIN READ. A second one is a second definition.
KC=$(grep -c "Keychain.get(refreshKey)" <<< "$BODY")
[ "$KC" -eq 1 ] || { echo "  Keychain.get(refreshKey) appears $KC times — expected exactly 1 (the accessor)"; FAIL=1; }

# 3. EXACTLY TWO RAW UserDefaults READS: the accessor's fallback, and the
#    migration probe. Any third is a path that cannot see the Keychain.
UD=$(grep -c "string(forKey: refreshKey)" <<< "$BODY")
[ "$UD" -eq 2 ] || {
  echo "  string(forKey: refreshKey) appears $UD times — expected exactly 2"
  echo "  (the accessor's fallback + migrateSessionToKeychainIfNeeded). A third"
  echo "  read is a refresh path that goes blind on a Keychain-only session."
  FAIL=1; }

# 4. THE SECOND ONE IS THE MIGRATION PROBE, not some other function that
#    happened to be written the same way.
MIG=$(awk '/func migrateSessionToKeychainIfNeeded/,/^    }$/' <<< "$BODY")
grep -q "string(forKey: refreshKey)" <<< "$MIG" || {
  echo "  the allowed direct read is no longer inside migrateSessionToKeychainIfNeeded"; FAIL=1; }

# 5. EVERY CONSUMER BINDS THE ACCESSOR. Named individually so a regression
#    reports WHICH path went blind.
GVT=$(awk '/func getValidToken\(\) async -> String\?/,/^    }$/' <<< "$BODY")
grep -q "let refreshToken = storedRefreshToken" <<< "$GVT" || {
  echo "  getValidToken no longer reads the refresh token through storedRefreshToken"; FAIL=1; }

STR=$(awk '/private func scheduleTokenRefresh/,/^    }$/' <<< "$BODY")
grep -q "let refreshToken = storedRefreshToken" <<< "$STR" || {
  echo "  scheduleTokenRefresh no longer reads the refresh token through storedRefreshToken"; FAIL=1; }

CHK=$(awk '/func checkSession\(\) async/,/^    }$/' <<< "$BODY")
grep -q "let refreshToken = storedRefreshToken" <<< "$CHK" || {
  echo "  checkSession no longer reads the refresh token through storedRefreshToken"; FAIL=1; }

# 6. SIGN-OUT STILL CLEARS BOTH STORES. One reader over two stores means a
#    sign-out that clears one leaves the user signed in on the other.
OUT=$(awk '/func signOut\(\)/,/^    }$/' <<< "$BODY")
grep -q "Keychain.delete(refreshKey)" <<< "$OUT" || {
  echo "  signOut no longer deletes the Keychain refresh token"; FAIL=1; }
grep -q "removeObject(forKey: refreshKey)" <<< "$OUT" || {
  echo "  signOut no longer removes the UserDefaults refresh token"; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then
  echo "auth-refresh-store-gate: FAIL"
  exit 1
fi
echo "auth-refresh-store-gate: PASS — one Keychain-first reader; checkSession,"
echo "                    getValidToken and scheduleTokenRefresh all go through it."
exit 0
