import XCTest

/// SMOKE — the target itself works before anything is asserted about the app.
final class MoneyPathUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testAppLaunches() {
        let app = UITest.launch()
        XCTAssertEqual(app.state, .runningForeground)
    }
}
