#!/usr/bin/env bash
# ONE DEFINITION OF "SIGNED IN" FOR THE PURCHASE SEAM.
#
# WHY THIS EXISTS (2026-09-07). Three places asked "is this user signed in" and
# all three asked it as `currentUser?.id != nil`. Under deferred auth every user
# gets an ANONYMOUS Supabase session at launch, with a real id — so the test was
# true for exactly the people the seam exists to stop:
#
#   AuthGate.allow / require    returned true / returned early without presenting
#   SubscriptionService.purchase its own guard passed
#   AuthSeamProbe               skipped, printing nothing, every single run
#
# The seam never fired for anyone, and the probe written to prove it by
# execution proved nothing. The guard was written for a world where a signed-out
# user had no session at all; anonymous sign-in removed that world and nothing
# noticed, because the check that would have noticed shared the same predicate.
#
# It matters most on the WEB path, where it is correctness and not just flow:
# the checkout link carries app_user_id in its PATH, so a purchase composed
# before sign-in attaches to the anonymous customer — and the
# identity_already_exists branch, where the uid genuinely changes, leaves the
# entitlement on an id the user has walked away from.
set -uo pipefail
cd "$(dirname "$0")"

G=Promptly/Services/AuthGate.swift
S=Promptly/Services/SubscriptionService.swift
P=Promptly/Services/AuthSeamProbe.swift
C=Promptly/Views/CheckoutSheet.swift
T=Promptly/Views/TwoStepPaywall.swift
for f in "$G" "$S" "$P" "$C" "$T"; do [ -f "$f" ] || { echo "  missing $f"; exit 1; }; done
FAIL=0
strip() { sed -E 's://.*::' "$1"; }

# 1. THE GATE'S PREDICATE NAMES ANONYMOUS.
GB=$(strip "$G")
grep -q "private var hasRealAccount: Bool" <<< "$GB" || {
  echo "  AuthGate has no named predicate — the definition is inline again"; FAIL=1; }
grep -q "!AuthService.shared.hasAnonymousSession" <<< "$GB" || {
  echo "  AuthGate's predicate does not exclude an anonymous session, so it is"
  echo "  true for every user under deferred auth"; FAIL=1; }
for fn in allow require; do
  B=$(awk "/func $fn\(/,/^    }\$/" <<< "$GB")
  grep -q "hasRealAccount" <<< "$B" || { echo "  AuthGate.$fn does not use hasRealAccount"; FAIL=1; }
done

# 2. THE PURCHASE CALL ITSELF, not only the gate in front of it. A caller other
#    than the paywall must not walk past.
PB=$(awk '/func purchase\(/,/^    }$/' <<< "$(strip "$S")")
grep -q "!AuthService.shared.hasAnonymousSession" <<< "$PB" || {
  echo "  SubscriptionService.purchase still admits an anonymous session — the"
  echo "  paywall gating before it is not the property, it is one call site"; FAIL=1; }

# 3. THE PROBE MUST NOT SKIP. It guarded on a session existing, and one always
#    does. A probe that never runs is worse than none: it reports nothing and
#    reads as covered.
if grep -qE 'guard AuthService\.shared\.currentUser\?\.id == nil else \{' <<< "$(strip "$P")"; then
  echo "  AuthSeamProbe skips whenever a session exists — under deferred auth"
  echo "  that is every run"; FAIL=1
fi
grep -q "hasAnonymousSession" <<< "$(strip "$P")" || {
  echo "  AuthSeamProbe no longer recognises an anonymous session as signed out"; FAIL=1; }

# 4. THE LINK WAITS FOR THE IDENTITY. app_user_id is in the URL PATH, so the id
#    current at composition IS the customer — there is no later correction.
CB=$(strip "$C")
OW=$(awk '/private func openWeb\(\)/,/^    }$/' <<< "$CB")
# BOTH checks, counted. The first version grepped for the comparison anywhere in
# openWeb and stayed GREEN when the fast path was replaced by `if true` — the
# post-await guard still carried the same words. An assertion satisfied by a
# DIFFERENT occurrence of itself is advisory.
OWN=$(grep -c "Purchases.shared.appUserID == uid" <<< "$OW")
[ "$OWN" -ge 2 ] || {
  echo "  openWeb checks RevenueCat's id $OWN time(s), expected 2 — the fast path"
  echo "  before awaiting, and the guard after it"; FAIL=1; }
grep -q "if Purchases.shared.appUserID == uid {" <<< "$OW" || {
  echo "  openWeb no longer short-circuits on an id that already matches"; FAIL=1; }
grep -q "guard ok, Purchases.shared.appUserID == uid else {" <<< "$OW" || {
  echo "  openWeb does not re-check the id AFTER awaiting identification"; FAIL=1; }
grep -q "ensureIdentified()" <<< "$OW" || {
  echo "  openWeb does not await identification before composing"; FAIL=1; }
grep -q "!AuthService.shared.hasAnonymousSession" <<< "$OW" || {
  echo "  openWeb would compose a link for an anonymous customer"; FAIL=1; }
# AND IT FAILS CLOSED, VISIBLY. Setting a flag nothing renders leaves the CTA
# doing nothing, which reads as broken and is worse than the bug it prevents.
grep -q "isPresented: \$identityError" <<< "$CB" || {
  echo "  the identity refusal is never shown to the user"; FAIL=1; }

# 5. THE SEAM SITS BEFORE THE SHEET, and the resume lands back in the same
#    routing rather than in Apple's.
TB=$(strip "$T")
grep -q "AuthGate.shared.allow(" <<< "$TB" || {
  echo "  the paywall does not route a plan tap through the gate"; FAIL=1; }
# THE ASSIGNMENT, not the teardown. `onPurchaseResume = ` also matches the
# `.onDisappear { ... = nil }` line, so removing the registration left this
# green — the same shape as the openWeb assertion above.
grep -qE "onPurchaseResume = \{ *productId" <<< "$TB" || {
  echo "  the paywall does not register the resume, so sign-in lands in Apple's"
  echo "  sheet instead of the checkout step the tap would have opened"; FAIL=1; }
grep -q "onPurchaseResume" <<< "$GB" || {
  echo "  AuthGate.resume no longer defers to the paywall's routing"; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then
  echo "auth-seam-predicate-gate: FAIL"
  exit 1
fi
echo "auth-seam-predicate-gate: PASS — one predicate, anonymous is not signed in,"
echo "                    the probe runs, and the link waits for the identity."
exit 0
