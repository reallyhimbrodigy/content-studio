#!/bin/bash
# PLAN DURATION COMES FROM THE PRODUCT, NEVER FROM PackageType.
#
# `PackageType` is RevenueCat's slot in an offering, not a property of what the
# user buys, and anything outside its known set arrives as `.custom` — which is
# how the Max products arrive. Every `packageType == .annual` test therefore
# answers "no" for Max, silently. Three separate defects shipped from this one
# root before it was named:
#   1. no savings badge on Max annual (a real 25%, withheld)
#   2. "Promptly Pro" printed twice on the live first-launch paywall
#   3. Max plans sorted last within their own tier instead of by duration
# None raised an error. So the comparison is banned outright and every site
# reads `planPeriod` from PlanPeriod.swift.
set -uo pipefail
cd "$(dirname "$0")/Promptly" || exit 1
RESOLVER="Services/PlanPeriod.swift"
[ -f "$RESOLVER" ] || { echo "plan-period-gate: MISSING $RESOLVER"; exit 1; }

# Period comparisons and switches on packageType, anywhere but the resolver.
# Comment lines are excluded. The first version of this gate flagged the doc
# comment that DESCRIBES the defect, which would have trained the next reader to
# skim past a real hit.
HITS=$(grep -rnE 'packageType (==|!=) \.(annual|monthly|weekly)|switch [A-Za-z_.?]*\.packageType' \
       --include="*.swift" . 2>/dev/null \
       | grep -v "$RESOLVER" \
       | grep -vE ':[0-9]+:[[:space:]]*(//|///|\*)' || true)
if [ -n "$HITS" ]; then
  echo "plan-period-gate: FAIL — duration read from packageType:"
  echo "$HITS" | sed 's/^/  /'
  echo "  Use pkg.planPeriod / pkg.isAnnualPlan (PlanPeriod.swift). Max is .custom."
  exit 1
fi
echo "plan-period-gate: PASS — duration is derived from the product everywhere"
exit 0
