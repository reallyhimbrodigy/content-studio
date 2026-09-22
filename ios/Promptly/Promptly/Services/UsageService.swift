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
        // (The first-run sample-clip demo — sample_demo_* — was removed. The server
        // SAMPLE_DEMO_* keys can now be retired; unknown JSON keys decode fine, so
        // dropping these fields is safe against production as it is today.)
        // §5 progressive playback: start playing the render as segments land (HLS)
        // instead of waiting for the final mux. Server-gated, OFF by default; the
        // client player plumbing is wired behind this flag before it flips.
        let progressive_playback_enabled: Bool?
        /// Worker auth for the client's own /validate call — the one worker
        /// endpoint with no server proxy in front of it. Optional, so a server
        /// that has not shipped the field (or has no secret set) still decodes
        /// and the call goes out exactly as it does today. Carried on THIS
        /// response and not /api/health because health is public; this one is
        /// behind requireSupabaseUser. Held in memory only — the snapshot is
        /// never written to UserDefaults, so it cannot land in a backup.
        let validate_token: String?
        /// THE MONTHLY VIDEO ALLOWANCE PER TIER — the one source every
        /// user-facing capacity claim reads (258+).
        ///
        /// A MAP, NOT A SCALAR, and the paywall is why: TwoStepPaywall.tierOptions
        /// renders the Pro card and the Max card at the same time, to a user who
        /// holds neither. A field carrying only the caller's own allowance could
        /// not fill those two rows, so either the paywall would keep client-side
        /// tier constants — the thing this replaces — or it would show nothing.
        ///
        /// Optional at every level so a server that has not shipped it decodes
        /// exactly as today and every surface falls back to wording that states
        /// NO number. That is the whole safety property: a missing value can
        /// never become a false claim about what money buys. Same reason
        /// `creditsMonthlyAllowance` is nil-gated rather than defaulted.
        let videos_limit: VideoLimits?
    }

    /// Per-tier monthly video allowances, server-owned.
    ///
    /// Each tier optional on its own: a server that knows Pro and Max but not a
    /// tier added later still fills the rows it can, and the unknown row states
    /// no number rather than an invented one.
    struct VideoLimits: Codable {
        let free: Int?
        let pro: Int?
        let max: Int?
        /// The CALLER'S OWN allowance, when the server sends a bare number
        /// instead of a per-tier object.
        let own: Int?

        /// TOLERANT OF BOTH SHAPES, AND IT NEVER THROWS. This is not defensive
        /// styling; it is an outage this client would otherwise take.
        ///
        /// The server work in flight (lane/videos-allowance) sends
        /// `videos_limit: _credits.videosLimitFor(profileRow)` — a scalar, the
        /// caller's own limit. This client was written to a per-tier object,
        /// because the paywall draws the Pro and Max cards at once to someone
        /// holding neither and a scalar cannot fill those rows.
        ///
        /// Optionality does NOT protect against that. `VideoLimits?` covers
        /// absent and null; a NUMBER where an object is expected is a
        /// typeMismatch, and one throw anywhere in Snapshot fails the WHOLE
        /// decode — so `refresh()` returns early and render_limit, chat_limit,
        /// resets_at and validate_token all go blank with it. Verified against
        /// the real structs, all three shapes: absent decodes, the object
        /// decodes, the scalar threw
        ///   "Expected to decode Dictionary<String, Any> but found number".
        ///
        /// So this reads whichever arrives and, failing both, yields all-nil —
        /// the same inert state as a server that has not shipped the field.
        /// Whichever shape the contract settles on, this client survives it.
        init(from decoder: Decoder) throws {
            if let single = try? decoder.singleValueContainer(),
               let n = try? single.decode(Int.self) {
                free = nil; pro = nil; max = nil; own = n
                return
            }
            let c = try? decoder.container(keyedBy: CodingKeys.self)
            free = (try? c?.decodeIfPresent(Int.self, forKey: .free)) ?? nil
            pro  = (try? c?.decodeIfPresent(Int.self, forKey: .pro)) ?? nil
            max  = (try? c?.decodeIfPresent(Int.self, forKey: .max)) ?? nil
            own  = (try? c?.decodeIfPresent(Int.self, forKey: .own)) ?? nil
        }

        enum CodingKeys: String, CodingKey { case free, pro, max, own }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encodeIfPresent(free, forKey: .free)
            try c.encodeIfPresent(pro, forKey: .pro)
            try c.encodeIfPresent(max, forKey: .max)
            try c.encodeIfPresent(own, forKey: .own)
        }
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
    /// The secret to send as `_worker_auth` on /validate. nil until the first
    /// authenticated snapshot lands, and nil forever on a server that sets no
    /// secret — both of which mean the call goes out unauthenticated, which is
    /// today's behaviour. NEVER logged and never persisted.
    var validateToken: String? {
        guard let t = snapshot?.validate_token, !t.isEmpty else { return nil }
        return t
    }

    var renderLimit: Int? { snapshot?.render_limit }
    var chatLimit: Int? { snapshot?.chat_limit }

    /// THE MONTHLY VIDEO ALLOWANCE PER SOLD TIER. nil until the server sends the
    /// field, which is what keeps every capacity claim inert rather than wrong.
    ///
    /// Deliberately NOT keyed by `EntitlementTier`. That enum describes
    /// entitlement STATE — none/free/trial/paid/max — and the three tiers we
    /// SELL are a different concept; keying on it would force an answer for
    /// `trial` and `none` that the server never sends, which is how a surface
    /// ends up with its own narrower definition of a tier.
    ///
    /// `> 0` is part of the contract, not a nicety: a server that sends 0 for a
    /// tier it does not sell must read the same as one that omits it, or the
    /// paywall prints "0 videos a month" as a promise.
    private func positive(_ v: Int?) -> Int? {
        guard let v, v > 0 else { return nil }
        return v
    }
    var videosLimitFree: Int? { positive(snapshot?.videos_limit?.free) }
    var videosLimitPro: Int? { positive(snapshot?.videos_limit?.pro) }
    var videosLimitMax: Int? { positive(snapshot?.videos_limit?.max) }

    /// The signed-in user's own allowance — the account screen's number.
    ///
    /// Tier comes from SubscriptionService, the one definition of entitlement.
    /// Reading `isMax` BEFORE `effectiveIsPro` matters: a Max subscriber is also
    /// Pro, so the other order reports Max users their Pro allowance — the same
    /// shape as the isMax-omitted entitlement bug this codebase has already paid
    /// for once.
    @MainActor
    var videosLimitForCurrentTier: Int? {
        // A scalar IS this value — the server resolved the tier already — so it
        // wins over a tier lookup that would be nil under that shape. The
        // per-tier accessors above deliberately do NOT fall back to it: one
        // number cannot tell the Pro card from the Max card, and filling both
        // rows from it would print the same allowance on two different tiers.
        if let own = positive(snapshot?.videos_limit?.own) { return own }
        let sub = SubscriptionService.shared
        if sub.isMax { return videosLimitMax }
        if sub.effectiveIsPro { return videosLimitPro }
        return videosLimitFree
    }
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

    // §5 progressive playback gate (default off until the HLS player path ships).
    var progressivePlaybackEnabled: Bool { snapshot?.progressive_playback_enabled ?? false }

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
