import XCTest

/// THE APP AGAINST A SERVER HAVING A BAD MINUTE.
///
/// WHY THIS EXISTS AS A TEST AND NOT A SCRIPT. The first flood run was driven
/// by synthesising clicks at screen coordinates mapped through the Simulator
/// window. It was wrong in both directions: a tap meant for a suggestion row
/// opened the Account sheet, and a run that proved nothing was indistinguishable
/// from a run that proved something. Coordinates are not a contract; identifiers
/// are, and the identifier gate already holds the app and this suite to the
/// same spelling.
///
/// WHAT DRIVES THE SERVER. `scratchpad/floodproxy.js`, pointed at by the DEBUG
/// `-apiBase` argument, answers 503 / 429 / correct-but-20s-late and records
/// every request with its body and Idempotency-Key. The shell starts it and
/// reads the log; these tests assert only what is on the SCREEN, which is the
/// half a log cannot see.
///
/// THE STATE IS SEEDED, THE PATH IS REAL. State 59 renders the shipping
/// EditorView over a finished video whose job id is "snapshot-demo". A composer
/// send with a finished video above and no new clip attached routes to
/// `sendReedit` — the same call, on the same rail, a user takes.
final class FloodUITests: XCTestCase {

    private static let change = "make the captions bigger"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func floodedThread() -> UITest.Launch {
        // Pro, because the re-edit rail is walled for free and a paywall is not
        // the state under test.
        var c = UITest.Launch(tier: "pro", deviceSeen: true)
        c.entitled = true
        c.extra = ["-snapshotPayoff", "-snapshotState", "59",
                   "-apiBase", "http://127.0.0.1:8899"]
        return c
    }

    private func sendAChange(_ app: XCUIApplication) {
        let field = UITest.require(UITest.any(app, "composer.field"), "the composer field", timeout: 30)
        field.tap()
        field.typeText(Self.change)
        UITest.require(app.buttons["composer.send"], "the send button").tap()
    }

    // MARK: The words survive

    /// THE DEFECT THIS PINS. A failed change used to render "That change didn't
    /// get sent. Tap to try it again." above a single button reading "Upload a
    /// new video" — which discards the change. Both halves are asserted, because
    /// finding the retry alone would pass on a screen that also still offered
    /// the discard.
    func testASentChangeSurvivesAFlood() {
        let app = UITest.launch(floodedThread())
        UITest.require(app.buttons["video.share"], "the seeded finished video", timeout: 90)
        sendAChange(app)

        // The words are still on screen. Not "a failure card exists" — the
        // user's own sentence, which is the thing that was being lost.
        UITest.require(app.staticTexts[Self.change],
                       "the user's change, after the send failed", timeout: 30)

        // And there is a way to send it again.
        UITest.require(app.buttons["bubble.retry"],
                       "a Try Again for the failed change", timeout: 20)

        // And NOT the button that throws it away.
        UITest.requireAbsent(app.buttons["bubble.makeAnother"],
                             "\"Upload a new video\" under a failed CHANGE — that discards it",
                             settle: 2)
    }

    // MARK: Nothing goes blank

    /// A flood must not take the conversation away. The thread and the composer
    /// both stay, so the failure is a card in a conversation rather than a
    /// screen the user has to escape.
    func testTheThreadIsNeverBlankUnderAFlood() {
        let app = UITest.launch(floodedThread())
        UITest.require(app.buttons["video.share"], "the seeded finished video", timeout: 90)
        sendAChange(app)
        UITest.require(app.staticTexts[Self.change], "the user's change", timeout: 30)
        XCTAssertTrue(UITest.any(app, "composer.field").exists,
                      "the composer is gone — the failure replaced the screen")
        XCTAssertTrue(app.buttons["video.share"].exists,
                      "the finished video is gone from the thread behind the failure")
    }

    // MARK: The upload path under flood

    /// THE UPLOAD DOOR, a different rail from the re-edit above: it presigns
    /// TWICE per attempt (proxy and source, concurrently) and retries the pair
    /// on `PresignResilience.backoff`.
    ///
    /// SKIPS RATHER THAN FAILS WHEN THE PICKER CANNOT BE DRIVEN. `composer.add`
    /// presents the system photo picker, which runs OUT OF PROCESS; on this
    /// simulator no picker process starts under XCUITest at all, so the tap
    /// lands on nothing. A test that failed here would be reporting the
    /// harness, not the app, and a permanently red test is one nobody reads.
    /// The three-way split of the presign filenames is asserted by
    /// `flood-analyze.py` against the proxy log whenever a run does produce
    /// one -- including on a device, where the picker is reachable.
    func testUploadUnderFloodPresigns() throws {
        var c = UITest.Launch(tier: "pro", deviceSeen: true)
        c.entitled = true
        c.extra = ["-apiBase", "http://127.0.0.1:8899"]
        let app = UITest.launch(c)
        UITest.require(app.buttons["composer.add"], "the add-video button", timeout: 90).tap()

        let cells = app.collectionViews.cells
        guard cells.element(boundBy: 0).waitForExistence(timeout: 10),
              cells.element(boundBy: 0).isHittable else {
            throw XCTSkip("the system photo picker did not present under XCUITest "
                          + "on this simulator - no picker process started, so the "
                          + "upload rail cannot be driven here")
        }
        cells.element(boundBy: 0).tap()

        let field = UITest.require(UITest.any(app, "composer.field"), "the composer field", timeout: 30)
        field.tap()
        field.typeText("fast cuts")
        UITest.require(app.buttons["composer.send"], "the send button").tap()

        // Past the first few waits of the backoff schedule, so the log holds
        // more than one attempt.
        Thread.sleep(forTimeInterval: 30)

        XCTAssertTrue(UITest.any(app, "composer.field").exists,
                      "the composer is gone during a flooded upload")
    }

    // MARK: One intent, one key

    /// Sends the change, then taps Try Again. The shell asserts the two
    /// requests carry the SAME Idempotency-Key — a flood loses responses, not
    /// necessarily work, so a retry under a new key is a second charge.
    func testRetryReusesTheKey() {
        let app = UITest.launch(floodedThread())
        UITest.require(app.buttons["video.share"], "the seeded finished video", timeout: 90)
        sendAChange(app)
        UITest.require(app.buttons["bubble.retry"], "a Try Again", timeout: 30).tap()
        // The row is replaced by a fresh attempt carrying the same words.
        UITest.require(app.staticTexts[Self.change],
                       "the change after retrying", timeout: 30)
    }
}
