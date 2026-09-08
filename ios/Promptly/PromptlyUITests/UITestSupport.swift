import XCTest

/// Shared launch + navigation helpers for the UI suite.
///
/// EVERY TEST LAUNCHES A KNOWN APP. The states these tests assert — a held
/// tier, an entitled user, a first install — are otherwise decided by a live
/// entitlement, a Keychain that survives between runs, and a server flag. A
/// suite that reads whichever of those happens to be true is not a test, it is
/// a screenshot with an assertion attached.
enum UITest {

    /// Launch arguments that make a run deterministic. All of them are DEBUG
    /// seams that already existed for the capture harness; none is new surface.
    struct Launch {
        var tier: String?          // -poseTier free|pro|max
        var entitled = false       // -poseEntitled  (effectiveIsPro true)
        var deviceSeen: Bool?      // -poseDeviceSeen / -poseDeviceNew
        var firstRunSeen = true    // -firstRunSeen — skip the funnel unless asked
        var extra: [String] = []

        var arguments: [String] {
            var a = ["-uiTest"]
            if let tier { a += ["-poseTier", tier] }
            if entitled { a.append("-poseEntitled") }
            if let deviceSeen { a.append(deviceSeen ? "-poseDeviceSeen" : "-poseDeviceNew") }
            if firstRunSeen { a.append("-firstRunSeen") }
            return a + extra
        }
    }

    @discardableResult
    static func launch(_ config: Launch = Launch()) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = config.arguments
        app.launch()
        return app
    }

    /// Look an identifier up ACROSS ELEMENT TYPES.
    ///
    /// `.accessibilityElement(children: .combine)` changes what an identified
    /// view resolves to — a combined HStack of two Texts is no longer a
    /// staticText — so a query typed to one kind starts missing it for a reason
    /// that has nothing to do with the app being wrong. Looking it up by
    /// identifier alone is the honest question.
    ///
    /// `.element` and NOT `.firstMatch`: it throws on multiple matches, which
    /// is exactly the ambiguity worth surfacing. firstMatch would quietly pick
    /// one and the test would pass while resolving against two elements — the
    /// failure the identifier gate exists to prevent, reintroduced in the
    /// suite's own lookup.
    static func any(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).element
    }

    /// Wait for an element, failing with the identifier rather than a bare
    /// "false is not true" — a suite nobody can read is a suite nobody fixes.
    @discardableResult
    static func require(_ element: XCUIElement,
                        _ what: String,
                        timeout: TimeInterval = 20,
                        file: StaticString = #filePath,
                        line: UInt = #line) -> XCUIElement {
        if !element.waitForExistence(timeout: timeout) {
            XCTFail("never appeared: \(what)", file: file, line: line)
        }
        return element
    }

    /// Assert an element is ABSENT and stays absent. `!exists` a millisecond
    /// after launch proves nothing — the thing may simply not have rendered
    /// yet, which is how a suppression test passes for the wrong reason.
    static func requireAbsent(_ element: XCUIElement,
                              _ what: String,
                              settle: TimeInterval = 3,
                              file: StaticString = #filePath,
                              line: UInt = #line) {
        if element.waitForExistence(timeout: settle) {
            XCTFail("should not exist: \(what)", file: file, line: line)
        }
    }
}
