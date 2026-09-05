import Foundation
import SwiftUI
import Combine

/// The referral program's client legs (conversion workstream; schema live
/// server-side 2026-08-21). Three responsibilities:
///
///   1. SHARE — get_or_create_referral_code(p_user) for the share sheet; the
///      shareable link is https://usepromptly.app/?ref=CODE (an https link so
///      it works for people WITHOUT the app; the landing page carries the code
///      across install).
///   2. CLAIM — a ?ref= code that reaches the app (deep link today via the
///      registered app.usepromptly.ios:// scheme; universal links when the
///      entitlement + AASA ship) is persisted pre-auth and claimed exactly once
///      at sign-in via claim_referral(p_referred, p_code).
///   3. PROGRESS — "2 of 3 friends": a referral QUALIFIES when the referred
///      friend completes their first render (qualify_referral, server-side),
///      and 3 qualified referrals grant 7 days of Pro (grant_referral_reward).
///      Progress = qualified-but-not-yet-counted referrals for me as referrer.
///
/// RPC calls use the app's established direct-PostgREST pattern (anon apikey +
/// the user's JWT). PARAMETER NAMES ARE LOAD-BEARING: PostgREST matches by
/// name (p_user / p_code / p_referred) and a mismatch is a silent no-op.
@MainActor
final class ReferralService: ObservableObject {
    static let shared = ReferralService()

    private static let supabaseUrl = "https://ejxkzsfruykvgeouymfy.supabase.co"
    private static let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE"
    private static let pendingCodeKey = "pending_referral_code"
    /// The reward threshold ("N of 3 friends"). Server-owned in
    /// grant_referral_reward; mirrored here for display only.
    static let rewardTarget = 3

    /// Whether the referral loop should be OFFERED to this user at all.
    ///
    /// Max subscribers are excluded (ruled 2026-09-01). The referral reward is
    /// subscription time, and someone already on the top tier has nothing to
    /// win — so the ask is work with no payoff, on the surface of the product
    /// they pay the most for. Worse, the post-render card is the live one: a
    /// Max user finishes a render and gets asked to recruit three friends for a
    /// reward they cannot receive.
    ///
    /// THIS IS ONE PROPERTY, READ BY EVERY SURFACE, on purpose. The count and
    /// the share button drifted apart once already by being decided
    /// per-surface, and there are six places that show one or the other. A rule
    /// enforced in six copies is a rule that is about to be enforced in five.
    @MainActor
    var shouldOffer: Bool { !SubscriptionService.shared.isMax }

    /// My referral code, cached once fetched (also lives on profiles.referral_code).
    @Published private(set) var myCode: String?
    /// Qualified-but-uncounted referrals toward the next reward, for display.
    @Published private(set) var qualifiedCount: Int = 0

    private var cancellables = Set<AnyCancellable>()

    private init() {
        // Republish when the Max entitlement changes.
        //
        // `shouldOffer` reads SubscriptionService, but SwiftUI only redraws a
        // view when an object the view OBSERVES changes. Six surfaces observe
        // this service; none of them observe SubscriptionService for this
        // purpose. Without this forward, a user who upgrades to Max keeps
        // seeing the referral ask until something unrelated happens to redraw
        // the screen — which is indistinguishable from the suppression not
        // working, and would be reported as exactly that.
        SubscriptionService.shared.$isMax
            .removeDuplicates()
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
    }

    // MARK: - Deep link intake (?ref=CODE on any URL that reaches the app)

    /// Root .onOpenURL handler. Accepts ?ref= on any incoming URL (custom
    /// scheme today; https universal links when provisioned). The code is
    /// persisted pre-auth — install→signup survival is the landing page's job
    /// (deferred deep links need an attribution SDK we don't carry).
    func handleIncomingURL(_ url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let code = components.queryItems?.first(where: { $0.name == "ref" })?.value?
                  .trimmingCharacters(in: .whitespacesAndNewlines),
              !code.isEmpty else { return }
        UserDefaults.standard.set(code, forKey: Self.pendingCodeKey)
        Analytics.track("referral_link_opened")
        // Already signed in (link tapped post-auth): claim right away.
        if AuthService.shared.isAuthenticated {
            Task { await claimPendingIfAny() }
        }
    }

    /// The code alphabet, shared with the landing page's validator: A–Z minus
    /// O/I/L and digits 2–9 (no 0/1), so a code is unambiguous when read aloud
    /// off a screen and retyped — which is exactly what the fresh-install path
    /// asks a person to do.
    static func isValidCode(_ code: String) -> Bool {
        let c = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard (4...12).contains(c.count) else { return false }
        return c.allSatisfy { "ABCDEFGHJKMNPQRSTUVWXYZ23456789".contains($0) }
    }

    /// Manual entry path ("Have an invite code?") — same persistence + claim as
    /// the link path, deliberately: both funnel into `pendingCodeKey` and are
    /// redeemed by `claimPendingIfAny` at sign-in, so there is one redemption
    /// path to reason about rather than two that can diverge.
    ///
    /// This existed with ZERO callers until the entry field was built. The
    /// landing page has been telling recipients to "enter the code at signup"
    /// while the app had nowhere to enter it — and the fresh-install path is
    /// the one that carries the volume, because a universal link only opens the
    /// app for someone who already has it.
    ///
    /// UPPERCASED here, not just trimmed. `claim_referral` normalises with
    /// `upper(trim())` so a lowercase code would still resolve, but the value
    /// is also what we echo back to the user and what rides on the analytics
    /// event, and two casings of one code read as two codes.
    @discardableResult
    func enterCodeManually(_ code: String) -> Bool {
        let normalised = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard Self.isValidCode(normalised) else {
            Analytics.track("referral_code_entry_rejected", props: ["reason": "malformed"])
            return false
        }
        UserDefaults.standard.set(normalised, forKey: Self.pendingCodeKey)
        Analytics.track("referral_code_entered", props: ["source": "signup", "context": "signup"])
        if AuthService.shared.isAuthenticated {
            Task { await claimPendingIfAny() }
        }
        return true
    }

    /// A code is already waiting (link path, or an earlier manual entry). The
    /// entry field reads this so a recipient whose link DID carry the code is
    /// shown that it landed, rather than being asked for it a second time.
    var pendingCode: String? {
        UserDefaults.standard.string(forKey: Self.pendingCodeKey)
    }

    // MARK: - Claim (exactly once, at sign-in)

    /// Called from AuthService.saveSession's post-auth fan-out. saveSession
    /// also fires on token refresh, so once-only comes from CONSUMING the
    /// pending code: 2xx or a terminal 4xx (bad/own/expired code) deletes it;
    /// only transient failures leave it for the next session. The server
    /// additionally enforces once-per-referred-user.
    func claimPendingIfAny() async {
        guard let code = UserDefaults.standard.string(forKey: Self.pendingCodeKey),
              let uid = AuthService.shared.currentUser?.id,
              let token = await AuthService.shared.getValidToken() else { return }
        // The device rides the claim (ruled 2026-09-05: a referral is an
        // INSTALL). The database refuses the referrer's own device and any
        // device already referred — the two reinstall-farming paths.
        let resp = await rpc(function: "claim_referral",
                             body: ["p_referred": uid, "p_code": code,
                                    "p_device": Analytics.deviceIdForJoin],
                             token: token)
        // VERIFIED CONTRACT (probe 2026-08-22): the RPC answers 200 with a
        // structured body — {"ok":true} on success, {"ok":false,"reason":
        // "unknown_code"|…} on any terminal rejection. Both are TERMINAL:
        // consume the pending code (retrying an unknown/own/used code can never
        // succeed). Only transport-level failures (0/5xx) keep it for retry.
        struct ClaimResult: Codable { let ok: Bool; let reason: String? }
        switch resp.status {
        case 200...299:
            let result = resp.data.flatMap { try? JSONDecoder().decode(ClaimResult.self, from: $0) }
            if result?.ok == true {
                Analytics.track("referral_claimed", durable: true)
                // Settle the REFERRER's reward now, from this side: the
                // referrer need not open the app for the third install to
                // pay. The server reads the referrer from the referral row.
                _ = await serverPost("/api/referral/claimed", token: token)
            } else if let reason = result?.reason {
                Analytics.track("referral_claim_rejected", props: ["reason": reason], durable: true)
            }
            UserDefaults.standard.removeObject(forKey: Self.pendingCodeKey)
        case 400...499:
            UserDefaults.standard.removeObject(forKey: Self.pendingCodeKey)
        default:
            break // transient (offline / 5xx): keep pending, retry next session
        }
    }

    // MARK: - Reward (referrer side)

    /// Ask the server to settle anything owed to THIS user as a referrer.
    /// Called from the sign-in fan-out; idempotent (the server counts each
    /// install once and pays once). When days land, the usage snapshot is
    /// refreshed so `pro_until` shows without a relaunch.
    func reconcileRewardsIfAny() async {
        guard AuthService.shared.currentUser?.id != nil,
              let token = await AuthService.shared.getValidToken() else { return }
        let resp = await serverPost("/api/referral/reconcile", token: token)
        struct R: Codable { let ok: Bool; let days: Int?; let installs: Int? }
        guard (200...299).contains(resp.status), let data = resp.data,
              let r = try? JSONDecoder().decode(R.self, from: data) else { return }
        if let d = r.days, d > 0 {
            Analytics.track("referral_reward_received", props: ["days": d], durable: true)
            await UsageService.shared.refresh()
        }
    }

    private func serverPost(_ path: String, token: String) async -> (status: Int, data: Data?) {
        guard let url = URL(string: "https://usepromptly.app\(path)") else { return (0, nil) }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        req.timeoutInterval = 8
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse else { return (0, nil) }
        return (http.statusCode, data)
    }

    // MARK: - Share

    /// My code, creating it server-side on first use (idempotent RPC).
    func getOrCreateCode() async -> String? {
        if let code = myCode { return code }
        guard let uid = AuthService.shared.currentUser?.id,
              let token = await AuthService.shared.getValidToken() else { return nil }
        let resp = await rpc(function: "get_or_create_referral_code",
                             body: ["p_user": uid], token: token)
        guard (200...299).contains(resp.status), let data = resp.data,
              let code = (try? JSONDecoder().decode(String.self, from: data))?
                  .trimmingCharacters(in: .whitespacesAndNewlines),
              !code.isEmpty else { return nil }
        myCode = code
        return code
    }

    // The link is built by ReferralCopy.shareURL, which is the ONE definition.
    // A `shareURL` used to live here too, building the string itself with a
    // force-unwrap and no uppercasing — so the casing contract rested on
    // whatever `get_or_create_referral_code` happened to return. `claim_referral`
    // resolves with `upper(trim())` and the landing-page paste path shows the
    // code to a human, so it must be uppercase where we emit it, not by luck.
    // Removed rather than kept as a delegating shim: it had no callers left,
    // and a second name for one thing is how the two drift apart again.

    /// A referral surface was SEEN. Without this there is no denominator: all
    /// four surfaces could report shares and none could report a share RATE, so
    /// the ladder's whole purpose — making the first invite pay, and thereby
    /// lifting the share rate — was unmeasurable.
    ///
    /// Fires once per surface per appearance. Carries both keys for the same
    /// reason presentShareSheet does.
    func trackImpression(source: String) {
        Analytics.track("referral_shown", props: ["source": source, "context": source])
    }

    /// Open the system share sheet with the referral link. Reuses the app's
    /// topmost-VC presentation pattern (AppState.topViewController).
    func presentShareSheet(source: String = "paywall2") async {
        guard let code = await getOrCreateCode() else { return }
        // `context` alongside `source`: every other funnel in this app keys on
        // `context`, so referral was invisible to all of them — including the
        // canonical revenue-per-wall-view read. `source` is kept because 123
        // existing shares carry it and dropping it would orphan them.
        Analytics.track("referral_share", props: ["source": source, "context": source])

        // ONE message, from ReferralCopy. This surface used to spell its own:
        //   "…when you make your first video it counts toward my free week of Pro."
        // Two things were wrong with it. It described a reward ladder we no
        // longer run (a week at three friends; the ladder now pays from the
        // first qualified invite), so the copy drifted the moment the ladder
        // changed — exactly the failure ReferralCopy exists to prevent. And it
        // told the recipient they were doing the sender a favour, which is a
        // weaker opening than the product claim and is the clause that makes
        // the message read as two-sided.
        //
        // The approved message says nothing about a reward at all, which is
        // also what keeps the loop referrer-only under guideline 3.2.2.
        let text = ReferralCopy.shareMessage(code: code)
        // The link rides INSIDE the message rather than as a second activity
        // item: shareMessage already places it on its own line so the rich
        // preview attaches, and passing it twice made some targets paste the
        // URL a second time under the text.
        let activity = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        guard let top = AppState.topViewController() else { return }
        if let pop = activity.popoverPresentationController {
            pop.sourceView = top.view
            pop.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
            pop.permittedArrowDirections = []
        }
        top.present(activity, animated: true)
    }

    // MARK: - Progress ("2 of 3 friends")

    /// Refresh the qualified-not-yet-counted count for the progress display.
    /// Requires an RLS SELECT policy on referrals for the referrer; degrades to
    /// 0 silently if the read is denied (display-only, never blocks).
    func refreshProgress() async {
        guard let uid = AuthService.shared.currentUser?.id,
              let token = await AuthService.shared.getValidToken() else { return }
        var req = URLRequest(url: URL(string:
            "\(Self.supabaseUrl)/rest/v1/referrals?referrer_id=eq.\(uid)&select=qualified_at,counted_at")!)
        req.setValue(Self.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 8
        struct Row: Codable { let qualified_at: String?; let counted_at: String? }
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
              let rows = try? JSONDecoder().decode([Row].self, from: data) else { return }
        qualifiedCount = rows.filter { $0.qualified_at != nil && $0.counted_at == nil }.count
    }

    // MARK: - Plumbing

    private func rpc(function: String, body: [String: String], token: String)
        async -> (status: Int, data: Data?) {
        guard let url = URL(string: "\(Self.supabaseUrl)/rest/v1/rpc/\(function)") else {
            return (0, nil)
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(Self.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 8
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse else { return (0, nil) }
        return (http.statusCode, data)
    }
}
