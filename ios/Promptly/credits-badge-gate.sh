#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# credits-badge-gate.sh — THE BADGE MUST BE ABLE TO GET A NUMBER.
#
# MEASURED, 30 days of production: 2,439 users were GRANTED credits
# (/api/credits/free-grant, status 200, new_period / already_granted) and
# `credit_badge_shown` fired ONCE, for ZERO distinct users. Credits were being
# issued and the counter never drew for anybody.
#
# It was not removed, not tier-gated, and not covered by another view. The
# badge is wired into the header and `credits_metering` is "on" server-side.
# It renders `Color.clear` when the balance is nil — and the balance was
# always nil, because the only read was RevenueCat's virtual currency, which
# does not resolve CREDITS for real users.
#
# /api/credits/balance has served that number the whole time with NO CALLER in
# the app: the grant half and the display half were never connected.
set -uo pipefail
cd "$(dirname "$0")"
C="Promptly/Services/CreditsService.swift"
E="Promptly/Views/EditorView.swift"
B="Promptly/Views/CreditBadge.swift"
fail=0
note() { echo "  FAIL — $1"; fail=1; }
for f in "$C" "$E" "$B"; do
  [ -f "$f" ] || { echo "  FAIL — missing $f (a failed read is not a pass)"; exit 1; }
done

echo "credits-badge-gate:"

# ── 1. THE BADGE IS STILL IN THE HEADER ────────────────────────────────────
grep -Eq '^[[:space:]]*CreditBadge\(\)' "$E" \
  && echo "  ok   — CreditBadge is instantiated in the editor header" \
  || note "CreditBadge has no call site in EditorView — the counter is gone from the chat entirely"

# ── 2. THERE IS A SERVER FALLBACK, AND IT IS REACHED ───────────────────────
# NON-COMMENT LINES ONLY. The comment beside the fallback names the endpoint
# to explain why it exists, and a check that cannot tell an explanation from a
# call passes on the prose alone. Fourth time this pattern has bitten today.
grep -v '^[[:space:]]*//' "$C" | grep -Fq 'api/credits/balance' \
  && echo "  ok   — the client reads /api/credits/balance" \
  || note "nothing in the client calls /api/credits/balance — the endpoint that knows the granted balance has no caller"

reader="$(sed -n '/private func refreshFromServer/,/^    }/p' "$C")"
if [ -z "$reader" ]; then
  note "there is no refreshFromServer — the fallback has no implementation"
else
  # found:false with balance:0 means "no row", NOT zero credits.
  printf '%s' "$reader" | grep -Fq '(obj["found"] as? Bool) == true' \
    && echo "  ok   — it trusts \`found\`, not a bare balance of 0" \
    || note "refreshFromServer does not check \`found\` — found:false carries balance:0, and writing that states a confident zero for an unknown balance"
fi

# BOTH failure shapes of the RevenueCat read must fall through to it: the call
# that returns without our currency, and the call that throws. Either one alone
# leaves the badge blank for that half of the failures.
body="$(sed -n '/func refresh()/,/^    }/p' "$C")"
n=$(printf '%s\n' "$body" | grep -c 'await refreshFromServer()')
if [ "$n" -ge 2 ]; then
  echo "  ok   — both the empty-currency branch and the throw fall back ($n call sites)"
else
  note "refresh() falls back from only $n branch(es) — the empty read and the thrown read both leave the badge blank, so both need it"
fi

# ── 3. THE BADGE STILL DRAWS ONLY ON A REAL NUMBER ─────────────────────────
grep -Fq 'private var visibleBalance: Int? { onboarding.creditsEnabled ? shown : nil }' "$B" \
  && echo "  ok   — the badge and its impression event read one expression" \
  || note "visibleBalance changed shape — the body and credit_badge_shown can now disagree about whether a user saw a balance"

# ── 4. A NEGATIVE BALANCE IS NEVER DRAWN AS A MINUS ───────────────────────
# ~451 users can carry one until the server backfill lands: debits applied
# against grants that never landed. "-3 credits" reads as a debt the user
# cannot understand or settle, and nothing in the product can act on a
# negative — zero and below-zero both mean "you cannot render".
badge="$(sed -n '/var body: some View {/,/^    private func reportNegativeIfNeeded/p' "$B")"
printf '%s' "$badge" | grep -Fq 'let value = max(0, raw)' \
  && echo "  ok   — the drawn number is clamped at zero" \
  || note "the badge does not clamp the drawn value — a negative balance would render with a minus sign"

# DISPLAY ONLY. The stored balance must keep the real number, or the backfill
# cannot be verified against what it actually was.
if grep -v '^[[:space:]]*//' "$C" | grep -Eq 'balance = max\(0'; then
  note "CreditsService clamps the stored balance — the clamp must be display-only, or the real value is lost and the server's truth is unverifiable"
else
  echo "  ok   — the clamp is display-only; the stored balance keeps the real value"
fi

rep="$(sed -n '/private func reportNegativeIfNeeded/,/^    }/p' "$B")"
printf '%s' "$rep" | grep -Fq 'Analytics.track("credit_balance_negative", props: ["balance": raw]' \
  && echo "  ok   — credit_balance_negative logs the REAL value, not the clamped one" \
  || note "credit_balance_negative is missing, or logs the clamped value — which would hide how far below zero people are"
printf '%s' "$rep" | grep -Fq 'guard raw < 0, reportedNegative != raw else { return }' \
  && echo "  ok   — reported once per value, not once per redraw" \
  || note "the negative report has no dedup — SwiftUI re-runs a body freely, so this would count frames instead of readings"

[ "$fail" = 0 ] && echo "credits-badge-gate: PASS" || echo "credits-badge-gate: FAIL"
exit "$fail"
