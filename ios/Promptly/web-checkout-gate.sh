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

# 4. CHEAPER, OR APPLE ONLY. Fails closed on a missing number.
ROUTER=$(awk '/^enum CheckoutRouter/,0' "$CS")
grep -q "guard webIsCheaper(web, than: sp.price) else { return nil }" <<< "$ROUTER" || {
  echo "  the router no longer requires the web price to be below the App Store price"; FAIL=1; }
CHEAP=$(awk '/static func webIsCheaper/,/^    }$/' "$CS")
grep -q "guard let micros = web.webPriceMicros else { return false }" <<< "$CHEAP" || {
  echo "  webIsCheaper no longer fails closed when there is no price to compare"; FAIL=1; }
grep -q "< applePrice" <<< "$CHEAP" || {
  echo "  webIsCheaper is not a strict comparison against the App Store price"; FAIL=1; }

# 5. NO BARE DOMAIN in the copy. The link goes wherever the config points.
BODY=$(grep -v '^\s*//' "$CS")
grep -qE '"[^"]*promptly\.com' <<< "$BODY" && {
  echo "  the checkout copy names promptly.com — not a domain this product owns"; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then
  echo "web-checkout-gate: FAIL"
  exit 1
fi
echo "web-checkout-gate: PASS — storefront resolved, id in the path, package in the query,"
echo "                   web only when cheaper, no invented domain."
exit 0
