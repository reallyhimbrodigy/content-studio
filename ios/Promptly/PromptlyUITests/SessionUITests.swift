import XCTest

/// SIGN-IN, SIGN-OUT, AND THE CREDIT BANNER'S BINDING.
final class SessionUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func openAccount(_ app: XCUIApplication,
                             file: StaticString = #filePath, line: UInt = #line) {
        UITest.require(app.buttons["nav.sidebar"], "the sidebar toggle",
                       file: file, line: line).tap()
        UITest.require(app.buttons["nav.account"], "the account bar",
                       file: file, line: line).tap()
    }

    // MARK: An anonymous session is offered an account, not a log-out

    /// The row's LABEL changes with the viewer, so the identifier does too —
    /// `account.signin` against `account.signout`. Asserting the wrong one is
    /// how a test passes while the app offers a signed-out user "Log out".
    func testAnonymousSessionIsOfferedAnAccount() {
        let app = UITest.launch(UITest.Launch(deviceSeen: true))
        openAccount(app)
        UITest.require(app.buttons["account.signin"],
                       "the sign-in row for an anonymous session")
        UITest.requireAbsent(app.buttons["account.signout"],
                             "a Log out row for someone with no account", settle: 2)
    }

    // MARK: Every account page keeps its irreversible action reachable and separate

    func testDeleteAccountIsPresentAndNotTheSessionRow() {
        let app = UITest.launch(UITest.Launch(deviceSeen: true))
        openAccount(app)
        let del = UITest.require(app.buttons["account.delete"], "the delete-account row")
        // A DISTINCT CONTROL, not a mode of the session row. They sit next to
        // each other and one is reversible while the other is not.
        XCTAssertFalse(del.frame.equalTo(app.buttons["account.signin"].frame),
                       "delete and the session row resolve to the same control")
    }

    // MARK: Sign-in is reachable from the account page and can be backed out of

    func testSignInSheetOpensAndCloses() {
        let app = UITest.launch(UITest.Launch(deviceSeen: true))
        openAccount(app)
        UITest.require(app.buttons["account.signin"], "the sign-in row").tap()
        // The real sign-in surface, by identifier rather than by a copy match —
        // these did not exist until the identifier gate found the suite leaning
        // on a "label CONTAINS sign" fallback.
        UITest.require(app.buttons["auth.apple"], "Sign in with Apple")
        XCTAssertTrue(app.buttons["auth.google"].exists, "no Google option")
        XCTAssertTrue(app.textFields["auth.email"].exists, "no email field")
        // Backing out leaves the user where they were, still anonymous —
        // deferred auth gates one seam and this is not it.
        app.swipeDown(velocity: .fast)
        UITest.require(app.buttons["account.signin"],
                       "the account page after dismissing sign-in")
    }

    // MARK: The credit banner is bound to the balance, not to a snapshot

    func testCreditBannerAppearsAtZero() {
        var c = UITest.Launch(deviceSeen: true)
        c.extra = ["-snapshotPayoff", "-snapshotState", "42"]
        let app = UITest.launch(c)
        UITest.require(app.buttons["credits.banner"], "the banner at zero balance", timeout: 30)
    }

    func testCreditBannerIsAbsentWithBalance() {
        var c = UITest.Launch(deviceSeen: true)
        // State 59 is the same real editor over a thread, with the balance left
        // where the harness puts it rather than posed to zero.
        c.extra = ["-snapshotPayoff", "-snapshotState", "59", "-poseCredits", "40"]
        let app = UITest.launch(c)
        UITest.require(app.buttons["video.share"], "the thread", timeout: 30)
        UITest.requireAbsent(app.buttons["credits.banner"],
                             "the out-of-credits banner for a user with 40 credits")
    }

    /// THE ONE THAT MATTERS. Appearing is a launch-time state and the two tests
    /// above cover it. Clearing is the claim: the banner is bound to the
    /// published balance, not to a snapshot taken when the view was built.
    /// Nothing a user taps moves the balance — the grant lands from the server,
    /// asynchronously, after a top-up. `-poseCreditsGrantAfter` is exactly that
    /// event: the balance moves on its own, mid-session.
    func testCreditBannerClearsWhenTheBalanceArrives() {
        var c = UITest.Launch(deviceSeen: true)
        c.extra = ["-snapshotPayoff", "-snapshotState", "42",
                   "-poseCreditsGrantAfter", "6", "100"]
        let app = UITest.launch(c)
        let banner = UITest.require(app.buttons["credits.banner"],
                                    "the banner at zero balance", timeout: 30)
        // It was there; now the grant lands.
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: banner, handler: nil)
        waitForExpectations(timeout: 25) { err in
            XCTAssertNil(err, "the banner did not clear when the balance arrived — "
                         + "it is a snapshot taken at build time, not a binding")
        }
        // And the thread is still there, which is the other half of the ruling:
        // the banner was never a screen that replaced the conversation.
        XCTAssertTrue(app.buttons["composer.add"].exists,
                      "the composer went with the banner")
    }
}
