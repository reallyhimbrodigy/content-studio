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

    private init() {}

    // MARK: - Session Management

    func checkSession() async {
        guard let token = UserDefaults.standard.string(forKey: tokenKey),
              let refreshToken = UserDefaults.standard.string(forKey: refreshKey) else {
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

        if needsRefresh, let refreshToken = UserDefaults.standard.string(forKey: refreshKey) {
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

    func signUp(email: String, password: String) async throws {
        let url = URL(string: "\(supabaseUrl)/auth/v1/signup")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.httpBody = try JSONEncoder().encode(["email": email, "password": password])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw AuthError.signUpFailed(body)
        }

        let session = try JSONDecoder().decode(SupabaseSession.self, from: data)
        saveSession(session)
    }

    func signIn(email: String, password: String) async throws {
        let url = URL(string: "\(supabaseUrl)/auth/v1/token?grant_type=password")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.httpBody = try JSONEncoder().encode(["email": email, "password": password])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw AuthError.signInFailed(body)
        }

        let session = try JSONDecoder().decode(SupabaseSession.self, from: data)
        saveSession(session)
        scheduleTokenRefresh()
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

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            let errorBody = String(data: data, encoding: .utf8) ?? ""
            throw AuthError.signInFailed(errorBody)
        }

        let session = try JSONDecoder().decode(SupabaseSession.self, from: data)
        saveSession(session)
        scheduleTokenRefresh()
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
        refreshTask?.cancel()
        refreshTask = nil
        UserDefaults.standard.removeObject(forKey: tokenKey)
        UserDefaults.standard.removeObject(forKey: refreshKey)
        UserDefaults.standard.removeObject(forKey: tokenExpiryKey)
        accessToken = nil
        currentUser = nil
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
        UserDefaults.standard.set(session.access_token, forKey: tokenKey)
        UserDefaults.standard.set(session.refresh_token, forKey: refreshKey)

        // Parse JWT to get expiry time
        let expiry = parseJWTExpiry(session.access_token) ?? (Date().timeIntervalSince1970 + 3600)
        UserDefaults.standard.set(expiry, forKey: tokenExpiryKey)
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
            guard let refreshToken = UserDefaults.standard.string(forKey: refreshKey) else { return }
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
