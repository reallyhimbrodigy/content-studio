#!/usr/bin/env bash
# WEB CHECKOUT GATE — the four ways this surface can take someone's money wrongly.
#
# Every assertion here is a defect that was actually live on 2026-09-07:
#   1. `StorefrontService.resolve()` had NO caller anywhere in the app, so
#      `countryCode` stayed nil, `product(for:)` failed its guard, and the step
#      could not appear on ANY storefront — with the knob armed and a correct
#      config. The non-US case still "passed", for the wrong reason.
#   2. The link carried no `package_id`, so every tap landed on a generic page
#      offering prices the user had not chosen ($19.99/$39.99 rather than the
#      annual they tapped).
#   3. Nothing compared the web price to the App Store price, so a config with
#      web ABOVE Apple rendered a sheet that preselected the dearer option and
#      captioned it "no in-app purchase fees".
#   4. The sheet named a domain this product does not own.
set -uo pipefail
cd "$(dirname "$0")"

CS=Promptly/Views/CheckoutSheet.swift
APP=Promptly/PromptlyApp.swift
SF=Promptly/Services/StorefrontService.swift
FAIL=0

for f in "$CS" "$APP" "$SF"; do
  [ -f "$f" ] || { echo "  missing $f"; exit 1; }
done

# 1. REACHABILITY. The storefront must be resolved from a live entry point.
#    Zero callers is how this shipped dark.
CALLS=$(grep -c "StorefrontService.shared.resolve()" "$APP")
if [ "$CALLS" -eq 0 ]; then
  echo "  StorefrontService.resolve() is not called from PromptlyApp — the storefront"
  echo "  never resolves, so web checkout is dark on every storefront."
  FAIL=1
fi

# 2. THE LINK. app_user_id in the PATH; package_id in the QUERY; never the reverse.
URLFN=$(awk '/static func checkoutURL/,/^    }$/' "$CS")
grep -q 'replacingOccurrences' <<< "$URLFN" || {
  echo "  checkoutURL no longer substitutes the app_user_id template"; FAIL=1; }
grep -q '"{app_user_id}"' <<< "$URLFN" || {
  echo "  checkoutURL no longer targets the {app_user_id} placeholder"; FAIL=1; }
grep -q 'URLQueryItem(name: "package_id"' <<< "$URLFN" || {
  echo "  the link carries no package_id — the checkout page cannot know what it sells"; FAIL=1; }
# app_user_id must never become a query item: that leaves the path segment empty
# and RevenueCat mints a new anonymous customer, so the purchase grants nothing.
grep -qE 'URLQueryItem\(name: "app_user_id"|queryItems.*app_user_id' <<< "$URLFN" && {
  echo "  app_user_id is being APPENDED as a query parameter — it belongs in the path"; FAIL=1; }

# 3. THE PACKAGE. Carried on the item and taken from the RevenueCat package.
grep -q "let packageId: String" "$CS" || {
  echo "  CheckoutItem no longer carries packageId"; FAIL=1; }
grep -q "packageId: pkg.identifier" "$CS" || {
  echo "  CheckoutRouter does not take the package id from the package"; FAIL=1; }

# 4. CHEAPER BY ENOUGH, OR APPLE ONLY. Fails closed on a missing number.
CHEAP=$(awk '/static func savingIsWorthClaiming/,/^    }$/' "$CS")
grep -q "guard applePrice > 0, webPrice < applePrice else { return false }" <<< "$CHEAP" || {
  echo "  savingIsWorthClaiming no longer fails closed on a price it cannot compare"; FAIL=1; }
grep -q ">= minimumClaimablePct" <<< "$CHEAP" || {
  echo "  the saving is no longer measured against the claim floor"; FAIL=1; }

# 5. NO BARE DOMAIN in the copy. The link goes wherever the config points.
BODY=$(grep -v '^\s*//' "$CS")
grep -qE '"[^"]*promptly\.com' <<< "$BODY" && {
  echo "  the checkout copy names promptly.com — not a domain this product owns"; FAIL=1; }

# 6. KEYED BY PACKAGE. The offering's keys are $rc_annual / max_yearly, never
#    promptly_pro_*. Looked up by product id every real entry misses and the
#    feature goes dark with nothing in the logs.
grep -q "func product(forPackage packageId: String)" "$SF" || {
  echo "  the web offering is no longer looked up by package id"; FAIL=1; }
grep -q "cfg.product(forPackage: pkg.identifier)" "$CS" || {
  echo "  the router does not look the package up by its package id"; FAIL=1; }
grep -qE "product\(forPackage: [a-z]*\.?storeProduct" "$CS" && {
  echo "  the router is looking up a PRODUCT id again"; FAIL=1; }

# 7. INTRO AGAINST INTRO, OR BASE AGAINST BASE. Never one of each.
ROUTER2=$(awk '/^enum CheckoutRouter/,0' "$CS")
grep -q "let useIntro = appleIntro != nil && web.webIntroPriceMicros != nil" <<< "$ROUTER2" || {
  echo "  intro pricing no longer requires BOTH sides to have one"; FAIL=1; }
grep -q "isEligibleForIntro(sp)" <<< "$ROUTER2" || {
  echo "  the Apple intro is not gated on this customer's eligibility"; FAIL=1; }

# 8. THE FLOOR. A true saving too small to claim is still not a claim.
grep -q "static let minimumClaimablePct = 5" "$CS" || {
  echo "  the 5% claim floor is gone"; FAIL=1; }
grep -q "guard savingIsWorthClaiming(applePrice: applyPrice, webPrice: webValue) else { return nil }" <<< "$ROUTER2" || {
  echo "  the router no longer applies the claim floor"; FAIL=1; }

# 9. EVERY FIGURE DERIVED. The percentage comes from the two quotes, never from
#    a configured saved_pct — the configured one read 15% over a HIGHER price,
#    then 0%, because nothing tied it to the numbers above it.
grep -q "var savedPct: Int {" "$CS" || {
  echo "  savedPct is no longer derived on the item"; FAIL=1; }
grep -qE "cfg\.savedPct|savedPct: cfg\." "$CS" && {
  echo "  the sheet is reading the CONFIGURED saved_pct again"; FAIL=1; }
grep -q "var appleFee: Decimal { max(applePrice - webPrice, 0) }" "$CS" || {
  echo "  the Apple fee is no longer derived from the two quotes"; FAIL=1; }

# 10. THE FEE LINE. Struck through with $0.00 beside it on web; live on Apple.
FEE=$(awk '/private var feeLine: some View/,/^    }$/' "$CS")
grep -q "strikethrough(true" <<< "$FEE" || {
  echo "  the web fee line no longer strikes the Apple amount through"; FAIL=1; }
grep -q "Text(money(0))" <<< "$FEE" || {
  echo "  the web fee line no longer shows \$0.00 beside it"; FAIL=1; }
grep -q "Apple service fees" <<< "$FEE" || {
  echo "  the fee line lost its neutral label"; FAIL=1; }

# 11. THE CTA names the tier AND the duration being bought.
grep -q 'Text("Get \\(item.tierNoun) · \\(item.durationNoun)")' "$CS" || {
  echo "  the CTA no longer names the tier and duration"; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then
  echo "web-checkout-gate: FAIL"
  exit 1
fi
echo "web-checkout-gate: PASS — storefront resolved, id in the path, package in the query,"
echo "                   web only when cheaper, no invented domain."
exit 0
