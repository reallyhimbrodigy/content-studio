#!/bin/bash
# THE OFFER LADDER LIVES IN THE FUNNEL, AND NOWHERE ELSE (ruled 2026-09-05).
#
# Q1 → Q2 → soft paywall → reveal → invite → chat. The credit wall is top-up
# only. No in-app entry point (Upgrade pill, export gate, re-edit, usage limit)
# may fire the ladder, and the credit-wall close may not raise it either.
#
# This gate proves three things about the source, so the ruling can't silently
# invert again the way it already did once:
#   1. UpgradePaywall — every in-app paywall entry — does NOT reach the ladder.
#   2. The FUNNEL (OnboardingV2Flow) DOES host it.
#   3. The credit wall does NOT (no `credit_wall` exit-offer trigger anywhere).
set -uo pipefail
cd "$(dirname "$0")"
python3 - <<'PYEOF'
import re, subprocess, sys

# 1) UpgradePaywall presents paywalls only.
src = open("Promptly/Views/UpgradePaywall.swift").read()
m = re.search(r'\nstruct UpgradePaywall: View \{(.*?)\n\}\n', src, re.S)
if not m:
    print("exit-ladder-scope-gate: FAIL — cannot find `struct UpgradePaywall`"); sys.exit(1)
body = "\n".join(l for l in m.group(1).splitlines() if not l.strip().startswith("//"))
hits = [b for b in ["OfferRevealView", "ExitOfferLadder", "ReferralCatchBeat", "ExitOffer."] if b in body]
if hits:
    print(f"exit-ladder-scope-gate: FAIL — UpgradePaywall reaches the exit ladder: {', '.join(hits)}")
    print("  Every in-app entry constructs this view; the ladder belongs to the funnel.")
    sys.exit(1)

# 2) The funnel hosts the ladder, after the soft paywall.
funnel = open("Promptly/Views/Onboarding/OnboardingV2Flow.swift").read()
if "ExitOfferLadder" not in funnel and "OfferRevealView" not in funnel:
    print("exit-ladder-scope-gate: FAIL — the funnel (OnboardingV2Flow) does not host the ladder.")
    print("  Ruling: reveal → invite go in the funnel after the soft paywall.")
    sys.exit(1)
if ".reveal" not in funnel or ".paywall" not in funnel:
    print("exit-ladder-scope-gate: FAIL — the funnel lost its paywall/reveal beats.")
    sys.exit(1)

# 3) The credit wall is top-up only — no `credit_wall` exit-offer trigger.
out = subprocess.run(["grep", "-rn", 'ExitOffer.record("credit_wall")', "Promptly"],
                     capture_output=True, text=True)
live = [l for l in out.stdout.splitlines() if l.strip() and not l.split(":")[0].split("/")[-1].startswith("__")]
if live:
    print("exit-ladder-scope-gate: FAIL — the credit wall still raises the ladder:")
    for l in live: print("   ", l[:120])
    print("  Ruling: the credit wall goes to top-up only.")
    sys.exit(1)

# Every remaining exit-offer trigger is declared (only the DEBUG capture path).
out = subprocess.run(["grep", "-rln", "ExitOffer.record(", "Promptly"], capture_output=True, text=True)
spenders = {f for f in out.stdout.split() if f.strip() and not f.split("/")[-1].startswith("__")}
ALLOWED = {"Promptly/Views/AppShell.swift"}   # the -showLadder harness capture, DEBUG only
undeclared = spenders - ALLOWED
if undeclared:
    print(f"exit-ladder-scope-gate: FAIL — undeclared exit-offer trigger(s): {', '.join(sorted(undeclared))}")
    sys.exit(1)

print("exit-ladder-scope-gate: PASS — ladder in the funnel only; UpgradePaywall and the credit wall are clear")
PYEOF
