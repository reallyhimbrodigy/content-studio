import Foundation
import SwiftUI

/// Version awareness — server-driven update prompts (/api/health carries the
/// thresholds and copy, so they change WITHOUT a release):
///
///   latest_version         → SOFT, dismissible banner when this build is
///                            older. Dismissal is per-version: a new latest
///                            re-shows it once.
///   min_supported_version  + force_update='on' → the FORCED full-screen
///                            cover. Its own flag, default off — a broken-
///                            build emergency lever, never routine.
///   (contextual)           → at the point of a KNOWN-FIXED failure the app
///                            prompts in context — the upload class is the
///                            first case (1.3.6 users hit a defect 1.3.10
///                            fixed). Gate: an upload just failed AND this
///                            build is older than latest. No version literals
///                            in code — thresholds are the server's.
@MainActor
final class VersionAwareness: ObservableObject {
    static let shared = VersionAwareness()

    static let appStoreURL = URL(string: "https://apps.apple.com/app/id6762497454")!
    private static let dismissedKey = "update_banner_dismissed_for"

    /// This build is older than what's live on the App Store.
    @Published private(set) var updateAvailable = false
    /// force_update is armed AND this build is below the supported floor.
    @Published private(set) var updateRequired = false
    /// Optional server-supplied banner line.
    @Published private(set) var notes: String?
    /// The latest version string, for per-version dismissal bookkeeping.
    @Published private(set) var latestVersion: String?
    /// Mirrors UserDefaults so the banner hides immediately on dismiss.
    @Published private(set) var dismissedForLatest = false

    private init() {}

    /// Fed the parsed /api/health payload by OnboardingState.resolveExposure
    /// (one fetch per launch, pre-auth). Absent fields → everything stays off.
    func ingest(_ health: [String: Any]?) {
        let current = Self.bundleVersion()
        let latest = (health?["latest_version"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let minSupported = (health?["min_supported_version"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let forceArmed = (health?["force_update"] as? String) == "on"
        let serverNotes = (health?["update_notes"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)

        latestVersion = latest.isEmpty ? nil : latest
        notes = (serverNotes?.isEmpty == false) ? serverNotes : nil
        updateAvailable = !latest.isEmpty && VersionMath.isOlder(current, than: latest)
        updateRequired = forceArmed && !minSupported.isEmpty
            && VersionMath.isOlder(current, than: minSupported)
        dismissedForLatest = !latest.isEmpty
            && UserDefaults.standard.string(forKey: Self.dismissedKey) == latest
    }

    /// The soft banner is visible: outdated, not dismissed for THIS latest,
    /// and not superseded by the forced cover.
    var showBanner: Bool { updateAvailable && !dismissedForLatest && !updateRequired }

    /// Contextual prompt gate — a known-fixed failure just happened and an
    /// update exists. (The upload class is the first caller.)
    var showContextualUploadPrompt: Bool { updateAvailable }

    /// The banner reached the screen. Emitted by the view rather than by
    /// `showBanner`, because that property is read on every layout pass and
    /// would count impressions in the dozens.
    ///
    /// `current` and `latest` ride along so the cohort is readable without a
    /// join: the interesting question is not "how many saw it" but "how far
    /// behind were the people who saw it", and 1.3.6 users are 59% of the
    /// active base.
    func trackBannerShown() {
        Analytics.track("update_banner_shown", props: [
            "current": Self.bundleVersion(),
            "latest": latestVersion ?? "",
            "has_notes": notes?.isEmpty == false,
        ])
    }

    func dismissBanner() {
        guard let latest = latestVersion else { return }
        Analytics.track("update_banner_dismissed", props: [
            "current": Self.bundleVersion(),
            "latest": latest,
        ])
        UserDefaults.standard.set(latest, forKey: Self.dismissedKey)
        dismissedForLatest = true
    }

    /// SOURCE IS REQUIRED, because three different surfaces call this — the
    /// dismissible banner, the contextual post-failure strip, and the forced
    /// cover — and they answer different questions. Without it every tap lands
    /// in one bucket and the only thing measurable is "someone updated", which
    /// is exactly the blindness this closes. No default: a new caller has to
    /// name itself.
    func openAppStore(source: String) {
        Analytics.track("update_prompt_tapped", props: [
            "source": source,
            "current": Self.bundleVersion(),
            "latest": latestVersion ?? "",
        ])
        UIApplication.shared.open(Self.appStoreURL)
    }

    // MARK: - Version math

    static func bundleVersion() -> String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0"
    }

}
