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

        // Check if token is expired or about to expire (within 5 min)
        let expiry = UserDefaults.standard.double(forKey: tokenExpiryKey)
        let needsRefresh = expiry == 0 || Date().timeIntervalSince1970 > (expiry - 300)

        if needsRefresh {
            // Refresh first, then verify
            do {
                try await refreshSession(refreshToken: refreshToken)
            } catch {
                // Refresh failed — try the existing token anyway
                accessToken = token
                do {
                    let user = try await getUser(token: token)
                    currentUser = user
                    isAuthenticated = true
                } catch {
                    signOut()
                }
            }
        } else {
            // Token still valid
            accessToken = token
            do {
                let user = try await getUser(token: token)
                currentUser = user
                isAuthenticated = true
            } catch {
                // Token invalid despite not being expired — try refresh
                do {
                    try await refreshSession(refreshToken: refreshToken)
                } catch {
                    signOut()
                }
            }
        }

        isLoading = false

        // Schedule background token refresh
        scheduleTokenRefresh()
    }

    /// Get a valid token, refreshing if needed. Use this for ALL API calls.
    func getValidToken() async -> String? {
        guard let token = accessToken else { return nil }

        let expiry = UserDefaults.standard.double(forKey: tokenExpiryKey)
        let needsRefresh = expiry == 0 || Date().timeIntervalSince1970 > (expiry - 300)

        if needsRefresh, let refreshToken = UserDefaults.standard.string(forKey: refreshKey) {
            do {
                try await refreshSession(refreshToken: refreshToken)
                return accessToken
            } catch {
                signOut()
                return nil
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

    func signInWithIdToken(provider: String, idToken: String) async throws {
        let url = URL(string: "\(supabaseUrl)/auth/v1/token?grant_type=id_token")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")

        let body: [String: String] = [
            "provider": provider,
            "id_token": idToken
        ]
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

    func signOut() {
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

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw AuthError.sessionExpired
        }
        return try JSONDecoder().decode(AuthUser.self, from: data)
    }

    private func refreshSession(refreshToken: String) async throws {
        let url = URL(string: "\(supabaseUrl)/auth/v1/token?grant_type=refresh_token")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.httpBody = try JSONEncoder().encode(["refresh_token": refreshToken])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw AuthError.sessionExpired
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
            } catch {
                // Token refresh failed — user will need to re-login on next API call
            }
        }
    }
}

enum AuthError: LocalizedError {
    case signUpFailed(String)
    case signInFailed(String)
    case sessionExpired
    case updateFailed

    var errorDescription: String? {
        switch self {
        case .signUpFailed(let msg): return "Sign up failed: \(msg)"
        case .signInFailed(let msg): return "Sign in failed: \(msg)"
        case .sessionExpired: return "Session expired. Please sign in again."
        case .updateFailed: return "Failed to update profile."
        }
    }
}
