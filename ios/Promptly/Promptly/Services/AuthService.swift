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

    private init() {}

    func checkSession() async {
        guard let token = UserDefaults.standard.string(forKey: tokenKey) else {
            isLoading = false
            return
        }
        accessToken = token
        // Verify token by getting user
        do {
            let user = try await getUser(token: token)
            currentUser = user
            isAuthenticated = true
        } catch {
            // Token expired, try refresh
            if let refreshToken = UserDefaults.standard.string(forKey: refreshKey) {
                do {
                    try await refreshSession(refreshToken: refreshToken)
                } catch {
                    signOut()
                }
            } else {
                signOut()
            }
        }
        isLoading = false
    }

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
    }

    func signOut() {
        UserDefaults.standard.removeObject(forKey: tokenKey)
        UserDefaults.standard.removeObject(forKey: refreshKey)
        accessToken = nil
        currentUser = nil
        isAuthenticated = false
    }

    func updateUserName(_ name: String) async throws {
        guard let token = accessToken else { return }
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
        guard let token = accessToken, let userId = currentUser?.id else { return "free" }
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
