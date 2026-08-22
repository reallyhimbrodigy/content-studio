import Foundation
import SwiftUI

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

    /// My referral code, cached once fetched (also lives on profiles.referral_code).
    @Published private(set) var myCode: String?
    /// Qualified-but-uncounted referrals toward the next reward, for display.
    @Published private(set) var qualifiedCount: Int = 0

    private init() {}

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

    /// Manual entry path ("Have a referral code?") — same persistence + claim.
    func enterCodeManually(_ code: String) {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        UserDefaults.standard.set(trimmed, forKey: Self.pendingCodeKey)
        if AuthService.shared.isAuthenticated {
            Task { await claimPendingIfAny() }
        }
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
        let resp = await rpc(function: "claim_referral",
                             body: ["p_referred": uid, "p_code": code],
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
            }
            UserDefaults.standard.removeObject(forKey: Self.pendingCodeKey)
        case 400...499:
            UserDefaults.standard.removeObject(forKey: Self.pendingCodeKey)
        default:
            break // transient (offline / 5xx): keep pending, retry next session
        }
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

    static func shareURL(code: String) -> URL {
        URL(string: "https://usepromptly.app/?ref=\(code)")!
    }

    /// Open the system share sheet with the referral link. Reuses the app's
    /// topmost-VC presentation pattern (AppState.topViewController).
    func presentShareSheet() async {
        guard let code = await getOrCreateCode() else { return }
        Analytics.track("referral_share")
        let link = Self.shareURL(code: code)
        // Honest per the schema: the reward (7 days Pro at 3 qualified friends)
        // goes to the REFERRER — never promise the invitee something the
        // server doesn't grant.
        let text = "I edit my videos by just talking to Promptly. Try it with my code — when you make your first video it counts toward my free week of Pro."
        let activity = UIActivityViewController(activityItems: [text, link], applicationActivities: nil)
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
