import XCTest

/// THE THREE SURFACES WHERE A SILENT REGRESSION COSTS MONEY.
///
/// The checkout sheet's two payment rows and the figures derived from them; the
/// account page's tier-aware rows on all three tiers; and the credit banner's
/// tap landing somewhere a user can actually buy from.
///
/// Every number asserted below is App Store Connect's own, read from its API:
/// base prices effective 2026-09-08, US intro offers live since 2026-09-06.
/// The web prices come from the live /api/health offering. Nothing here
/// asserts a figure I chose.
final class MoneySurfacesUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    // MARK: 1. The checkout sheet

    /// State 54 drives the REAL gate — CheckoutRouter's own decision on the
    /// posed config and the resolved storefront — rather than a sheet built by
    /// hand. Apple's side is posed because StoreKit does not run under the
    /// snapshot harness; it is posed at ASC's number, which is the difference
    /// between a capture of the shape and a capture of the figures.
    private func checkout(package: String, applePrice: String,
                          intro: Bool, storefront: String = "USA") -> UITest.Launch {
        var c = UITest.Launch(deviceSeen: true)
        c.extra = ["-snapshotPayoff", "-snapshotState", "54",
                   "-webCheckoutJSON", Self.offering,
                   "-posePackage", package,
                   "-poseApplePrice", applePrice,
                   "-storefront", storefront]
        if intro { c.extra.append("-poseIntro") }
        return c
    }

    func testBothPaymentRowsAndTheDerivedFigures() {
        // Pro Year, first-time buyer: Apple's intro $174.99 against the web's
        // $144.99 — a real $30.00, a real 17%.
        let app = UITest.launch(checkout(package: "$rc_annual",
                                         applePrice: "174.99", intro: true))
        UITest.require(app.buttons["checkout.web"], "the Pay on the web row", timeout: 30)
        XCTAssertTrue(app.buttons["checkout.apple"].exists, "the Pay in-app row is missing")

        // THE FIGURES, not just the rows. A test that only found two rows would
        // pass against a sheet quoting the wrong prices, which is the failure
        // that actually costs money.
        // Combined into one element, so the label carries the row's words as
        // well as its figure. The FIGURE is the claim.
        let total = UITest.require(UITest.any(app, "checkout.total"), "the total")
        XCTAssertTrue(total.label.contains("144.99"),
                      "the web total is not the web price (saw: \(total.label))")
        let fee = UITest.require(UITest.any(app, "checkout.fee"), "the Apple fee line")
        XCTAssertTrue(fee.label.contains("30.00"),
                      "the Apple fee is not the difference between the two quotes "
                      + "(saw: \(fee.label))")
        // And the disclosure Apple requires is on the sheet itself.
        XCTAssertTrue(UITest.any(app, "checkout.legal").exists,
                      "the renewal disclosure and legal links are missing")
    }

    /// THE SUPPRESSION CASE, which is half the proof. Below the claim floor the
    /// step must not appear at all — a suite that only ever sees it light up
    /// cannot tell "correctly claims 17%" from "always claims something".
    func testNoCheckoutStepWhenTheSavingIsUnderTheFloor() {
        // Today's un-grossed-up price: $289.99 against $289.99 is 0%.
        let app = UITest.launch(checkout(package: "$rc_annual",
                                         applePrice: "289.99", intro: false))
        UITest.requireAbsent(app.buttons["checkout.web"],
                             "the checkout step at a saving under the 5% floor",
                             settle: 8)
    }

    func testNoCheckoutStepOffTheUSStorefront() {
        let app = UITest.launch(checkout(package: "$rc_annual",
                                         applePrice: "349.99", intro: false,
                                         storefront: "GBR"))
        UITest.requireAbsent(app.buttons["checkout.web"],
                             "the checkout step on a non-US storefront", settle: 8)
    }

    // MARK: 2. The account page, on all three tiers

    private func openAccount(_ app: XCUIApplication) {
        UITest.require(app.buttons["nav.sidebar"], "the sidebar toggle").tap()
        UITest.require(app.buttons["nav.account"], "the account bar").tap()
    }

    /// A MAX SUBSCRIBER READING "PRO" is being told they are on the tier below
    /// the one they pay for — that shipped once. The badge is asserted by
    /// identifier so the check does not depend on copy that will be localized.
    func testSubscriptionRowNamesTheTierOnAllThree() {
        for (tier, want) in [("free", "free"), ("pro", "pro"), ("max", "max")] {
            let app = UITest.launch(UITest.Launch(tier: tier == "free" ? nil : tier,
                                                  entitled: tier != "free",
                                                  deviceSeen: true))
            openAccount(app)
            UITest.require(app.buttons["account.subscription.\(want)"],
                           "the \(want.uppercased()) badge on a \(tier) account")
            for other in ["free", "pro", "max"] where other != want {
                UITest.requireAbsent(app.buttons["account.subscription.\(other)"],
                                     "the \(other.uppercased()) badge on a \(tier) account",
                                     settle: 1)
            }
            app.terminate()
        }
    }

    /// AN UPGRADE PATH ONLY WHEN ONE EXISTS. Free and Pro have somewhere to go;
    /// Max does not, and offering "Upgrade" to the top tier is a dead end that
    /// opens a paywall selling nothing.
    func testUpgradeRowOnlyWhereThereIsAnUpgrade() {
        let free = UITest.launch(UITest.Launch(deviceSeen: true))
        openAccount(free)
        UITest.require(free.buttons["account.upgrade"], "Upgrade on a free account")
        free.terminate()

        let max = UITest.launch(UITest.Launch(tier: "max", entitled: true, deviceSeen: true))
        openAccount(max)
        UITest.require(max.buttons["account.manage"],
                       "Manage subscription on a Max account")
        UITest.requireAbsent(max.buttons["account.upgrade"],
                             "an Upgrade row on the top tier", settle: 2)
    }

    // MARK: 3. The banner lands somewhere you can buy from

    /// The banner is the only route out of a zero balance. Landing on a screen
    /// with nothing chosen and a dead button would strand the one user who has
    /// already decided to spend.
    func testBannerTapLandsOnTopUpReadyToBuy() {
        // THE REAL APP, NOT THE HARNESS. The banner sets showCredits, and the
        // sheet that answers it lives on AppShell — which the harness now
        // stands down. Testing this route through the harness would have proved
        // only that a button exists. Posed balance, real everything else.
        var c = UITest.Launch(deviceSeen: true)
        c.extra = ["-poseCredits", "0"]
        let app = UITest.launch(c)
        UITest.require(app.buttons["credits.banner"], "the banner", timeout: 30).tap()

        // The top-up screen, with a pack ALREADY chosen — the screen picks a
        // default rather than waiting for a second decision.
        let packs = ["promptly_topup_5", "promptly_topup_10", "promptly_topup_20"]
        var selected: String?
        for id in packs {
            let b = app.buttons["topup.pack.\(id)"]
            if b.waitForExistence(timeout: 20) && b.isSelected { selected = id; break }
        }
        XCTAssertNotNil(selected,
                        "the top-up screen opened with no pack selected — the user "
                        + "who tapped the banner has to choose twice")
        let cta = UITest.require(app.buttons["topup.cta"], "the buy button")
        XCTAssertTrue(cta.isEnabled, "the buy button is dead on arrival")
    }

    /// The live /api/health web_checkout offering, fetched 2026-09-07. Held as
    /// a literal rather than fetched at test time on purpose: a suite whose
    /// assertions move when a server config changes reports a config edit as a
    /// client regression.
    static let offering = """
    {"storefronts":["USA"],"saved_pct":17,"intro_saved_pct":17,"products":{\
    "$rc_annual":{"web_price":"$289.99","web_price_micros":289990000,"currency":"USD",\
    "url":"https://pay.rev.cat/chnxerwypyprnctc/{app_user_id}?package_id=$rc_annual",\
    "web_intro_price":"$144.99","web_intro_price_micros":144990000,"saved_pct":17,"intro_saved_pct":17},\
    "$rc_monthly":{"web_price":"$29.99","web_price_micros":29990000,"currency":"USD",\
    "url":"https://pay.rev.cat/chnxerwypyprnctc/{app_user_id}?package_id=$rc_monthly",\
    "web_intro_price":"$14.99","web_intro_price_micros":14990000,"saved_pct":17,"intro_saved_pct":17}}}
    """
}

/// THE STOREFRONT MATRIX AND SIGN-OUT.
///
/// Split from MoneySurfacesUITests only for length; the same rule applies —
/// every figure asserted is App Store Connect's or the live offering's, never
/// one chosen here.
final class StorefrontAndSessionUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func checkout(package: String, applePrice: String,
                          intro: Bool = false, storefront: String) -> UITest.Launch {
        var c = UITest.Launch(deviceSeen: true)
        c.extra = ["-snapshotPayoff", "-snapshotState", "54",
                   "-webCheckoutJSON", MoneySurfacesUITests.offering,
                   "-posePackage", package,
                   "-poseApplePrice", applePrice,
                   "-storefront", storefront]
        if intro { c.extra.append("-poseIntro") }
        return c
    }

    // MARK: The step exists on exactly one storefront

    /// The offering names USA and nothing else. Every other storefront must get
    /// Apple only — and the reason to test more than one is that "not offered
    /// here" has to come from the OFFERING rather than from a hardcoded
    /// exception for the one country somebody happened to try.
    func testTheStepIsUSOnly() {
        for sf in ["GBR", "DEU", "IND", "AUS"] {
            let app = UITest.launch(checkout(package: "$rc_annual",
                                             applePrice: "349.99", storefront: sf))
            UITest.requireAbsent(app.buttons["checkout.web"],
                                 "the checkout step on the \(sf) storefront", settle: 6)
            app.terminate()
        }
        // And the positive control, so the four absences above are the
        // storefront gate working rather than the sheet never rendering.
        let us = UITest.launch(checkout(package: "$rc_annual",
                                        applePrice: "349.99", storefront: "USA"))
        UITest.require(us.buttons["checkout.web"],
                       "the checkout step on USA — without this the four "
                       + "absences prove nothing", timeout: 30)
    }

    // MARK: The figures are derived per package, not once

    func testDerivedFiguresPerPackage() {
        // Pro Month, returning buyer: Apple $35.99 against the web's $29.99.
        let app = UITest.launch(checkout(package: "$rc_monthly",
                                         applePrice: "35.99", storefront: "USA"))
        UITest.require(app.buttons["checkout.web"], "the checkout step", timeout: 30)
        let total = UITest.require(UITest.any(app, "checkout.total"), "the total")
        XCTAssertTrue(total.label.contains("29.99"),
                      "the monthly total is not the monthly web price (saw: \(total.label))")
        let fee = UITest.require(UITest.any(app, "checkout.fee"), "the fee line")
        XCTAssertTrue(fee.label.contains("6.00"),
                      "the fee is not $35.99 − $29.99 (saw: \(fee.label))")
    }

    // MARK: Sign-out — NOT YET COVERED, deliberately not stubbed
    //
    // The product half is done and gated (AuthService.hasRealAccount, one
    // definition, read by the account row and the purchase seam). The TEST is
    // not: `-poseSignedIn` makes hasAnonymousSession false, but hasRealAccount
    // also requires a landed `currentUser`, and the posed state does not
    // reliably produce one in time for the account page.
    //
    // Left absent rather than skipped. A skipped test reads as coverage in
    // every summary that counts tests, and the whole argument for this suite is
    // that a screenshot of a posed state is not evidence. Sign-out with a real
    // account is on the device checklist, where a real account exists.
}
