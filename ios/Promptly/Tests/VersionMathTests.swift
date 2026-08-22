import Foundation

// Standalone tests for VersionMath — the numeric version compare behind the
// update prompts. The trap it guards: "1.3.6" vs "1.3.10" — a STRING compare
// sorts 1.3.10 first, which would tell 1.3.10 users to "update" to 1.3.6.

var failures = 0
var checks = 0

func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}

@main
struct VersionMathTestMain {
static func main() {

check(VersionMath.isOlder("1.3.6", than: "1.3.10"), "1.3.6 IS older than 1.3.10 (numeric, not string, compare)")
check(!VersionMath.isOlder("1.3.10", than: "1.3.6"), "1.3.10 is NOT older than 1.3.6")
check(!VersionMath.isOlder("1.3.10", than: "1.3.10"), "equal versions are not older")
check(VersionMath.isOlder("1.3", than: "1.3.1"), "missing components read as 0")
check(!VersionMath.isOlder("1.3.0", than: "1.3"), "trailing zero equals the short form")
check(VersionMath.isOlder("1.3.9", than: "2.0"), "major bump wins")
check(!VersionMath.isOlder("1.3.10", than: ""), "empty threshold never marks outdated")
check(!VersionMath.isOlder("1.3.10", than: "garbage"), "malformed threshold (reads 0.0.0) never marks outdated")

print("\n\(checks) checks, \(failures) failures")
if failures > 0 { exit(1) }

}
}
