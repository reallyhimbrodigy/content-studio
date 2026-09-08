import Foundation
import Observation

@Observable
class AuthService {
    static let shared = AuthService()

    private let supabaseUrl = "https://ejxkzsfruykvgeouymfy.supabase.co"
    private let supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE"

    var isAuthenticated = false
    var currentUser: AuthUser?
    var accessToken: String?
    var isLoading = true

    private let tokenKey = "promptly_access_token"
    private let refreshKey = "promptly_refresh_token"
    private let tokenExpiryKey = "promptly_token_expiry"
    private var refreshTask: Task<Void, Never>?

    /// THE ONLY READ OF THE REFRESH TOKEN. Keychain first, UserDefaults as the
    /// one-release migration fallback — the same order `checkSession` always
    /// used, and now the order the two REFRESH paths use as well.
    ///
    /// They didn't. `getValidToken` and `scheduleTokenRefresh` each read
    /// UserDefaults directly, so the store the session actually lives in was
    /// invisible to both. The case that bites: a delete-and-reinstall (or any
    /// path that clears the Data container) wipes UserDefaults and leaves the
    /// Keychain — which is the entire reason the session moved there.
    /// `checkSession` then restores from the Keychain and, because the expiry
    /// also lived in the wiped UserDefaults, `expiry == 0` makes `needsRefresh`
    /// permanently true. If that launch refresh fails SOFTLY (offline, 5xx) the
    /// session is deliberately kept — and from then on neither refresh path can
    /// find a refresh token, so every call rides an expired JWT and comes back
    /// 401 until the next launch that has network.
    ///
    /// It is also a landmine for the release that drops the UserDefaults mirror
    /// `saveSession` writes: on that build these two paths would find nothing
    /// for ANY user, and no session could ever refresh. One reader, one order.
    private var storedRefreshToken: String? {
        Keychain.get(refreshKey) ?? UserDefaults.standard.string(forKey: refreshKey)
    }

    private init() {}

    // MARK: - Session Management

    func checkSession() async {
        // Keychain first, UserDefaults as the one-release migration fallback.
        guard let token = Keychain.get(tokenKey) ?? UserDefaults.standard.string(forKey: tokenKey),
              let refreshToken = storedRefreshToken else {
            isLoading = false
            return
        }

        // Default state: ADOPT the cached session immediately so the
        // app starts in the authenticated state even before we've
        // talked to Supabase. If the verification calls below come
        // back with a hard auth failure, we'll sign out then. Until
        // then the user stays logged in — same behavior as every
        // mobile app that doesn't kick you out on every launch.
        accessToken = token

        let expiry = UserDefaults.standard.double(forKey: tokenExpiryKey)
        let needsRefresh = expiry == 0 || Date().timeIntervalSince1970 > (expiry - 300)

        if needsRefresh {
            do {
                try await refreshSession(refreshToken: refreshToken)
                isAuthenticated = true
            } catch AuthError.sessionExpired {
                // Refresh token genuinely invalid — sign out.
                print("[auth] checkSession: refresh token rejected, signing out")
                signOut()
                isLoading = false
                return
            } catch {
                // Soft failure (network, 5xx). Try the existing access
                // token to confirm we're still valid — if /user comes
                // back 200 we stay signed in. If /user also fails
                // softly, we OPTIMISTICALLY adopt the cached session
                // and let the user keep working until something hard
                // says otherwise.
                do {
                    let user = try await getUser(token: token)
                    currentUser = user
                    isAuthenticated = true
                } catch AuthError.sessionExpired {
                    print("[auth] checkSession: access token rejected after refresh failure, signing out")
                    signOut()
                    isLoading = false
                    return
                } catch {
                    // Both refresh and getUser hit network/5xx errors.
                    // KEEP the cached session — offline-tolerant. The
                    // next API call will hit the same wall but at
                    // least we don't kick the user out for being on
                    // the subway.
                    print("[auth] checkSession: soft failures on refresh + getUser — keeping cached session")
                    isAuthenticated = true
                }
            }
        } else {
            // Cached token isn't due for refresh yet. Verify with /user.
            do {
                let user = try await getUser(token: token)
                currentUser = user
                isAuthenticated = true
            } catch AuthError.sessionExpired {
                // Token's actually invalid (revoked server-side, etc).
                // Try a refresh in case the refresh token still works.
                do {
                    try await refreshSession(refreshToken: refreshToken)
                    isAuthenticated = true
                } catch {
                    print("[auth] checkSession: both tokens rejected, signing out")
                    signOut()
                    isLoading = false
                    return
                }
            } catch {
                // Network/5xx on getUser. Adopt cached session.
                print("[auth] checkSession: /user soft failure — adopting cached session")
                isAuthenticated = true
            }
        }

        isLoading = false
        scheduleTokenRefresh()
    }

    /// Get a valid token, refreshing if needed. Use this for ALL API calls.
    /// On NETWORK failure (offline, 5xx, timeout) returns the stale token
    /// rather than signing out — production apps survive intermittent
    /// connectivity without kicking the user back to the login screen.
    /// Only on HARD auth failure (refresh token actually rejected) do we
    /// sign out.
    func getValidToken() async -> String? {
        guard let token = accessToken else { return nil }

        let expiry = UserDefaults.standard.double(forKey: tokenExpiryKey)
        let needsRefresh = expiry == 0 || Date().timeIntervalSince1970 > (expiry - 300)

        if needsRefresh, let refreshToken = storedRefreshToken {
            do {
                try await refreshSession(refreshToken: refreshToken)
                return accessToken
            } catch AuthError.sessionExpired {
                print("[auth] getValidToken: hard refresh failure — signing out")
                signOut()
                return nil
            } catch {
                // Soft failure. Return the stale token; the caller's
                // API hit will surface a network error if it really
                // can't reach Supabase. Better that than booting the
                // user mid-flow because their cellular blipped.
                print("[auth] getValidToken: soft refresh failure (\(error.localizedDescription)) — keeping session")
                return token
            }
        }

        return token
    }

    // MARK: - Auth Actions

    // MARK: - Passwordless OTP
    //
    // Two-step email flow: send the user a 6-digit code, then exchange
    // that code for a session. Supabase's /auth/v1/otp endpoint also
    // auto-creates the user on first attempt, so the same flow handles
    // both sign-up and sign-in — no need for a "create account" branch
    // in the UI.

    /// Send a 6-digit verification code to the given email. Supabase
    /// generates the code, picks the template (Magic Link), and SMTPs it
    /// out via Resend. Idempotent — safe to retry if the user didn't get
    /// the email.
    /// SIGN IN ANONYMOUSLY AT LAUNCH (ruled 2026-09-06).
    ///
    /// Deferred auth gates exactly one seam — purchase — and everything else
    /// runs on this session: chat, upload, render, re-edit, share. The user has
    /// a real `user_id` from first launch, so jobs, credits and history are
    /// attributable without ever asking for an email.
    ///
    /// Idempotent: returns immediately if a session already exists, so it is
    /// safe to call on every launch. Never creates a second user.
    @discardableResult
    func signInAnonymouslyIfNeeded() async -> Bool {
        if currentUser?.id != nil { return true }

        // THE MIGRATION WINS (blocker on 249). This checked only the Keychain,
        // so a user updating FROM a build that stored the session in
        // UserDefaults had no Keychain entry, looked brand new, and was handed a
        // fresh anonymous user — losing their account, their Pro entitlement and
        // their history on the update. An anonymous user is created only when
        // NEITHER store has a session.
        if migrateSessionToKeychainIfNeeded() { return true }
        if Keychain.get(tokenKey) != nil { return true }
        do {
            var req = URLRequest(url: URL(string: "\(supabaseUrl)/auth/v1/signup")!)
            req.httpMethod = "POST"
            req.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            // THE DEVICE ID RIDES THE SIGNUP (ruled 2026-09-06). GoTrue puts
            // `data` into raw_user_meta_data, which is what the per-device rate
            // limit keys on — without it the limit has nothing to count and
            // throttles nothing, so one simulator could mint users forever.
            // Analytics.deviceIdForJoin is Keychain-backed, so it is the same id
            // across reinstalls and the same one the funnel joins on.
            req.httpBody = try JSONSerialization.data(withJSONObject: [
                "data": ["device_id": Analytics.deviceIdForJoin]
            ])
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                let body = String(data: data, encoding: .utf8) ?? ""
                // `anonymous_provider_disabled` means the project setting is off.
                // Fail QUIETLY and leave the app signed out rather than blocking
                // launch — the seams are already open, so the user still gets in.
                Analytics.track("anon_signin_failed", props: [
                    "status": (resp as? HTTPURLResponse)?.statusCode ?? -1,
                    "body": String(body.prefix(120)),
                ], durable: true)
                return false
            }
            let session = try JSONDecoder().decode(SupabaseSession.self, from: data)
            saveSession(session)
            Analytics.track("anon_signin_ok", props: ["user_id": session.user.id])
            return true
        } catch {
            Analytics.track("anon_signin_failed", props: ["error": "\(error)"], durable: true)
            return false
        }
    }

    /// LINK, DO NOT CREATE (ruled 2026-09-06).
    ///
    /// At the purchase seam the anonymous user adds an email identity rather
    /// than signing in as somebody new. GoTrue keeps the SAME `user_id` when an
    /// anonymous user is updated with an email, so every job, credit and chat
    /// already written under it carries over. Signing in fresh here would mint a
    /// second user and orphan all of it.
    ///
    /// Returns false when there is no anonymous session to link, in which case
    /// the caller falls back to the ordinary OTP path.
    /// Moves a UserDefaults-era session into the Keychain and adopts it.
    ///
    /// Returns true when a session exists in EITHER store, which is the caller's
    /// signal not to create an anonymous user. The Keychain is written first so
    /// a crash mid-migration cannot lose the only copy; UserDefaults is left in
    /// place for one release, exactly as `saveSession` mirrors it.
    @discardableResult
    func migrateSessionToKeychainIfNeeded() -> Bool {
        if Keychain.get(tokenKey) != nil { return true }
        let d = UserDefaults.standard
        guard let token = d.string(forKey: tokenKey),
              let refresh = d.string(forKey: refreshKey),
              !token.isEmpty, !refresh.isEmpty else { return false }
        _ = Keychain.set(token, for: tokenKey)
        _ = Keychain.set(refresh, for: refreshKey)
        Analytics.track("session_migrated_to_keychain", props: [:], durable: true)
        return true
    }

    /// What the purchase seam should do with the email it was given.
    enum LinkOutcome {
        /// A new identity was attached to the anonymous user; same user_id, and
        /// the code that follows verifies as `email_change`.
        case linked
        /// The email already belongs to an account. This is a RECOVERY, not a
        /// link: sign in to that account the ordinary way and let the anonymous
        /// user go. GoTrue refuses the link with 422 `email_exists`, and
        /// treating that as a failure is what stranded a returning user on a
        /// device that had gone anonymous.
        case existingAccount
        /// Nothing to link — no anonymous session. Ordinary sign-in.
        case notAnonymous
    }

    func linkEmailIdentity(email: String) async throws -> LinkOutcome {
        guard let token = await getValidToken(), currentUser?.isAnonymous == true else {
            return .notAnonymous
        }
        var req = URLRequest(url: URL(string: "\(supabaseUrl)/auth/v1/user")!)
        req.httpMethod = "PUT"
        req.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["email": email])
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            if body.contains("email_exists") {
                Analytics.track("identity_link_existing_account", props: [:], durable: true)
                return .existingAccount
            }
            Analytics.track("identity_link_failed", props: [
                "status": (resp as? HTTPURLResponse)?.statusCode ?? -1,
                "body": String(body.prefix(120)),
            ], durable: true)
            throw AuthError.signInFailed(String(body.prefix(200)))
        }
        Analytics.track("identity_link_sent", props: ["user_id": currentUser?.id ?? ""])
        return .linked
    }

    func sendOtp(email: String) async throws {
        let url = URL(string: "\(supabaseUrl)/auth/v1/otp")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        // `create_user: true` ensures first-time visitors get an account
        // created on send rather than getting a "user not found" error.
        // `email_otp` channel = 6-digit code path (vs. magic link).
        let body: [String: Any] = [
            "email": email,
            "create_user": true
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let bodyStr = String(data: data, encoding: .utf8) ?? ""
            print("[auth] sendOtp HTTP \((response as? HTTPURLResponse)?.statusCode ?? -1): \(bodyStr.prefix(300))")
            throw AuthError.signInFailed(bodyStr)
        }
    }

    /// Exchange a 6-digit code for a Supabase session. Same flow handles
    /// both sign-up confirmation and sign-in — Supabase returns a session
    /// in both cases. `type: "email"` is what tells Supabase to treat
    /// the token as an email OTP code (vs. a magic-link nonce or SMS).
    /// THE LINK LEG VERIFIES WITH `email_change`, NOT `email` (measured
    /// 2026-09-06, not assumed). A real exchange on a throwaway user:
    ///
    ///     verify type=magiclink    -> HTTP 403 otp_expired
    ///     verify type=email_change -> HTTP 200
    ///
    /// so a token minted by `linkEmailIdentity` is refused by every other type.
    /// That is what stops the link path silently regressing into `sendOtp`,
    /// which looks a user up BY EMAIL and would mint a second user.
    ///
    /// `linking` is set by the caller when the code came from the link flow.
    func verifyOtp(email: String, code: String, linking: Bool = false) async throws {
        let url = URL(string: "\(supabaseUrl)/auth/v1/verify")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        let body: [String: String] = [
            "type": linking ? "email_change" : "email",
            "email": email,
            "token": code
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let bodyStr = String(data: data, encoding: .utf8) ?? ""
            print("[auth] verifyOtp HTTP \((response as? HTTPURLResponse)?.statusCode ?? -1): \(bodyStr.prefix(300))")
            throw AuthError.signInFailed(bodyStr)
        }
        let session = try JSONDecoder().decode(SupabaseSession.self, from: data)
        saveSession(session)
        scheduleTokenRefresh()
        // Funnel top (audit 2026-08-26): the auth flow was the app's largest
        // uninstrumented surface — signup_complete fires on INTERACTIVE auth
        // success only; session restores never emit.
        Analytics.track("signup_complete", props: ["method": "email_otp"])
    }

    /// Exchange an OAuth provider's id_token for a Supabase session.
    ///
    /// Apple Sign-In REQUIRES `nonce` — the raw (unhashed) nonce that
    /// was hashed with SHA256 and embedded in the original Apple
    /// authorization request. Supabase validates that the hash of the
    /// nonce we send here matches the hash baked into the id_token
    /// JWT by Apple. Without it, Supabase rejects the token with
    /// `"unable to validate token"` — which is the silent failure
    /// users were seeing on the Apple button.
    func signInWithIdToken(provider: String, idToken: String, nonce: String? = nil) async throws {
        let url = URL(string: "\(supabaseUrl)/auth/v1/token?grant_type=id_token")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")

        var body: [String: String] = [
            "provider": provider,
            "id_token": idToken
        ]
        if let nonce, !nonce.isEmpty {
            body["nonce"] = nonce
        }
        request.httpBody = try JSONEncoder().encode(body)
        print("[auth] signInWithIdToken provider=\(provider) hasNonce=\(nonce != nil && !nonce!.isEmpty)")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            let errorBody = String(data: data, encoding: .utf8) ?? ""
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            // Print the full body so we can diagnose nonce mismatches,
            // invalid issuer errors, etc. Production-safe: this only
            // logs Supabase's own error message, not the id_token.
            print("[auth] signInWithIdToken \(provider) HTTP \(status): \(errorBody.prefix(500))")
            throw AuthError.signInFailed(errorBody)
        }

        let session = try JSONDecoder().decode(SupabaseSession.self, from: data)
        saveSession(session)
        scheduleTokenRefresh()
        Analytics.track("signup_complete", props: ["method": provider])
        print("[auth] signInWithIdToken \(provider) success")
    }

    // MARK: - Linking a provider to the live anonymous session

    /// True when the session we hold belongs to an anonymous user — the case
    /// where signing in must LINK rather than sign in.
    var hasAnonymousSession: Bool {
        isAuthenticated && (currentUser?.isAnonymous ?? false)
    }

    enum OAuthLinkError: LocalizedError {
        /// GOTRUE_SECURITY_MANUAL_LINKING_ENABLED is off on the project. Not a
        /// client bug and not recoverable in the client: every link call 404s
        /// until it is turned on.
        case linkingDisabled
        /// This provider identity already belongs to another account. The only
        /// correct move is a plain sign-in to THAT account — see the caller.
        case identityAlreadyExists
        case failed(String)

        var errorDescription: String? {
            switch self {
            case .linkingDisabled: return "Linking is turned off for this project."
            case .identityAlreadyExists: return "That account already exists."
            case .failed(let m): return m
            }
        }
    }

    /// The provider URL that links `provider` to the CURRENT session.
    ///
    /// WHY THIS EXISTS. Both providers previously went to a SIGN-IN endpoint —
    /// Apple to `token?grant_type=id_token`, Google to `authorize?provider=` —
    /// and both of those MINT A NEW USER. With an anonymous session already
    /// holding the person's videos and chats, that is the whole defect: the
    /// sign-in "worked", against an empty account, and their work stayed on a
    /// user nothing could reach again.
    ///
    /// `skip_http_redirect` is what makes this usable from an app: without it
    /// GoTrue 302s to the provider, and ASWebAuthenticationSession cannot carry
    /// the Authorization header that identifies the session being linked. With
    /// it we get the URL back as JSON and hand THAT to the browser, with the
    /// linking context already baked into its state parameter.
    func oauthLinkURL(provider: String, redirectTo: String) async throws -> URL {
        guard let token = await getValidToken() else {
            throw OAuthLinkError.failed("No session to link to")
        }
        var comps = URLComponents(string: "\(supabaseUrl)/auth/v1/user/identities/authorize")!
        comps.queryItems = [
            URLQueryItem(name: "provider", value: provider),
            URLQueryItem(name: "redirect_to", value: redirectTo),
            URLQueryItem(name: "skip_http_redirect", value: "true"),
        ]
        var request = URLRequest(url: comps.url!)
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        let body = String(data: data, encoding: .utf8) ?? ""
        guard status == 200 else {
            print("[auth] link authorize \(provider) HTTP \(status): \(body.prefix(300))")
            if body.contains("manual_linking_disabled") { throw OAuthLinkError.linkingDisabled }
            if body.contains("identity_already_exists") { throw OAuthLinkError.identityAlreadyExists }
            throw OAuthLinkError.failed(body)
        }
        struct LinkAuthorize: Decodable { let url: String }
        guard let decoded = try? JSONDecoder().decode(LinkAuthorize.self, from: data),
              let url = URL(string: decoded.url) else {
            throw OAuthLinkError.failed("Link URL missing from response")
        }
        print("[auth] link authorize \(provider) -> \(url.host ?? "?")")
        return url
    }

    /// Adopt an OAuth session built from a redirect-URL fragment
    /// (Google / GitHub / etc. via Supabase implicit OAuth). The caller
    /// extracts `access_token` + `refresh_token` from the URL fragment;
    /// this fetches the user record and persists everything.
    func adoptOAuthSession(accessToken: String, refreshToken: String) async throws {
        let user = try await getUser(token: accessToken)
        let session = SupabaseSession(
            access_token: accessToken,
            refresh_token: refreshToken,
            user: user
        )
        saveSession(session)
        scheduleTokenRefresh()
    }

    func signOut() {
        // Tell the server to drop our APNs token before we toss our auth
        // token — once the auth token is gone we can't authenticate the
        // unregister call. Fire-and-forget; we don't want sign-out to hang
        // on a flaky network.
        Task { @MainActor in
            await PushService.shared.unregisterCurrentDevice()
        }
        // Wipe cached videos so the next user on this device can't see
        // the previous user's content.
        Task { @MainActor in
            VideoCache.shared.purgeAll()
        }
        // Clear the chat list singleton. Without this, the next user
        // signing in on this device sees the previous user's chats
        // lingering in memory until ChatStore.loadChats happens to refresh
        // them — which masquerades as "data still here" while the Library
        // is correctly empty for the new account.
        Task { @MainActor in
            ChatStore.shared.clearForSignOut()
        }
        // Detach the RevenueCat identity. Otherwise the next user that
        // signs in on this device starts a session aliased to the
        // previous user's app_user_id, which corrupts both attribution
        // and the webhook → profiles update target.
        Task { @MainActor in
            await SubscriptionService.shared.clearIdentity()
        }
        // Detach the PostHog identity + clear super-properties (tier/country) so
        // the next user on this device starts a clean, un-merged analytics
        // session rather than inheriting the previous person's identity.
        Analytics.reset()
        refreshTask?.cancel()
        refreshTask = nil
        // THE KEYCHAIN TOO. The session moved there, so clearing only
        // UserDefaults left the user signed in — log out, relaunch, and they are
        // back. Then a fresh anonymous session, because signed out is not the
        // same as no session: every path except purchase runs on one.
        _ = Keychain.delete(tokenKey)
        _ = Keychain.delete(refreshKey)
        UserDefaults.standard.removeObject(forKey: tokenKey)
        UserDefaults.standard.removeObject(forKey: refreshKey)
        UserDefaults.standard.removeObject(forKey: tokenExpiryKey)
        Task { @MainActor in
            _ = await self.signInAnonymouslyIfNeeded()
        }
        accessToken = nil
        currentUser = nil
        // Return the app to its initial route. AppState is a process-lifetime
        // singleton, so selectedTab survives sign-out; and the Sign Out button
        // lives on the Account tab (selectedTab == 2). Without this reset, the
        // NEXT in-session login re-shows AppShell still on Account — while the
        // always-mounted EditorView's composer auto-focus (EditorView.onAppear)
        // raises the keyboard on the hidden Edit tab. Net symptom: "login lands
        // on Account with the keyboard already up." Resetting to 0 makes every
        // login land on Edit/chat with the composer focused — intentionally.
        AppState.shared.selectedTab = 0
        isAuthenticated = false
    }

    func updateUserName(_ name: String) async throws {
        guard let token = await getValidToken() else { throw AuthError.sessionExpired }
        let url = URL(string: "\(supabaseUrl)/auth/v1/user")!
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(["data": ["full_name": name]])

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw AuthError.updateFailed
        }
        currentUser = try await getUser(token: token)
    }

    func getUserTier() async -> String {
        guard let token = await getValidToken(), let userId = currentUser?.id else { return "free" }
        let url = URL(string: "\(supabaseUrl)/rest/v1/profiles?id=eq.\(userId)&select=tier")!
        var request = URLRequest(url: url)
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            let profiles = try JSONDecoder().decode([UserProfile].self, from: data)
            return profiles.first?.tier?.lowercased() ?? "free"
        } catch {
            return "free"
        }
    }

    // MARK: - Private

    private func getUser(token: String) async throws -> AuthUser {
        let url = URL(string: "\(supabaseUrl)/auth/v1/user")!
        var request = URLRequest(url: url)
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            // Network-level failure — connection dropped, timeout, etc.
            // Throw `networkError`, NOT `sessionExpired`, so callers
            // don't sign the user out for being offline.
            throw AuthError.networkError(error.localizedDescription)
        }
        guard let httpResponse = response as? HTTPURLResponse else {
            throw AuthError.networkError("malformed response")
        }
        // Only 401/403 means "this access token is rejected" — that's
        // a hard auth failure. 5xx / other codes are server-side and
        // shouldn't kick the user out.
        if httpResponse.statusCode == 401 || httpResponse.statusCode == 403 {
            throw AuthError.sessionExpired
        }
        guard httpResponse.statusCode == 200 else {
            throw AuthError.networkError("HTTP \(httpResponse.statusCode)")
        }
        return try JSONDecoder().decode(AuthUser.self, from: data)
    }

    private func refreshSession(refreshToken: String) async throws {
        let url = URL(string: "\(supabaseUrl)/auth/v1/token?grant_type=refresh_token")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.timeoutInterval = 15
        request.httpBody = try JSONEncoder().encode(["refresh_token": refreshToken])

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw AuthError.networkError(error.localizedDescription)
        }
        guard let httpResponse = response as? HTTPURLResponse else {
            throw AuthError.networkError("malformed response")
        }
        // 400 / 401 from the refresh endpoint means the refresh token
        // is actually invalid (revoked, expired beyond reuse, never
        // issued). Anything else (5xx, 429, network) is transient.
        if httpResponse.statusCode == 400 || httpResponse.statusCode == 401 {
            print("[auth] refresh token rejected by Supabase (HTTP \(httpResponse.statusCode)) — hard expiry")
            throw AuthError.sessionExpired
        }
        guard httpResponse.statusCode == 200 else {
            throw AuthError.networkError("refresh HTTP \(httpResponse.statusCode)")
        }
        let session = try JSONDecoder().decode(SupabaseSession.self, from: data)
        saveSession(session)
    }

    private func saveSession(_ session: SupabaseSession) {
        accessToken = session.access_token
        currentUser = session.user
        isAuthenticated = true
        // THE SESSION LIVES IN THE KEYCHAIN (ruled 2026-09-06). UserDefaults is
        // wiped by a delete-and-reinstall, which for an ANONYMOUS user means
        // their identity — and every job under it — is gone with no way back,
        // because there is no email to sign in with. The Keychain survives, so
        // the same device keeps the same user_id. Mirrored to UserDefaults for
        // one release so an existing signed-in install is not logged out by the
        // move; the read below prefers the Keychain.
        _ = Keychain.set(session.access_token, for: tokenKey)
        _ = Keychain.set(session.refresh_token, for: refreshKey)
        UserDefaults.standard.set(session.access_token, forKey: tokenKey)
        UserDefaults.standard.set(session.refresh_token, forKey: refreshKey)

        // Parse JWT to get expiry time
        let expiry = parseJWTExpiry(session.access_token) ?? (Date().timeIntervalSince1970 + 3600)
        UserDefaults.standard.set(expiry, forKey: tokenExpiryKey)

        // Re-identify RevenueCat with the new user so any subscription
        // purchases under this account get attributed correctly AND so
        // the webhook (which keys on app_user_id = our user.id) writes
        // back to the right profiles row. Without this, a sign-out →
        // sign-in-as-other-user flow on the same device would leave
        // RevenueCat targeting the previous user's RC ID.
        let uid = session.user.id
        print("[auth] saveSession user.id=\(uid) email=\(session.user.email ?? "nil")")
        Task { @MainActor in
            await SubscriptionService.shared.identify(userId: uid)
            await UsageService.shared.refresh()
            // Force a fresh chat reload for the new identity. Without this,
            // a sign-out → sign-in-as-other-user flow shows the previous
            // user's chats lingering in memory until the next manual
            // refresh. ChatStore.clearForSignOut() ran on sign-out so the
            // list is already empty; this re-fills it for the new account.
            await ChatStore.shared.loadChats()
            // Referral: claim a pending ?ref= code exactly once. saveSession
            // also fires on token refresh — once-only comes from the service
            // CONSUMING the code (and the server's once-per-referred rule),
            // so this call is a cheap no-op on every later pass.
            await ReferralService.shared.claimPendingIfAny()
            await ReferralService.shared.reconcileRewardsIfAny()
            await CreditsService.shared.claimFreeGrantIfNeeded()
        }
    }

    private func parseJWTExpiry(_ token: String) -> TimeInterval? {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var base64 = String(parts[1])
        // Pad to multiple of 4
        while base64.count % 4 != 0 { base64.append("=") }
        guard let data = Data(base64Encoded: base64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let exp = json["exp"] as? TimeInterval else { return nil }
        return exp
    }

    /// Refresh the token automatically before it expires
    private func scheduleTokenRefresh() {
        refreshTask?.cancel()

        let expiry = UserDefaults.standard.double(forKey: tokenExpiryKey)
        guard expiry > 0 else { return }

        // Refresh 5 minutes before expiry
        let refreshIn = max(10, expiry - Date().timeIntervalSince1970 - 300)

        refreshTask = Task {
            try? await Task.sleep(for: .seconds(refreshIn))
            guard !Task.isCancelled else { return }
            guard let refreshToken = storedRefreshToken else { return }
            do {
                try await refreshSession(refreshToken: refreshToken)
                scheduleTokenRefresh() // Schedule next refresh
            } catch AuthError.sessionExpired {
                // Refresh token truly invalid (revoked or beyond reuse).
                // The user is logged out; getValidToken will surface
                // this on the next API call.
                print("[auth] scheduled refresh: hard token rejection")
            } catch {
                // Transient failure (offline, 5xx). The current access
                // token is still valid until its real expiry; try again
                // in 60 seconds. Without this retry, a single network
                // blip can cascade into a logout when the access token
                // expires.
                print("[auth] scheduled refresh: soft failure (\(error.localizedDescription)) — retrying in 60s")
                refreshTask = Task {
                    try? await Task.sleep(for: .seconds(60))
                    guard !Task.isCancelled else { return }
                    self.scheduleTokenRefresh()
                }
            }
        }
    }
}

enum AuthError: LocalizedError {
    case signUpFailed(String)
    case signInFailed(String)
    /// HARD authentication failure: Supabase explicitly said the
    /// refresh token / access token is invalid (400 / 401 with an
    /// auth-specific error). Signs the user out.
    case sessionExpired
    /// SOFT failure: network problem, 5xx server error, timeout —
    /// the session is still valid, we just couldn't talk to Supabase
    /// right now. Keep the user signed in; retry later.
    case networkError(String)
    case updateFailed

    var errorDescription: String? {
        switch self {
        case .signUpFailed(let msg): return "Sign up failed: \(msg)"
        case .signInFailed(let msg): return "Sign in failed: \(msg)"
        case .sessionExpired: return "Session expired. Please sign in again."
        case .networkError(let msg): return "Network error: \(msg)"
        case .updateFailed: return "Failed to update profile."
        }
    }
}
