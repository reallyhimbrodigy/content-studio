import Foundation

/// The two render models the user picks between in the composer.
///
/// `flare` is the base everyday editor (free, available to everyone);
/// `lumen` is the premium pipeline (Pro-only). The selected model maps to a
/// single routing flag on the job payload — see `ModelSelection.premiumFlag`.
/// It changes which pipeline the job runs, nothing else about submission.
enum VideoModel: String, CaseIterable, Identifiable, Sendable {
    case flare
    case lumen

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .flare: return "Flare"
        case .lumen: return "Lumen"
        }
    }

    var descriptor: String {
        switch self {
        case .flare: return "Fast, everyday edits."
        case .lumen: return "Premium cinematic edits with generated graphics."
        }
    }

    /// Pro-tier-only models. Drives the lock + glow treatment in the picker
    /// and the tier gate below.
    var isPremium: Bool {
        switch self {
        case .flare: return false
        case .lumen: return true
        }
    }

    /// The base model everyone can always use — the fallback after a downgrade.
    static var base: VideoModel { .flare }
}

/// PURE, dependency-free tier-gate logic for model selection. Kept separate
/// from `ModelService` (which owns persistence + `@MainActor` state) so the
/// security-critical rules compile and test with plain `swiftc` —
/// see ios/Promptly/Tests/ModelSelectionTests.swift.
///
/// The invariant the whole feature rests on: a non-Pro user can never select
/// a premium model and can never put `premium_pipeline_enabled: true` on the
/// wire. `premiumFlag` is the ONLY function that returns true, and only for
/// (premium model AND Pro).
enum ModelSelection {
    /// Can this user select this model? Base models always; premium models
    /// only when Pro.
    static func canSelect(_ model: VideoModel, isPro: Bool) -> Bool {
        model.isPremium ? isPro : true
    }

    /// The effective model after applying the tier gate. A premium model held
    /// by a now-non-Pro user falls back to the base model. Used on launch /
    /// entitlement refresh so nobody is stranded on an inaccessible model after
    /// a downgrade.
    static func resolve(selected: VideoModel, isPro: Bool) -> VideoModel {
        canSelect(selected, isPro: isPro) ? selected : .base
    }

    /// THE routing signal. True iff a premium model is selected AND the user is
    /// actually entitled. This is the client's single source of
    /// `premium_pipeline_enabled`; a free user can never make it true.
    static func premiumFlag(selected: VideoModel, isPro: Bool) -> Bool {
        selected.isPremium && isPro
    }
}
