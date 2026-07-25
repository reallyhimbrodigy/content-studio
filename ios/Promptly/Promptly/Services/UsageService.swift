import Foundation
import SwiftUI

/// Polls `/api/usage` for the user's daily counts + Pro status. Two roles:
///   1. Display: badge showing "2 / 3 renders today" in the UI
///   2. Preemptive paywall: gating logic can read `rendersLeft` and
///      proactively present the paywall when the next action would 402.
///
/// We deliberately do NOT enforce the limit on the client — the server
/// is the gate. This service is for UX (showing the counter, surfacing
/// the paywall before the user even hits send when they're at 0 left).
@MainActor
final class UsageService: ObservableObject {
    static let shared = UsageService()

    struct Snapshot: Codable {
        let is_pro: Bool
        let pro_until: String?
        let renders_today: Int
        let chats_today: Int
        let render_limit: Int
        let chat_limit: Int
        /// Server-derived wall tier ('none' | 'trial' | 'paid'). Optional so a
        /// pre-1.2.0 server response (no tier field) still decodes. The client
        /// composes this with RevenueCat's view via EntitlementTier.resolve.
        let tier: String?
        // Freemium usage-meter contract (server /api/usage, 2026-07-23+). All
        // optional so a pre-1.3.0 server (which omits them) still decodes — the
        // struct has no CodingKeys and the decoder does no snake_case conversion,
        // so these names must match the JSON keys 1:1. `used`/`limit` mirror
        // renders_today/render_limit (limit is null for Pro → Int?); `resets_at`
        // is the ISO8601 instant the daily quota resets (next UTC midnight).
        let used: Int?
        let limit: Int?
        let resets_at: String?
        // ── Server routing cert (staged, 218). Both optional so every current
        // client still decodes. The SERVER owns the flip: it emits
        // content_routing_enabled=true + max_upload_seconds=300 ONLY once the
        // routing pipeline can actually process 5-min videos. Until then they're
        // absent → the client stays in the conservative world (180s, on-device
        // content pre-checks). "Server leads safely" — no client rebuild flips it.
        let max_upload_seconds: Int?
        let content_routing_enabled: Bool?
    }

    @Published var snapshot: Snapshot?
    @Published var isLoading: Bool = false

    var isPro: Bool { snapshot?.is_pro ?? false }
    var rendersToday: Int { snapshot?.renders_today ?? 0 }
    var chatsToday: Int { snapshot?.chats_today ?? 0 }
    // STRICT: the daily caps come ONLY from the server snapshot — never a
    // client-side fallback that could invent a wrong number. nil until the first
    // snapshot lands (every quota surface renders nothing until then, by design).
    // The old `?? 3` fallback is exactly the class of bug that showed a free user
    // "2 left" (a legacy trial cap of 3 minus one render); there is no safe
    // guessed limit, so the answer to "unknown" is nil, not a number.
    var renderLimit: Int? { snapshot?.render_limit }
    var chatLimit: Int? { snapshot?.chat_limit }
    // Routing cert (218): the max upload length the picker enforces, and whether
    // content classification has moved server-side. Conservative defaults until
    // the server flips them — 180s ceiling, on-device content pre-checks ON.
    var maxUploadSeconds: Int { snapshot?.max_upload_seconds ?? 180 }
    var contentRoutingEnabled: Bool { snapshot?.content_routing_enabled ?? false }
    var rendersLeft: Int? { snapshot.map { max(0, $0.render_limit - $0.renders_today) } }
    var chatsLeft: Int? { snapshot.map { max(0, $0.chat_limit - $0.chats_today) } }
    // Gate on the COMPOSITE Pro signal (RevenueCat OR server), matching the
    // contract in SubscriptionService.effectiveIsPro and the picker/re-edit
    // gates. Using the server-only `isPro` here meant a user who is Pro on
    // RevenueCat but not-yet-synced server-side would still hit these
    // paywalls while re-edit + 10-video select already worked — the exact
    // split that read as "my Pro account isn't recognized."
    // nil-safe: an unknown (not-yet-loaded) count is NEVER "at limit" — the
    // server is the real gate, so pre-snapshot we never preemptively paywall.
    var atRenderLimit: Bool { !SubscriptionService.shared.effectiveIsPro && (rendersLeft.map { $0 <= 0 } ?? false) }
    var atChatLimit: Bool { !SubscriptionService.shared.effectiveIsPro && (chatsLeft.map { $0 <= 0 } ?? false) }

    /// The absolute instant the daily render quota resets (server = next UTC
    /// midnight), for the usage-meter countdown. The server serializes with
    /// `toISOString()`, which ALWAYS includes fractional seconds (".000Z"), so
    /// the formatter MUST enable `.withFractionalSeconds` or the parse returns
    /// nil; we fall back to the non-fractional form for safety. The parsed Date
    /// is absolute (Z offset), so no local-timezone math is needed downstream.
    var resetsAt: Date? {
        guard let s = snapshot?.resets_at else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    private init() {}

    /// Hit `/api/usage`. Cheap (one indexed COUNT against usage_events).
    /// Call on:
    ///   - App foreground / sign-in
    ///   - After every successful render dispatch
    ///   - After every successful AI chat reply
    ///   - After a successful purchase (or RevenueCat customerInfo update)
    func refresh() async {
        guard let token = await AuthService.shared.getValidToken() else { return }
        isLoading = true
        defer { isLoading = false }
        guard let url = URL(string: "https://usepromptly.app/api/usage") else { return }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // Stamp the freemium header (X-Promptly-Freemium: 1) so /api/usage computes
        // the limit on the SAME tier every other freemium door uses. Without it the
        // server falls to effectiveTier('none', enforce=false) → the legacy 'trial'
        // cap of 3, and a free user's meter reads "3" (→ "2 left" after one render).
        // The render gate (createVideoJob) already stamps this; the display call
        // must match it or the number lies while the server correctly enforces 1.
        WallCapability.stamp(&request)
        request.timeoutInterval = 10
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }
            let snap = try JSONDecoder().decode(Snapshot.self, from: data)
            self.snapshot = snap
        } catch {
            print("[usage] refresh failed: \(error.localizedDescription)")
        }
    }
}
