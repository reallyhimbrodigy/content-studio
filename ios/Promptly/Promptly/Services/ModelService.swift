import Foundation
import Combine

/// Owns the user's selected render model: persistence (UserDefaults), the
/// `@Published` selection the composer pill + picker observe, and the
/// tier-gated mutators. Every gate decision delegates to the pure
/// `ModelSelection` so the rules stay testable. `@MainActor` because it drives
/// SwiftUI state.
@MainActor
final class ModelService: ObservableObject {
    static let shared = ModelService()

    private let defaults: UserDefaults
    private static let storageKey = "model.selected"

    /// The active model. Persisted across sessions. Default `.flare`.
    @Published private(set) var selected: VideoModel

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let raw = defaults.string(forKey: Self.storageKey)
        self.selected = raw.flatMap(VideoModel.init(rawValue:)) ?? .flare
    }

    /// Attempt to select a model. Premium models are honored only for Pro
    /// users; for everyone else this is a no-op (the picker routes the tap to
    /// the paywall instead). Persists on a real change.
    func select(_ model: VideoModel, isPro: Bool) {
        guard ModelSelection.canSelect(model, isPro: isPro) else { return }
        guard model != selected else { return }
        selected = model
        persist()
    }

    /// Re-apply the tier gate against current entitlement. A premium selection
    /// held by a non-Pro user falls back to the base model. Call on launch and
    /// whenever entitlement refreshes — the downgrade-safety path so nobody is
    /// stranded on an inaccessible model.
    func reconcile(isPro: Bool) {
        let resolved = ModelSelection.resolve(selected: selected, isPro: isPro)
        guard resolved != selected else { return }
        selected = resolved
        persist()
    }

    /// The `premium_pipeline_enabled` value to send for the current selection
    /// and entitlement. The client's ONLY emitter of the premium flag — true
    /// only for (premium model AND Pro). The server re-derives this
    /// authoritatively; this just keeps a free client from ever asking.
    func premiumPipelineFlag(isPro: Bool) -> Bool {
        // §7: the model is no longer user-selectable (picker removed) — the tier
        // follows the plan silently. BUT Pro does NOT silently get the premium (Lumen)
        // pipeline yet: premium KEEPS designed Lumen scenes (the worker strips them on
        // the standard path via _premium_gate_scene_strip), and those designed scenes
        // have never been reviewed or emitted in production — at higher per-render cost
        // + latency. So Pro gets the PROVEN standard pipeline until Lumen quality clears
        // Zac's eye. FLIP POINT when it does: return `isPro` here (one line), OR the
        // backend flips its master env PREMIUM_PIPELINE_ENABLED (no client build needed,
        // since the worker OR-gates the per-job flag with that env). `isPro` retained
        // for the flip.
        _ = isPro
        return false
    }

    private func persist() {
        defaults.set(selected.rawValue, forKey: Self.storageKey)
    }
}
