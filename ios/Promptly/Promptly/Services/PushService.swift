import Foundation
import UIKit
import UserNotifications

/// APNs push registration. Designed around the "ask after first edit"
/// flow — `requestPermissionIfNeeded()` is idempotent and gates on the
/// current authorization status so callers don't have to track whether
/// they've asked before.
///
/// Flow:
///   1. requestPermissionIfNeeded()  — shows the iOS dialog (if not asked yet)
///   2. UIApplication.registerForRemoteNotifications()  — asks APNs for a token
///   3. AppDelegate's didRegisterForRemoteNotificationsWithDeviceToken fires
///   4. setDeviceToken(_:) — uploads to /api/devices/register
///
/// We persist the last-registered token in UserDefaults so we don't spam
/// the server on every launch — only re-register when the token changes
/// or the user signs in fresh.
@MainActor
final class PushService {
    static let shared = PushService()
    private init() {}

    private let lastTokenKey = "promptly.pushService.lastDeviceToken"
    private let askedKey = "promptly.pushService.didAskForPermission"
    private let softOfferedKey = "promptly.pushService.didOfferSoftPrompt"

    /// True if we've shown the system permission dialog at least once. Used
    /// to avoid asking twice (after a denial we shouldn't keep prompting —
    /// iOS would suppress it anyway, but skipping the call keeps logs clean).
    var hasAskedForPermission: Bool {
        UserDefaults.standard.bool(forKey: askedKey)
    }

    /// True once we've shown the in-app pre-permission explainer (either outcome).
    /// Keeps the soft ask to a single, well-timed moment (the first upload) — we
    /// never re-nag it on every upload.
    var didOfferSoftPrompt: Bool {
        UserDefaults.standard.bool(forKey: softOfferedKey)
    }

    /// Whether to show the pre-permission explainer now. Only if the explainer
    /// hasn't been shown AND the system dialog is still unseen (notDetermined,
    /// tracked via `hasAskedForPermission`). This is the guarantee we NEVER ask
    /// cold: the caller shows the explainer, and ONLY a "Notify me" tap reaches
    /// requestPermissionIfNeeded() and the iOS dialog. A "Not now" leaves the
    /// system one-shot intact for a future re-offer.
    var shouldOfferSoftPrompt: Bool {
        !hasAskedForPermission && !didOfferSoftPrompt
    }

    /// Mark the pre-permission explainer as shown (called on either button).
    func markSoftPromptOffered() {
        UserDefaults.standard.set(true, forKey: softOfferedKey)
    }

    /// The token we last successfully registered with the server. Used to
    /// short-circuit redundant /api/devices/register calls.
    private var lastRegisteredToken: String? {
        get { UserDefaults.standard.string(forKey: lastTokenKey) }
        set { UserDefaults.standard.set(newValue, forKey: lastTokenKey) }
    }

    /// Ask for notification permission if we haven't asked yet, then
    /// register for remote notifications. Safe to call repeatedly — the
    /// status check makes it a no-op once granted/denied.
    /// Call after the user sends their first edit (option A in the plan).
    func requestPermissionIfNeeded() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()

        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            // Already granted — ensure remote registration is current. iOS
            // gives us a fresh token roughly daily anyway.
            Analytics.track("push_permission", props: [
                "result": "granted",
                "authorization_status": settings.authorizationStatus.rawValue,
                "reason": "already_determined",
            ])
            UIApplication.shared.registerForRemoteNotifications()
        case .notDetermined:
            UserDefaults.standard.set(true, forKey: askedKey)
            do {
                let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
                // Capture the actual iOS system-dialog outcome. Re-fetch settings
                // so authorization_status reflects the post-prompt state (the outer
                // `settings` snapshot is still .notDetermined at this point).
                let resolvedSettings = await center.notificationSettings()
                Analytics.track("push_permission", props: [
                    "result": granted ? "granted" : "denied",
                    "authorization_status": resolvedSettings.authorizationStatus.rawValue,
                ])
                if granted {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            } catch {
                // User dismissed or system denied — don't retry.
            }
        case .denied:
            // iOS won't show the dialog again. User has to flip the switch
            // in Settings; that path triggers a fresh registration via
            // didRegisterForRemoteNotifications.
            Analytics.track("push_permission", props: [
                "result": "denied",
                "authorization_status": settings.authorizationStatus.rawValue,
                "reason": "already_determined",
            ])
            break
        @unknown default:
            break
        }
    }

    /// AppDelegate calls this from didRegisterForRemoteNotificationsWithDeviceToken.
    /// Hex-encodes the binary token and POSTs it to the server. Skips the
    /// network call if we just registered the same token.
    func setDeviceToken(_ data: Data) {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        guard hex != lastRegisteredToken else { return }
        Task { await registerToken(hex) }
    }

    /// Called on sign-out. Best-effort delete on the server side.
    func unregisterCurrentDevice() async {
        guard let token = lastRegisteredToken else { return }
        lastRegisteredToken = nil
        guard let authToken = await AuthService.shared.getValidToken() else { return }

        guard let url = URL(string: "https://usepromptly.app/api/devices/unregister") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        req.httpBody = try? JSONEncoder().encode(["token": token])
        _ = try? await URLSession.shared.data(for: req)
    }

    private func registerToken(_ hexToken: String) async {
        guard let authToken = await AuthService.shared.getValidToken() else { return }
        guard let url = URL(string: "https://usepromptly.app/api/devices/register") else { return }

        let bundleId = Bundle.main.bundleIdentifier ?? "app.usepromptly.ios"
        let appVersion = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String).map {
            "\($0)+\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0")"
        } ?? "unknown"

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        req.httpBody = try? JSONEncoder().encode([
            "token": hexToken,
            "platform": "ios",
            "bundle_id": bundleId,
            "app_version": appVersion,
        ])

        do {
            let (_, response) = try await URLSession.shared.data(for: req)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                lastRegisteredToken = hexToken
            }
        } catch {
            // Transient — next launch will retry via UIApplication.registerForRemoteNotifications.
        }
    }
}
