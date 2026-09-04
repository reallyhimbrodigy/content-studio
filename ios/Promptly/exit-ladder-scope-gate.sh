#!/bin/bash
# THE EXIT-INTENT LADDER FIRES FROM ITS OWN TRIGGERS, NEVER FROM THE IN-APP
# PAYWALL SWITCH.
#
# The catch was written for one moment — a user who has made something and is
# declining — and it was implemented inside `UpgradePaywall`. Every in-app
# entry point constructs that view: the Upgrade pill, the export gate, re-edit,
# every usage limit. So dismissing ANY of them walked reveal → downsell →
# invite, and tapping Upgrade out of curiosity handed the user a discount
# ladder. Found by tapping Upgrade, not by any check.
#
# A "is this the funnel?" parameter on that view would not have helped: the
# funnel renders `FirstLaunchPaywallView` directly and never constructs
# `UpgradePaywall`, so the flag would be false at every call site — dead code in
# the shape of a gate.
#
# So the rule is structural. Two things are asserted:
#
#   1. `UpgradePaywall` presents NOTHING but the two paywalls. No reveal, no
#      ladder, no referral beat, no staging state to reach them with.
#   2. Every site that SPENDS the offer budget is named here. A new
#      `ExitOffer.record(` anywhere else fails, so the next surface that wants
#      the ladder has to declare itself rather than inherit it.
set -uo pipefail
cd "$(dirname "$0")"

python3 - <<'PYEOF'
import re, subprocess, sys

src = open("Promptly/Views/UpgradePaywall.swift").read()

# ── 1. The switch presents only paywalls ────────────────────────────────────
m = re.search(r'\nstruct UpgradePaywall: View \{(.*?)\n\}\n', src, re.S)
if not m:
    print("exit-ladder-scope-gate: FAIL — cannot find `struct UpgradePaywall`")
    sys.exit(1)
body = "\n".join(l for l in m.group(1).splitlines() if not l.strip().startswith("//"))

BANNED = ["OfferRevealView", "ExitOfferLadder", "ReferralCatchBeat", "ExitOffer."]
hits = [b for b in BANNED if b in body]
if hits:
    print(f"exit-ladder-scope-gate: FAIL — UpgradePaywall reaches the exit ladder: {', '.join(hits)}")
    print("  Every in-app entry point constructs this view, so anything reachable")
    print("  from here fires on the Upgrade pill, the export gate, re-edit and")
    print("  every usage limit. The ladder belongs to its own triggers.")
    sys.exit(1)

# ── 2. Only declared surfaces spend the budget ──────────────────────────────
# AppShell: the credit wall's own close, plus the -showLadder debug trigger.
ALLOWED = {"Promptly/Views/AppShell.swift"}
out = subprocess.run(["grep", "-rln", "ExitOffer.record(", "Promptly"],
                     capture_output=True, text=True)
spenders = {f for f in out.stdout.split() if f.strip()
            and not f.split("/")[-1].startswith("__")}
undeclared = spenders - ALLOWED
if undeclared:
    print(f"exit-ladder-scope-gate: FAIL — undeclared exit-offer trigger(s): {', '.join(sorted(undeclared))}")
    print("  Add the surface to ALLOWED here only if it is a deliberate,")
    print("  post-value dismissal — not an incidental paywall close.")
    sys.exit(1)

print(f"exit-ladder-scope-gate: PASS — UpgradePaywall presents paywalls only; "
      f"{len(spenders)} declared trigger(s) spend the budget")
PYEOF
