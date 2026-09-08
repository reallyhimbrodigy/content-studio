import XCTest

/// THE CREDIT TOP-UP SCREEN, against the real view and real StoreKit products.
///
/// NO PRICE IS ASSERTED HERE, and that is deliberate. The subscription prices
/// in Promptly.storekit are App Store Connect's own, read from its API — the
/// money-path suite asserts them. The three top-up consumables are not: ASC
/// gives their price TIERS (10127 / 10177 / 10277) but resolving a tier to a
/// dollar amount returns 403 on this key. Asserting a number I put in the
/// config myself would be a test of my own fixture, dressed as a test of the
/// product. The packs exist so the screen renders; the prices wait for a source.
final class TopUpUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// State 43 is the top-up screen on LIVE packages from the offering — not
    /// the posed-price states, which would prove only that a hardcoded array
    /// renders.
    private func liveTopUp() -> UITest.Launch {
        var c = UITest.Launch(deviceSeen: true)
        c.extra = ["-snapshotPayoff", "-snapshotState", "43"]
        return c
    }

    // MARK: Every configured pack reaches the screen

    /// The catalogue once matched `credits_20` while the products were
    /// `promptly_topup_20`. Neither string contains the other, so every lookup
    /// returned nil, every pack was skipped, and the screen rendered its empty
    /// state with all three products present and resolving — a silent zero
    /// rather than a visible failure. This is the test that shape needed.
    func testEveryPackReachesTheScreen() {
        let app = UITest.launch(liveTopUp())
        for id in ["promptly_topup_5", "promptly_topup_10", "promptly_topup_20"] {
            UITest.require(app.buttons["topup.pack.\(id)"], "the \(id) pack", timeout: 30)
        }
    }

    // MARK: Selecting a pack arms the CTA

    func testSelectingAPackArmsTheBuyButton() {
        let app = UITest.launch(liveTopUp())
        let ten = UITest.require(app.buttons["topup.pack.promptly_topup_10"],
                                 "the 10-pack", timeout: 30)
        ten.tap()
        let cta = UITest.require(app.buttons["topup.cta"], "the buy button")
        XCTAssertTrue(cta.isEnabled, "the buy button is disabled with a pack selected")
        XCTAssertTrue(ten.isSelected, "tapping the 10-pack did not select it")
        // And selection MOVES rather than accumulating — these are alternatives,
        // not a multi-select.
        let twenty = app.buttons["topup.pack.promptly_topup_20"]
        twenty.tap()
        XCTAssertTrue(twenty.isSelected, "the 20-pack did not take selection")
        XCTAssertFalse(ten.isSelected, "two packs are selected at once")
    }
}
