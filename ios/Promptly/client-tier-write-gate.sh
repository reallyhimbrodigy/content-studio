#!/bin/bash
# The client must NEVER write a tier. Tier is server-derived: the server reads
# RevenueCat and decides. The client's only tier-shaped call is
# POST /api/revenuecat/sync, which carries an auth token and NO BODY — it asks
# the server to re-derive, it does not assert a value.
#
# Why this is a gate and not a note: a Max subscriber who trips a referral grant
# must not be rewritten to "pro". If a client ever POSTs a tier it believes in,
# a stale or lower-tier client value silently overwrites a higher entitlement,
# and the user loses the tier they pay for. Reads are fine; writes are not.
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 1
FAIL=0

# 1. No non-GET HTTP method may target the profiles table.
while read -r hit; do
  f="${hit%%:*}"
  if grep -n -A6 "rest/v1/profiles" "$f" | grep -qE 'httpMethod *= *"(POST|PATCH|PUT|DELETE)"'; then
    echo "  $f issues a non-GET against rest/v1/profiles"
    FAIL=1
  fi
done < <(grep -rl "rest/v1/profiles" --include="*.swift" . 2>/dev/null)

# 2. The client must not call the grant RPC — granting is server-owned.
if grep -rn 'rpc(function: *"grant_referral_reward"' --include="*.swift" . 2>/dev/null | grep -q .; then
  echo "  client calls grant_referral_reward; the grant is server-owned"
  FAIL=1
fi

# 3. The sync call must stay bodiless. A httpBody on the sync request would mean
#    the client had started asserting a value.
if grep -n -A12 'revenuecat/sync' Services/SubscriptionService.swift | grep -qE 'httpBody'; then
  echo "  revenuecat/sync now carries a body — it must assert no tier"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then echo "client-tier-write-gate: FAIL"; exit 1; fi
echo "client-tier-write-gate: PASS — tier is read-only on the client"
exit 0
