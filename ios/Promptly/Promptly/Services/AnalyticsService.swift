import Foundation
import StoreKit
import RevenueCat

/// Fire-and-forget client analytics for the commerce funnel.
///
/// Every call is best-effort: it returns immediately, never throws, never
/// blocks the caller, and silently drops on any failure. Analytics must never
/// sit on the purchase path — a dropped event is always preferable to a slowed
/// or crashed checkout.
///
/// Emits to `POST /api/events`, which sinks into the `analytics_events` table
/// server-side. Every event carries a common envelope:
///   - `anon_user_id` — the RevenueCat appUserID (joins profiles.rc_app_user_id)
///   - `territory` / `storefront` — the App Store storefront (country + id)
///   - `app_version` — short version + build
/// Event-specific fields ride in `props` (e.g. offerings_loaded → count,
/// purchase_error → code/domain).
///
/// The six events, emitted from SubscriptionService / PaywallView:
///   paywall_view · offerings_loaded · offerings_load_failed ·
///   purchase_attempt · purchase_error · trial_start
enum Analytics {
    private static let endpoint = URL(string: "https://usepromptly.app/api/events")!

    private static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let v = info?["CFBundleShortVersionString"] as? String ?? "?"
        let b = info?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }

    private static var anonUserId: String? {
        // Purchases.isConfigured guards against calling before bootstrap().
        guard Purchases.isConfigured else { return nil }
        return Purchases.shared.appUserID
    }

    /// StoreKit's storefront (country + id). Cheap — StoreKit caches it —
    /// so we resolve per-event rather than holding shared mutable state
    /// (which would be a data race across detached tasks).
    private static func storefront() async -> (territory: String?, id: String?) {
        guard let sf = await Storefront.current else { return (nil, nil) }
        return (sf.countryCode, sf.id) // countryCode is ISO alpha-3 (e.g. "USA","IND")
    }

    /// Track an event. Returns immediately; the network call runs detached.
    static func track(_ event: String, props: [String: Any] = [:]) {
        // Resolve everything synchronous on the caller, and serialize props to
        // Data now, so only Sendable values (String / Data) cross the task
        // boundary — keeps this clean under strict concurrency.
        let version = appVersion
        let anon = anonUserId
        let propsData: Data = (JSONSerialization.isValidJSONObject(props)
            ? (try? JSONSerialization.data(withJSONObject: props)) : nil) ?? Data("{}".utf8)

        Task.detached(priority: .utility) {
            let (territory, storefrontId) = await storefront()
            let propsObj = (try? JSONSerialization.jsonObject(with: propsData)) ?? [:]
            var payload: [String: Any] = [
                "event": event,
                "app_version": version,
                "platform": "ios",
                "props": propsObj,
            ]
            if let a = anon { payload["anon_user_id"] = a }
            if let t = territory { payload["territory"] = t }
            if let s = storefrontId { payload["storefront"] = s }

            guard JSONSerialization.isValidJSONObject(payload),
                  let data = try? JSONSerialization.data(withJSONObject: payload) else { return }

            var req = URLRequest(url: endpoint)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = data
            req.timeoutInterval = 8
            _ = try? await URLSession.shared.data(for: req) // response ignored by design
        }
    }
}
