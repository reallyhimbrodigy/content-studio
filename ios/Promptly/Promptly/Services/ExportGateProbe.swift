import Foundation

/// The export gate's DRY-RUN verdict — SERVER_CONTRACTS_226 confirming line.
///
/// `POST /api/jobs/{id}/export {"gate_probe": true}` is evaluated BEFORE the gate's
/// 501, so it answers while `EXPORT_GATE_ENABLED` is still dark:
///   • 200 `{ allowed: true,  tier: "paid", reason }`  → a Pro export would succeed
///   • 402 `{ allowed: false, tier: "free", reason }`  → a free export hits the paywall
/// This lets the paywall-presentation branch be BUILT and VERIFIED today — zero flips.
///
/// IMPORTANT — it is a DRY RUN. It must NOT gate a real export or drive shipping
/// behaviour while the gate is dark: a free user still saves publicly today, so
/// gating on the probe pre-flip would break that. The SHIPPING paywall is driven by
/// the real 402 from `APIService.exportJob` (post-flip). The probe exists only to
/// exercise/verify that same paywall branch now, before the flip.
enum ExportGateDecision: Equatable {
    case allowed(tier: String)                  // 200 — Pro; an export would succeed
    case gated(tier: String, reason: String?)   // 402 — free; an export would hit the paywall
    case indeterminate(status: Int)             // 401/404/500/network — can't tell

    /// Pure parse of the probe's (status, body) — unit-tested with no network.
    /// An unparseable/absent body falls back to the tier the status already implies.
    static func from(status: Int, body: Data) -> ExportGateDecision {
        struct Probe: Decodable { let allowed: Bool?; let tier: String?; let reason: String? }
        let p = try? JSONDecoder().decode(Probe.self, from: body)
        switch status {
        case 200: return .allowed(tier: p?.tier ?? "paid")
        case 402: return .gated(tier: p?.tier ?? "free", reason: p?.reason)
        default:  return .indeterminate(status: status)
        }
    }

    /// True iff a free user WOULD hit the paywall — i.e., present it. `.indeterminate`
    /// is NOT a gate (fail-open: never block on an ambiguous probe).
    var wouldGate: Bool {
        if case .gated = self { return true }
        return false
    }

    /// The tier the probe reported, if any (for logging/telemetry).
    var tier: String? {
        switch self {
        case .allowed(let t):  return t
        case .gated(let t, _): return t
        case .indeterminate:   return nil
        }
    }
}
