import Foundation

/// Pure version math (Foundation-only so it unit-tests standalone with swiftc).
/// Numeric component-wise compare: "1.3.6" < "1.3.10" — a STRING compare gets
/// that wrong ("1.3.10" < "1.3.6" lexically), which is exactly the 1.3.6-vs-
/// 1.3.10 case the contextual upload prompt exists for. Missing components
/// read 0; non-numeric junk reads 0 so a malformed server value never forces
/// anything.
enum VersionMath {
    static func isOlder(_ lhs: String, than rhs: String) -> Bool {
        let l = lhs.split(separator: ".").map { Int($0) ?? 0 }
        let r = rhs.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(l.count, r.count) {
            let a = i < l.count ? l[i] : 0
            let b = i < r.count ? r[i] : 0
            if a != b { return a < b }
        }
        return false
    }
}
