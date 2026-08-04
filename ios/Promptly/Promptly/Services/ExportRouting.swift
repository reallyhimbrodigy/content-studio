import Foundation

/// The export-flow save decision, extracted from APIService (like PaywallRouting /
/// EntitlementTier) so it is pure, total, and unit-testable standalone against the
/// REAL error types — not a grepped copy.
///
/// The whitelist Zac mandated: a 402 must present the paywall and NEVER fall back
/// to the public save (that would defeat the paywall for every shipped client,
/// unfixable without another release). Only the two explicit cases fall back;
/// everything unrecognised surfaces an error rather than silently free-saving.
enum ExportRouting {
    enum Action: Equatable { case save, paywall, fallbackPublicSave, surfaceError }

    static func action(for error: Error) -> Action {
        switch error {
        case APIError.paymentRequired:    return .paywall              // 402 — NEVER fallback
        case APIError.exportNotAvailable: return .fallbackPublicSave   // 404 — NULL key, old job
        case is URLError:                 return .fallbackPublicSave   // network error
        default:                          return .surfaceError         // 5xx/decode — do NOT silently free-save
        }
    }
}
