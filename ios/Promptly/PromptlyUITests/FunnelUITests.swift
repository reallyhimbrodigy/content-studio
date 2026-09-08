import XCTest

/// THE FIRST-RUN FUNNEL, END TO END, WITH NOTHING POSED BUT THE ADMISSION.
///
/// The funnel is the one flow that needs no data harness: a first install
/// answers real questions and lands in a real chat. Every other flow has been
/// "proven" by a screenshot of a posed state, which shows what the app looks
/// like rather than that it works.
///
/// What IS posed is admission — `-poseFreshInstall`. The signals that define a
/// first install live in the Keychain, which survives uninstall and cannot be
/// cleared from inside a test run; only `simctl erase` does that, and the RULE
/// is already proven that way, three cases on an erased device with the verdict
/// read from a settled log line. These tests are about what the funnel does
/// once a user is admitted to it.
final class FunnelUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// A genuine first install, plus a reset of the completion flag.
    ///
    /// `hasCompletedOnboarding` lives in UserDefaults and survives the launch,
    /// so a test that walks the funnel leaves the next one looking at a
    /// completed one — which is exactly how the second test here first failed,
    /// on "Q1 never appeared", entirely because of the order they ran in.
    private func freshInstall() -> UITest.Launch {
        var c = UITest.Launch()
        c.firstRunSeen = false
        c.deviceSeen = false
        c.extra = ["-firstRunReset", "-poseFreshInstall", "-resetOnboarding"]
        return c
    }

    // MARK: Q1 asks, and gates Continue on an answer

    func testFirstQuestionGatesContinueUntilAnswered() {
        let app = UITest.launch(freshInstall())
        UITest.require(app.staticTexts["Who are you making videos for?"], "Q1", timeout: 40)
        let cont = UITest.require(app.buttons["onboarding.continue"], "Continue on Q1")
        // A RULE, NOT A STYLE, so it is asserted BEFORE answering rather than
        // noticed after: a required question must not be skippable by Continue.
        XCTAssertFalse(cont.isEnabled, "Continue is enabled before any answer on a required question")
        UITest.require(app.buttons["onboarding.option.myself"], "the Myself option").tap()
        XCTAssertTrue(cont.isEnabled, "Continue stayed disabled after an answer")
        cont.tap()
        UITest.require(app.staticTexts["What kind of videos do you make?"],
                       "Q2 — so the step actually advanced")
    }

    // MARK: Skip is a real exit

    func testSkipAdvancesWithoutAnswering() {
        let app = UITest.launch(freshInstall())
        UITest.require(app.staticTexts["Who are you making videos for?"], "Q1", timeout: 40)
        UITest.require(app.buttons["onboarding.skip"], "Skip on Q1").tap()
        UITest.require(app.staticTexts["What kind of videos do you make?"],
                       "Q2 after skipping Q1")
    }

    // MARK: The whole funnel terminates in a chat

    /// THE ONE THAT MATTERS. If this breaks, every new user is lost before they
    /// reach the product, and no unit test anywhere would notice.
    ///
    /// Deliberately GENERIC: it does not hard-code the rung list. The sequence
    /// is audience → videoType → attribution → paywall → reveal → referralCatch
    /// → done today, and it has been restructured twice — a test that names
    /// each rung would break on the next restructure while the funnel still
    /// worked, which teaches everyone to ignore it. Walking whatever is on
    /// screen keeps the claim ("a new user can get through") stable across the
    /// rungs changing underneath it.
    func testFunnelTerminatesInChat() {
        let app = UITest.launch(freshInstall())
        UITest.require(app.staticTexts["Who are you making videos for?"], "Q1", timeout: 40)

        let composer = app.buttons["composer.add"]
        var lastRung = "Q1"
        for step in 1...12 {
            if composer.waitForExistence(timeout: 3) { break }
            // Answer if there is anything to answer, then take whichever exit
            // the rung offers, in the order a user would reach for.
            let option = app.buttons.matching(
                NSPredicate(format: "identifier BEGINSWITH %@", "onboarding.option.")).firstMatch
            if option.exists && option.isHittable { option.tap() }
            for id in ["onboarding.continue", "onboarding.skip",
                       "paywall.close", "onboarding.exit"] {
                let b = app.buttons[id]
                if b.exists && b.isHittable && b.isEnabled { b.tap(); lastRung = id; break }
            }
            // A rung with no control we recognise: name it rather than time out
            // silently, so the failure says WHERE the funnel stopped.
            if step == 12 {
                XCTFail("the funnel never reached the chat — last control taken was "
                        + "\(lastRung); the rung on screen offers none of "
                        + "onboarding.continue / onboarding.skip / paywall.close "
                        + "/ onboarding.exit")
            }
        }
        XCTAssertTrue(composer.exists,
                      "the funnel did not end in a chat — last control taken was \(lastRung)")
    }
}
