import Foundation

/// The app's UI language: which languages we ship, how a device maps onto one,
/// and where an explicit override lives.
///
/// ── THE DEFAULT IS THE DEVICE, ALWAYS ───────────────────────────────────────
/// iOS already picks the right language: it matches the user's preferred
/// language list against the bundle's available localizations. That mechanism
/// works today — all twelve `.lproj` are compiled into the bundle and verified
/// non-empty — so this type does NOT reimplement selection, and nothing here
/// runs unless the user explicitly asks for something other than their device
/// language.
///
/// The picker is an override, not the mechanism. Storing the resolved device
/// language on first launch would be actively harmful: it pins the app to
/// whatever language the phone happened to be in at install, so a user who
/// later switches their iOS system language would find the app alone stuck
/// behind. `nil` means "follow the device" and is the shipped default.
///
/// ── WHAT IT DOES NOT TOUCH ──────────────────────────────────────────────────
/// The video's caption language. Captions follow the spoken audio — the worker
/// transcribes with `language="multi"` and detects per clip — so a user reading
/// the app in Hindi still gets English captions on an English clip. Coupling
/// the two would mistranslate every render whose audio is not in the reader's
/// language, which is most of them. The reply follows the user; the captions
/// follow the content.
enum AppLanguage {

    /// Every language the String Catalog actually ships, each labelled in its
    /// OWN script — a person picks their language in their language, so a
    /// reader who cannot read the current UI can still find their row.
    ///
    /// This list is derived from what is really in the bundle. The onboarding
    /// picker it replaces listed only nine: `bn`, `ne` and `ur` were fully
    /// translated and compiled into the app but unreachable from any UI.
    static let supported: [(code: String, label: String)] = [
        ("en",    "English"),
        ("es",    "Español"),
        ("pt-BR", "Português (Brasil)"),
        ("fr",    "Français"),
        ("de",    "Deutsch"),
        ("ja",    "日本語"),
        ("hi",    "हिन्दी"),
        ("bn",    "বাংলা"),
        ("ne",    "नेपाली"),
        ("ur",    "اردو"),
        ("ar",    "العربية"),
        ("id",    "Bahasa Indonesia"),
    ]

    private static let overrideKey = "preferred_language"

    private static let deviceSnapshotKey = "device_resolved_language"

    /// The explicit override, or nil when following the device.
    ///
    /// Setting it writes `AppleLanguages` into THIS APP's defaults domain. That
    /// is the same per-app language mechanism iOS exposes in Settings → Promptly
    /// → Language; it is scoped to our app and does not touch the device's own
    /// preferred-language list, which lives in the global domain.
    ///
    /// It takes effect on the NEXT LAUNCH, and that is not a shortcut — it is
    /// the only thing that actually works. An earlier revision of this file
    /// redirected `Bundle.main` to the chosen `.lproj` so a change could apply
    /// mid-session. It was tested on a simulator and it does NOT work:
    /// `String(localized:)` resolving against a String Catalog does not route
    /// through `NSBundle.localizedString(forKey:value:table:)`, so the redirect
    /// intercepts nothing and the screen stays in the old language while
    /// appearing to have changed. Since nearly all of this app's copy — the
    /// whole paywall and offer reveal included — is `String(localized:)`, an
    /// "instant" switch would have shipped as a half-translated screen.
    /// Next-launch is honest, and the picker says so.
    static var override: String? {
        get {
            let c = UserDefaults.standard.string(forKey: overrideKey)
            return supported.contains(where: { $0.code == c }) ? c : nil
        }
        set {
            let d = UserDefaults.standard
            if let code = newValue, supported.contains(where: { $0.code == code }) {
                // Snapshot what the device resolves to BEFORE pinning, or
                // "System" could never be computed again once pinned.
                d.set(deviceResolved, forKey: deviceSnapshotKey)
                d.set(code, forKey: overrideKey)
                d.set([code], forKey: "AppleLanguages")
            } else {
                d.removeObject(forKey: overrideKey)
                d.removeObject(forKey: "AppleLanguages")
            }
        }
    }

    /// What iOS itself would choose for this device, ignoring any override.
    /// `Bundle.preferredLocalizations` is the system's own matcher, so regional
    /// forms resolve the way the OS resolves them (pt-BR from pt-PT, and so on)
    /// rather than through a lookup table we would have to maintain.
    ///
    /// While an override is active our own `AppleLanguages` pin shadows the
    /// device list, so this would just echo the override back. In that case the
    /// snapshot taken at pin time is the honest answer.
    static var deviceResolved: String {
        if override != nil,
           let snap = UserDefaults.standard.string(forKey: deviceSnapshotKey),
           supported.contains(where: { $0.code == snap }) {
            return snap
        }
        let resolved = Bundle.preferredLocalizations(from: supported.map(\.code),
                                                     forPreferences: Locale.preferredLanguages).first ?? "en"
        // Keep the snapshot fresh whenever we are genuinely following the
        // device, so a user who changes their iOS language and only later opens
        // the picker still sees the current device language behind "System".
        if override == nil {
            UserDefaults.standard.set(resolved, forKey: deviceSnapshotKey)
        }
        return resolved
    }

    /// The language actually in force.
    static var current: String { override ?? deviceResolved }

    /// The row label for a code, falling back to the code itself.
    static func label(for code: String) -> String {
        supported.first { $0.code == code }?.label ?? code
    }

    /// True when a chosen override has not yet taken effect, i.e. the running
    /// process was launched before the choice was made. The picker uses this to
    /// tell the user plainly rather than leaving them looking at a screen that
    /// did not change.
    static var overridePendingRestart: Bool {
        guard let code = override else { return false }
        return Bundle.main.preferredLocalizations.first != code
    }
}
