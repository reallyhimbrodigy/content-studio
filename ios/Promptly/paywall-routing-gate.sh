#!/bin/bash
# ONE SWITCH FOR THE UPGRADE PAYWALL.
#
# Upgrade, the credit wall, re-edit, the export gate, daily renders, daily chats,
# concurrency and Account all call AppState.presentPaywall(...), which sets
# `paywallReason`. That reason is rendered in exactly TWO places — AppShell's
# sheet and presentPaywallFromTop's hosting controller — and both construct
# UpgradePaywall, which reads the two_step_paywall flag. So the flag switches
# every one of those entry points together.
#
# That property is only true while nobody constructs PaywallView directly. A new
# surface that does would be permanently stuck on the old layout while every
# other entry point moved, and nothing would fail — the flag would just quietly
# mean less than it says.
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 1
FAIL=0

# 1. PaywallView may be constructed only inside UpgradePaywall (and the DEBUG
#    snapshot harness, which renders surfaces in isolation on purpose).
STRAY=$(grep -rn "PaywallView(" --include="*.swift" . 2>/dev/null \
        | grep -v "Views/UpgradePaywall.swift" \
        | grep -v "__PayoffSnapshotHarness.swift" \
        | grep -v "FirstLaunchPaywallView\|SecondPaywallView" \
        | grep -vE ':[0-9]+:[[:space:]]*(//|///|\*)' \
        | grep -v "struct PaywallView" || true)
if [ -n "$STRAY" ]; then
  echo "  PaywallView constructed outside UpgradePaywall:"
  echo "$STRAY" | sed 's/^/    /'
  FAIL=1
fi

# 2. The switch itself must still branch on the flag.
if ! grep -q "twoStepPaywallEnabled" Views/UpgradePaywall.swift; then
  echo "  UpgradePaywall no longer reads two_step_paywall"
  FAIL=1
fi

# 3. Every render of paywallReason must go through UpgradePaywall.
for f in $(grep -rl "paywallReason" --include="*.swift" . 2>/dev/null); do
  case "$f" in */Models/Models.swift) continue;; esac
  if grep -q "if let reason = appState.paywallReason" "$f" \
     && ! grep -q "UpgradePaywall(" "$f"; then
    echo "  $f renders paywallReason without UpgradePaywall"
    FAIL=1
  fi
done
if ! grep -q "UpgradePaywall(" Models/Models.swift; then
  echo "  presentPaywallFromTop no longer uses UpgradePaywall"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then echo "paywall-routing-gate: FAIL"; exit 1; fi
echo "paywall-routing-gate: PASS — one flag switches every upgrade entry point"
exit 0
