import XCTest

/// THE MONEY PATH, BY EXECUTION.
///
/// paywall → plan tap → checkout sheet → both payment rows → the held tier →
/// restore. Everything up to Apple's own purchase sheet, which is the honest
/// boundary: StoreKit Test can complete a transaction locally, but RevenueCat
/// validates receipts against its backend and a local test transaction is not
/// one — so "purchase grants the entitlement" is a device claim and is left to
/// the device checklist rather than faked here.
///
/// Prices come from PromptlyUITests/Promptly.storekit, which carries App Store
/// Connect's own US numbers. The assertions below name real figures on purpose:
/// a test that only checks a row EXISTS would have passed while Max Year was
/// captured $2.38 off Apple's price.
final class MoneyPathUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    // MARK: Reaching the paywall

    /// Opens the paywall from the editor and waits for it to RESOLVE.
    ///
    /// `paywall.holding` is the deliberate spinner shown until the knobs and
    /// the offering have settled — a paywall asserted against while holding is
    /// a paywall asserted against before it has decided what to sell.
    @discardableResult
    private func openPaywall(_ app: XCUIApplication,
                             file: StaticString = #filePath,
                             line: UInt = #line) -> XCUIApplication {
        UITest.require(app.buttons["nav.upgrade"], "the Upgrade pill", file: file, line: line).tap()
        let holding = app.otherElements["paywall.holding"]
        let year = app.buttons["paywall.duration.promptly_pro_yearly"]
        let heldYear = app.buttons["paywall.duration.promptly_pro_yearly.held"]
        let deadline = Date().addingTimeInterval(40)
        while Date() < deadline {
            if year.exists || heldYear.exists { return app }
            if !holding.exists && !year.exists && !heldYear.exists {
                // Neither holding nor resolved — give it a moment before
                // calling it, so a frame between the two is not a failure.
                usleep(400_000)
                continue
            }
            usleep(400_000)
        }
        XCTFail("the paywall never resolved — still holding after 40s, so the "
                + "offering or the knobs did not settle", file: file, line: line)
        return app
    }

    // MARK: 1. The paywall resolves and sells the real products

    func testPaywallResolvesWithRealProducts() {
        let app = UITest.launch(UITest.Launch(deviceSeen: true))
        openPaywall(app)
        for id in ["promptly_pro_yearly", "promptly_pro_monthly", "promptly_pro_weekly"] {
            XCTAssertTrue(app.buttons["paywall.duration.\(id)"].exists,
                          "the paywall does not offer \(id)")
        }
        // The prices are the StoreKit configuration's, which are ASC's. If this
        // ever reads $289.99 the config has fallen back to the old schedule.
        XCTAssertTrue(app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "349.99")).firstMatch.exists,
            "the annual row does not show Apple's $349.99")
    }

    // MARK: 2. A plan tap selects, and the CTA names what it will buy

    func testPlanTapSelectsAndCTANamesTheTier() {
        let app = UITest.launch(UITest.Launch(deviceSeen: true))
        openPaywall(app)
        let month = app.buttons["paywall.duration.promptly_pro_monthly"]
        UITest.require(month, "the monthly row").tap()
        XCTAssertTrue(month.isSelected, "tapping the monthly row did not select it")
        let cta = UITest.require(app.buttons["paywall.cta"], "the paywall CTA")
        XCTAssertTrue(cta.isEnabled, "the CTA is disabled with a plan selected")
    }

    // MARK: 3. The tier they already hold is not for sale

    func testHeldTierIsNotForSale() {
        let app = UITest.launch(UITest.Launch(tier: "pro", entitled: true, deviceSeen: true))
        // A SUBSCRIBER HAS NO UPGRADE PILL, which is correct and is why this
        // test cannot use the same route as the others — the first version did
        // and failed on "never appeared: the Upgrade pill", reporting the app's
        // right behaviour as a defect. Asserted here so the absence is a claim
        // rather than an obstacle, then in through the account page, which is
        // the route a Pro user actually has.
        UITest.requireAbsent(app.buttons["nav.upgrade"],
                             "the Upgrade pill, which must not be shown to a subscriber")
        UITest.require(app.buttons["nav.sidebar"], "the sidebar toggle").tap()
        UITest.require(app.buttons["nav.account"], "the account bar").tap()
        UITest.require(app.buttons["account.upgrade"], "the account page's Upgrade row").tap()
        // IT OPENS ON MAX, because Max is what is for sale to a Pro subscriber —
        // the row preselects the upgrade target. The second version of this test
        // asserted the Pro rows without switching tabs and failed on a paywall
        // that was behaving correctly. Switching to Pro is the point: the tier
        // they already hold has to be visible and refused, not merely absent.
        UITest.require(app.buttons["paywall.tier.max"], "the Max tab, preselected for a Pro viewer")
        UITest.require(app.buttons["paywall.tier.pro"], "the Pro tab").tap()
        _ = app.buttons["paywall.duration.promptly_pro_yearly.held"].waitForExistence(timeout: 20)
        // Held rows carry `.held` in the identifier rather than the words "Your
        // plan", so this asserts state and not one of eleven translations.
        XCTAssertTrue(app.buttons["paywall.duration.promptly_pro_yearly.held"].exists,
                      "a Pro subscriber's annual row is still being sold to them")
        UITest.requireAbsent(app.buttons["paywall.cta"],
                             "the purchase CTA on a tier the viewer already holds")
        // Terms and Privacy stay, because they are required on the surface
        // whether or not there is anything to buy.
        XCTAssertTrue(app.buttons["Terms of Use"].exists || app.staticTexts["Terms of Use"].exists,
                      "Terms of Use disappeared with the CTA")
    }

    // MARK: 4. The seam sits BEFORE the sheet

    func testAnonymousPlanTapPresentsSignInBeforeCheckout() {
        let app = UITest.launch(UITest.Launch(deviceSeen: true))
        openPaywall(app)
        UITest.require(app.buttons["paywall.duration.promptly_pro_yearly"], "the annual row").tap()
        UITest.require(app.buttons["paywall.cta"], "the paywall CTA").tap()
        // THE ORDER IS THE POINT. An anonymous user signs in FIRST; the checkout
        // sheet must not be reachable before that. The web link carries
        // app_user_id in its PATH, so a sheet composed before the identity
        // resolves attaches the purchase to the anonymous customer.
        UITest.requireAbsent(app.staticTexts["checkout.title"],
                             "the checkout sheet, which must not appear before sign-in")
        XCTAssertTrue(app.buttons["auth.apple"].exists
                        || app.buttons["auth.google"].exists
                        || app.textFields["auth.email"].exists
                        || app.staticTexts.containing(
                            NSPredicate(format: "label CONTAINS[c] %@", "sign")).firstMatch.exists,
                      "no sign-in surface appeared for an anonymous user tapping a plan")
    }

    // MARK: 5. The account page's money rows

    func testAccountOffersRestoreAndRate() {
        let app = UITest.launch(UITest.Launch(deviceSeen: true))
        // Account is a sheet from the sidebar drawer, so the drawer opens first.
        UITest.require(app.buttons["nav.sidebar"], "the sidebar toggle").tap()
        UITest.require(app.buttons["nav.account"], "the account bar in the drawer").tap()
        XCTAssertTrue(app.buttons["account.row.restore_purchases"].waitForExistence(timeout: 10),
                      "no Restore purchases row — App Review requires it")
        XCTAssertTrue(app.buttons["account.row.rate_promptly"].exists,
                      "no Rate Promptly row")
    }
}
