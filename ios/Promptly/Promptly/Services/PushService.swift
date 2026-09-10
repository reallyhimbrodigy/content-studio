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
    private let primerOfferedKey = "promptly.pushService.didOfferDeliveryPrimer"
    // The bookkeeping that replaces the two flags above as BARS. Both old keys
    // are still read — 1,056 devices carry them — but neither can silence us
    // permanently any more. See SoftPromptPolicy.
    private let declineCountKey = "promptly.pushService.softPromptDeclineCount"
    private let retryAfterKey = "promptly.pushService.softPromptRetryAfter"

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

    /// Whether to show the pre-permission explainer now.
    ///
    /// This was `!hasAskedForPermission && !didOfferSoftPrompt`, and BOTH alert
    /// buttons set that flag — so one "Not now" silenced the app forever and
    /// 1,056 users ended up with no push token. The comment above it even
    /// claimed a "Not now" left things "intact for a future re-offer"; nothing
    /// in the code did that. A deferral now sets a DATE.
    ///
    /// The guarantee that has NOT changed: we never ask cold. The caller shows
    /// the explainer, and only a "Notify me" tap reaches
    /// requestPermissionIfNeeded() and the iOS dialog.
    var shouldOfferSoftPrompt: Bool {
        SoftPromptPolicy.shouldOffer(softPromptState, now: Date())
    }

    /// Everything SoftPromptPolicy needs, read in one place so the predicate and
    /// the recording below cannot drift apart.
    var softPromptState: SoftPromptPolicy.State {
        let d = UserDefaults.standard
        return .init(
            systemDialogSeen: hasAskedForPermission,
            declineCount: d.integer(forKey: declineCountKey),
            retryAfter: d.object(forKey: retryAfterKey) as? Date,
            legacyOfferedFlag: d.bool(forKey: softOfferedKey),
            // A device that has never written the count key has never been
            // through the new bookkeeping — its legacy flag is all we know.
            migrated: d.object(forKey: declineCountKey) != nil
        )
    }

    /// The user tapped "Notify me". Nothing to defer: the iOS dialog is next,
    /// and `hasAskedForPermission` becomes the (correct, permanent) stop.
    func recordSoftPromptAccepted() {
        UserDefaults.standard.set(true, forKey: softOfferedKey)
    }

    /// The user tapped "Not now", or dismissed. THE DEFERRAL. Count it and set
    /// a date — never a flag. The legacy key is still written so an older build
    /// installed over this one keeps its old behaviour rather than re-asking
    /// from zero.
    func recordSoftPromptDeclined() {
        let d = UserDefaults.standard
        let next = SoftPromptPolicy.effectiveDeclines(softPromptState) + 1
        d.set(next, forKey: declineCountKey)
        d.set(SoftPromptPolicy.nextRetry(afterDeclines: next, from: Date()), forKey: retryAfterKey)
        d.set(true, forKey: softOfferedKey)
        Analytics.track("push_softprompt_deferred", props: [
            "decline_count": next,
            "retry_after_days": Int(SoftPromptPolicy.retryGaps[
                min(max(next - 1, 0), SoftPromptPolicy.retryGaps.count - 1)] / 86_400),
        ])
    }

    /// Kept so old call sites compile; a bare "we showed it" with no outcome is
    /// exactly the ambiguity that caused this, so it records a DECLINE — the
    /// conservative reading, and the one that still leaves a way back.
    @available(*, deprecated, message: "Call recordSoftPromptAccepted() or recordSoftPromptDeclined() — an offer without an outcome is what set the permanent flag.")
    func markSoftPromptOffered() {
        recordSoftPromptDeclined()
    }

    /// True once the post-first-delivery primer sheet has claimed its one
    /// showing on this install (either outcome, including swipe-down).
    var didOfferDeliveryPrimer: Bool {
        UserDefaults.standard.bool(forKey: primerOfferedKey)
    }

    /// Conversion build (flag: push_primer): the post-first-delivery soft ask
    /// — a SHEET (PushPrimerView), not the alert, at the moment the user's
    /// FIRST rendered video becomes visible. Called from ChatStore.scheduleSave
    /// the instant a message flips to completed-with-video. All gating lives
    /// here:
    ///   - flag off → no-op, byte-identical to today;
    ///   - once per install (`didOfferDeliveryPrimer`);
    ///   - never after the legacy explainer or the in-app system ask
    ///     (`shouldOfferSoftPrompt` covers both);
    ///   - never when the OS-level permission is already granted or denied —
    ///     checked against notificationSettings before presenting.
    /// Both guards are claimed SYNCHRONOUSLY — including markSoftPromptOffered()
    /// — because EditorView's completion sink checks shouldOfferSoftPrompt on
    /// the line right after the persist call that got us here; claiming now is
    /// what stops the legacy alert and this sheet stacking on the same beat.
    /// "Not now" / swipe defers — PushPrimerView records the decline, which sets
    /// a retry date. It is not forever-quiet; that was the defect.
    func maybeOfferDeliveryPrimer() {
        guard OnboardingState.shared.pushPrimerEnabled else { return }
        // THE PRIMER NO LONGER GUARDS ON WHAT IT EXISTS TO RECOVER FROM.
        // This read `guard !didOfferDeliveryPrimer, shouldOfferSoftPrompt`, and
        // the second half was false for every user who had ever tapped "Not
        // now" — which is precisely the 1,056 this sheet was built to reach. It
        // was dead for its own target population. Worse, it then called
        // markSoftPromptOffered(), so merely showing it spent the future too.
        //
        // `shouldOfferSoftPrompt` is now date-based, so it is the right gate to
        // ask — a deferral expires. `didOfferDeliveryPrimer` stays a one-per-
        // install claim for the SHEET specifically, so the sheet and the legacy
        // alert still cannot stack on one beat.
        guard !didOfferDeliveryPrimer, shouldOfferSoftPrompt else { return }
        UserDefaults.standard.set(true, forKey: primerOfferedKey)
        Task { @MainActor in
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            // Granted/denied at the OS level (e.g. flipped in Settings without
            // an in-app ask): nothing to soft-ask for. The claimed guards stay
            // claimed — the OS state can't return to notDetermined on this
            // install, so the primer is correctly spent.
            guard settings.authorizationStatus == .notDetermined else { return }
            // Let the reveal land first — the video flips in as this fires,
            // and the ask should read as a response to the payoff, not an
            // interruption of it.
            try? await Task.sleep(for: .seconds(0.9))
            PushPrimerPresenter.present()
        }
    }

    /// Offer the soft prompt after a successful export or share.
    ///
    /// This call site is the second half of the fix. Making "Not now" expire is
    /// useless on its own: the expiry only matters if something LOOKS again, and
    /// the two existing look-points both fire around a user's FIRST render —
    /// which the 1,056 are long past. An export is the right re-ask moment for
    /// the same reason it is the right review-prompt moment: the user has just
    /// chosen to keep the thing we made.
    ///
    /// Everything is gated in `shouldOfferSoftPrompt`, so this is a no-op for a
    /// user who consented, who was never asked, or whose retry date has not
    /// arrived. The OS check keeps it honest for permission flipped in Settings.
    @MainActor
    func maybeOfferSoftPromptAfterExport(method: String) {
        guard shouldOfferSoftPrompt else { return }
        Task { @MainActor in
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            guard settings.authorizationStatus == .notDetermined else { return }
            // Let the save/share confirmation land first — the ask should read
            // as a response to the payoff, not an interruption of it.
            try? await Task.sleep(for: .seconds(0.9))
            Analytics.track("push_softprompt_reoffered", props: [
                "trigger": "export",
                "method": method,
                "prior_declines": SoftPromptPolicy.effectiveDeclines(softPromptState),
            ])
            PushPrimerPresenter.present()
        }
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


// MARK: - Upload-failure notification (drop-off audit, shipped 2026-08-27)
//
// "A failed upload must tell the user at the moment it's known." The Aug-24
// class was analytics-loud but USER-SILENT until next foreground — 1,538
// users lost at this door, mostly silently. When an upload dies while the
// app is backgrounded (orphan delivery, background give-up), post a LOCAL
// notification immediately. Tapping it opens the app, which lands on the
// chat where the failed bubble's Retry is front and center. Foreground
// failures stay silent here — the failed bubble is already on screen.
enum UploadFailureNotifier {
    static func notifyUploadDied() {
        // Read the knob's UserDefaults cache — this fires from nonisolated
        // background contexts where the @MainActor store can't be touched.
        guard UserDefaults.standard.bool(forKey: "upload_fail_notify_enabled") else { return }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else { return }
            let content = UNMutableNotificationContent()
            content.title = String(localized: "Your upload didn't finish")
            content.body = String(localized: "Your clip is still ready — tap to retry.")
            content.sound = .default
            content.userInfo = ["route": "retry_upload"]
            // Stable identifier: a second death before the user returns
            // REPLACES the notification instead of stacking spam.
            let req = UNNotificationRequest(
                identifier: "upload-failure",
                content: content,
                trigger: nil
            )
            center.add(req)
        }
    }
}
