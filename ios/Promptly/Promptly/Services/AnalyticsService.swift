import Foundation
import StoreKit
import RevenueCat
import PostHog

/// Fire-and-forget client analytics — ONE call site, TWO sinks (the analytics
/// backbone). Every `track` fires the same event name + props to:
///   1. PostHog (dashboards, funnels, session replay, experiments) — the
///      backbone where humans look.
///   2. `POST /api/events` → `analytics_events` — the machine mirror ([REPORT],
///      backend consumers, our own SQL). It stays.
/// Same names, same properties, never let the schemas drift.
///
/// Every call is best-effort: it returns immediately, never throws, never
/// blocks the caller, and silently drops on any failure. Analytics must never
/// sit on the purchase path — a dropped event is always preferable to a slowed
/// or crashed checkout.
///
/// Envelope on the /api/events sink:
///   - `anon_user_id` — the RevenueCat appUserID (joins profiles.rc_app_user_id)
///   - `territory` / `storefront` — the App Store storefront (country + id)
///   - `app_version` — short version + build
/// PostHog carries the same fields as event properties; identity is handled by
/// `Analytics.identify(userId:)` at sign-in (anonymous history merges onto the
/// person — the deferred-signup funnel depends on this).
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

    /// Identity bridge (cycle-2 audit, 2026-08-23): pre-auth events land in the
    /// mirror with only the RC anonymous id, and NOTHING joins it to the auth
    /// UUID later — 46% of new users' session_started rows were unreadable.
    /// This value is stable per install and rides every event as a prop
    /// (props need no allowlisting), so pre-auth → post-auth joins are exact.
    /// Prefers the first-seen RC appUserID (joins historical anon rows);
    /// mints a UUID if RC isn't configured at first fire.
    private static var installId: String {
        let d = UserDefaults.standard
        if let v = d.string(forKey: "analytics_install_id") { return v }
        let v = anonUserId ?? "install-" + UUID().uuidString
        d.set(v, forKey: "analytics_install_id")
        return v
    }

    /// StoreKit's storefront (country + id). Cheap — StoreKit caches it —
    /// so we resolve per-event rather than holding shared mutable state
    /// (which would be a data race across detached tasks).
    private static func storefront() async -> (territory: String?, id: String?) {
        guard let sf = await Storefront.current else { return (nil, nil) }
        return (sf.countryCode, sf.id) // countryCode is ISO alpha-3 (e.g. "USA","IND")
    }

    /// Track an event. Returns immediately; the network call runs detached.
    /// `durable`: for signals we can't afford to lose on the exact weak networks
    /// they describe (e.g. `upload_failed`), retry the /api/events POST a few
    /// times with backoff so the DB mirror still captures it. PostHog (sink 1)
    /// already persists + retries its own queue; this closes the gap on sink 2.
    static func track(_ event: String, props: [String: Any] = [:], durable: Bool = false) {
        // Resolve everything synchronous on the caller, and serialize props to
        // Data now, so only Sendable values (String / Data) cross the task
        // boundary — keeps this clean under strict concurrency.
        let version = appVersion
        let anon = anonUserId
        var enrichedProps = props
        enrichedProps["install_id"] = installId
        let propsData: Data = (JSONSerialization.isValidJSONObject(enrichedProps)
            ? (try? JSONSerialization.data(withJSONObject: enrichedProps)) : nil) ?? Data("{}".utf8)

        // Sink 1: PostHog. Same event name + props; the SDK batches, retries,
        // and persists its own queue. Envelope fields ride as properties so
        // funnels can cut by them without waiting for the person merge.
        var phProps: [String: Any] = enrichedProps
        phProps["app_version"] = version
        if let a = anon { phProps["rc_app_user_id"] = a }
        PostHogSDK.shared.capture(event, properties: phProps)

        // Sink 2: /api/events → analytics_events (the machine mirror).
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
            // Best-effort by default (fire once, ignore the response). DURABLE
            // events retry with backoff so a weak-network drop — the exact
            // condition an `upload_failed` describes — doesn't also drop the
            // event that measures it.
            let attempts = durable ? 3 : 1
            for attempt in 0..<attempts {
                do {
                    let (_, resp) = try await URLSession.shared.data(for: req)
                    if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) { break }
                } catch { /* fall through to retry */ }
                if attempt < attempts - 1 {
                    try? await Task.sleep(nanoseconds: UInt64(attempt + 1) * 2_000_000_000)
                }
            }
        }
    }

    /// Tie this device's anonymous PostHog history to the signed-in person.
    /// Called at auth resolve (and safe to call repeatedly — PostHog dedupes).
    /// CRITICAL for the deferred-signup funnel: without this merge, everything
    /// pre-signup (hook video, quiz, wall views) detaches from the person who
    /// eventually converts. Person properties are the dimensions every funnel
    /// cuts by; tier updates ride through here as entitlement changes.
    static func identify(userId: String, tier: String? = nil, preferredLanguage: String? = nil) {
        Task.detached(priority: .utility) {
            let (territory, _) = await storefront()
            var personProps: [String: Any] = [:]
            if let t = territory { personProps["territory"] = t }
            if let l = preferredLanguage ?? Locale.preferredLanguages.first { personProps["preferred_language"] = l }
            if let t = tier { personProps["tier"] = t }
            PostHogSDK.shared.identify(userId, userProperties: personProps)
            // Super-properties ride EVERY subsequent event so funnels segment by
            // tier + country without per-call props.
            var superProps: [String: Any] = [:]
            if let t = tier { superProps["tier"] = t }
            if let c = territory { superProps["country"] = c }
            if !superProps.isEmpty { PostHogSDK.shared.register(superProps) }
        }
    }

    /// Update the tier super-property when entitlement changes (free ↔ pro),
    /// so the same person's later events segment correctly without a full identify.
    static func setTier(_ tier: String) {
        PostHogSDK.shared.register(["tier": tier])
    }

    /// Clear identity + super-properties on sign-out so the next user on this
    /// device starts a clean, un-merged analytics session.
    static func reset() {
        PostHogSDK.shared.reset()
    }
}
