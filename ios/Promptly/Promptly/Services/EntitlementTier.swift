import Foundation

/// The user's effective entitlement tier under the trial-wall model (Release N+1).
/// The case order IS the privilege order: `none < trial < paid`.
///   - `none`  — no active entitlement → the wall (pre-trial or lapsed).
///   - `trial` — an active free trial → today's free limits (limited tier).
///   - `paid`  — full Pro.
///
/// Pure and dependency-free (Foundation only, no RevenueCat/SwiftUI) so the
/// composition rule below compiles and unit-tests standalone with `swiftc`
/// (see `Tests/run.sh`). Tier disagreements are exactly where this app's billing
/// history says reality pokes, so the rule is written here, not assumed at each
/// call site.
enum EntitlementTier: Int, Comparable {
    case none = 0
    case trial = 1
    case paid = 2

    static func < (lhs: EntitlementTier, rhs: EntitlementTier) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    /// Compose the two INDEPENDENT tier signals into one effective tier:
    ///   - `rc`     — derived from RevenueCat's client-side CustomerInfo
    ///                (`entitlements["pro"].isActive` + `periodType`).
    ///   - `server` — the `tier` field on the `/api/usage` snapshot.
    ///
    /// RULE (explicit, not implicit): **MOST-PRIVILEGED WINS — paid > trial > none.**
    ///
    /// A disagreement means the two sources are momentarily out of sync: the
    /// webhook lagging a just-started trial, RC seeing a purchase before the
    /// server does, or a stale cache on either side. Resolving to whichever
    /// source grants MORE keeps a paying or trialing user from being under-served
    /// by a stale signal — the same fail-generous philosophy as the server's
    /// unknown-period→paid edge. (When BOTH sources agree the entitlement is gone,
    /// it's gone — `resolve(.none, .none) == .none`, the wall.)
    static func resolve(rc: EntitlementTier, server: EntitlementTier) -> EntitlementTier {
        max(rc, server)
    }

    /// Parse the server's `/api/usage` `tier` string. Unknown / missing → `.none`
    /// (the server signal alone fails closed; the RC signal can still lift it
    /// through `resolve`). Case-insensitive; tolerant of whitespace.
    static func fromServer(_ raw: String?) -> EntitlementTier {
        switch (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "paid":  return .paid
        case "trial": return .trial
        default:      return .none
        }
    }
}

// MARK: - Capabilities — the tier × capability truth table (Wall Correctness
// item 1), mirrored cell-for-cell from lib/tier-capabilities.js on the server.
// Every cell has a test in EntitlementTierTests. The SERVER is authoritative
// (it enforces); the client uses these to gate UI and route to wall vs paywall.

extension EntitlementTier {
    struct Capabilities: Equatable {
        let appUsable: Bool
        let uploadMax: Int
        let renderLimit: Int   // Int.max == unlimited
        let chatLimit: Int
        let reedit: Bool
        let lumen: Bool
        let limitHitRouting: LimitRouting
    }
    /// Where a DENIED action routes the UI: the pre-trial wall (`.none`), the
    /// upgrade paywall (`.trial` hitting a cap), or nothing (`.paid`).
    enum LimitRouting: Equatable { case wall, paywall, unused }

    var capabilities: Capabilities {
        switch self {
        case .paid:  return Capabilities(appUsable: true,  uploadMax: 10, renderLimit: .max, chatLimit: .max, reedit: true,  lumen: true,  limitHitRouting: .unused)
        case .trial: return Capabilities(appUsable: true,  uploadMax: 1,  renderLimit: 3,    chatLimit: 50,   reedit: false, lumen: false, limitHitRouting: .paywall)
        case .none:  return Capabilities(appUsable: false, uploadMax: 0,  renderLimit: 0,    chatLimit: 0,    reedit: false, lumen: false, limitHitRouting: .wall)
        }
    }

    var appUsable: Bool { capabilities.appUsable }
    var uploadMax: Int { capabilities.uploadMax }
    var canReedit: Bool { capabilities.reedit }
    var canUseLumen: Bool { capabilities.lumen }
    var limitHitRouting: LimitRouting { capabilities.limitHitRouting }

    func canRender(todayRenders: Int) -> Bool {
        let c = capabilities
        return c.appUsable && todayRenders < c.renderLimit
    }
    func canChat(todayChats: Int) -> Bool {
        let c = capabilities
        return c.appUsable && todayChats < c.chatLimit
    }
    func canUpload(_ count: Int) -> Bool {
        let c = capabilities
        return c.appUsable && count >= 1 && count <= c.uploadMax
    }
}
