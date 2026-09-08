import XCTest

/// THE FINISHED-VIDEO SURFACE, against the real EditorView.
///
/// WHERE THE BOUNDARY IS, and why it is here. The upload and the render need a
/// real clip and a real GPU job; a simulator cannot produce either, and a test
/// that posed them would look like proof of the render path while proving
/// nothing about it. Those two stay on the device checklist.
///
/// What IS testable, and has only ever been checked by looking at screenshots:
/// the surface a user meets the moment their video lands — Share, Save,
/// Re-edit, New, and whether Re-edit is walled. The thread is seeded, but every
/// view under it is the shipping one.
final class RenderPathUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// The harness state that renders the REAL EditorView over a finished
    /// video, rather than a card mocked up to look like one.
    private func finishedVideo(tier: String) -> UITest.Launch {
        var c = UITest.Launch(tier: tier == "free" ? nil : tier, deviceSeen: true)
        c.extra = ["-snapshotPayoff", "-snapshotState", "59"]
        return c
    }

    // MARK: Everything a finished video offers

    func testFinishedVideoOffersEveryAction() {
        let app = UITest.launch(finishedVideo(tier: "free"))
        UITest.require(app.buttons["video.share"], "the Share button", timeout: 30)
        XCTAssertTrue(app.buttons["video.action.save"].exists, "no Save action")
        XCTAssertTrue(app.buttons["video.action.new"].exists, "no New action")
        // The composer stays reachable underneath — the video is a message in a
        // conversation, not a terminal screen.
        XCTAssertTrue(app.buttons["composer.add"].exists,
                      "the composer is gone behind the finished video")
    }

    // MARK: Re-edit is walled for free, open for Pro

    func testReeditIsWalledForFree() {
        let app = UITest.launch(finishedVideo(tier: "free"))
        UITest.require(app.buttons["video.share"], "the Share button", timeout: 30)
        XCTAssertTrue(app.buttons["video.action.reedit.locked"].exists,
                      "Re-edit is not walled for a free viewer")
        UITest.requireAbsent(app.buttons["video.action.reedit"],
                             "an unlocked Re-edit for a free viewer", settle: 2)
    }

    func testReeditIsOpenForPro() {
        let app = UITest.launch(finishedVideo(tier: "pro"))
        UITest.require(app.buttons["video.share"], "the Share button", timeout: 30)
        XCTAssertTrue(app.buttons["video.action.reedit"].exists,
                      "Re-edit is still walled for a subscriber")
        UITest.requireAbsent(app.buttons["video.action.reedit.locked"],
                             "a locked Re-edit for a subscriber", settle: 2)
    }

    // MARK: The out-of-credits banner is a banner, not a screen

    /// Ruled 2026-09-05: the exhausted state is a line above the composer with
    /// the conversation still visible behind it, not a screen that replaces the
    /// thread. State 42 is the real EditorView with the balance posed to zero.
    func testOutOfCreditsIsABannerOverTheComposer() {
        var c = UITest.Launch(deviceSeen: true)
        c.extra = ["-snapshotPayoff", "-snapshotState", "42"]
        let app = UITest.launch(c)
        UITest.require(app.buttons["credits.banner"], "the out-of-credits banner", timeout: 30)
        // BOTH of these, because the whole ruling is that the banner does not
        // take the thread away: a test that only found the banner would pass on
        // the screen it replaced.
        XCTAssertTrue(app.buttons["composer.add"].exists,
                      "the composer is gone — the banner replaced the screen again")
        XCTAssertTrue(app.buttons["video.share"].exists,
                      "the conversation is gone from behind the banner")
    }
}
