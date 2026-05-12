import SwiftUI
import AuthenticationServices
import CryptoKit

struct AuthView: View {
    @State private var email = ""
    @State private var password = ""
    @State private var isSignUp = false
    @State private var isLoading = false
    @State private var errorMessage: String?
    @FocusState private var focusedField: Field?

    /// Raw nonce stashed between Apple's `onRequest` and `onCompletion`.
    /// We hash this with SHA-256 → set as `request.nonce` (Apple bakes
    /// the hash into the issued id_token). The raw nonce is then sent
    /// to Supabase alongside the id_token so it can verify the binding.
    /// Without this end-to-end nonce flow, Supabase rejects every Apple
    /// id_token — which is why the previous button "went nowhere."
    @State private var appleRawNonce: String = ""

    /// Owns the ASWebAuthenticationSession for Google sign-in. Held so
    /// the session isn't deallocated while the OAuth flow is presenting.
    @State private var oauthCoordinator = OAuthCoordinator()

    private enum Field: Hashable { case email, password }

    var body: some View {
        ZStack {
            backgroundLayer

            ScrollView {
                VStack(spacing: 24) {
                    Spacer(minLength: 56)

                    logoMark
                        .padding(.bottom, 4)

                    titleBlock

                    socialButtons
                        .padding(.top, 12)

                    orDivider

                    formFields

                    if let error = errorMessage {
                        Text(error)
                            .font(.system(size: 13.5))
                            .foregroundColor(.red)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                            .transition(.opacity)
                    }

                    submitButton

                    toggleButton

                    Spacer(minLength: 32)
                }
                .padding(.horizontal, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .dismissKeyboardOnTap()
        }
        .preferredColorScheme(.dark)
    }

    // MARK: - Background

    /// Subtle radial gradient that lifts the page out of pure black.
    /// A faint glow behind the logo gives the page a focal point
    /// without leaning into "AI startup hero" territory.
    private var backgroundLayer: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            RadialGradient(
                colors: [Color.white.opacity(0.06), Color.clear],
                center: UnitPoint(x: 0.5, y: 0.22),
                startRadius: 10,
                endRadius: 280
            )
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
    }

    // MARK: - Logo + title

    private var logoMark: some View {
        VStack(spacing: 14) {
            Image("PromptlyLogo")
                .resizable()
                .renderingMode(.template)
                .aspectRatio(contentMode: .fit)
                .foregroundColor(.white)
                .frame(width: 88, height: 88)
                .shadow(color: .white.opacity(0.18), radius: 18, y: 0)
                .accessibilityHidden(true)

            Text("Promptly")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundColor(.white)
                .tracking(-0.5)
        }
    }

    private var titleBlock: some View {
        VStack(spacing: 6) {
            Text(isSignUp ? "Create your account" : "Welcome back")
                .font(.system(size: 22, weight: .semibold))
                .foregroundColor(.white)
                .contentTransition(.opacity)

            Text("AI editor for short-form talking head videos.")
                .font(.system(size: 14))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    // MARK: - Social buttons

    private var socialButtons: some View {
        VStack(spacing: 10) {
            SignInWithAppleButton(
                isSignUp ? .signUp : .signIn,
                onRequest: { request in
                    request.requestedScopes = [.email, .fullName]
                    // Generate a fresh raw nonce, stash it for onCompletion,
                    // and set the SHA-256 hash on the request. Apple bakes
                    // the hash into the id_token; Supabase validates that
                    // SHA256(rawNonce) == nonceHashInToken before accepting.
                    let raw = Self.makeRawNonce()
                    appleRawNonce = raw
                    request.nonce = Self.sha256Hex(raw)
                },
                onCompletion: handleAppleSignIn
            )
            .signInWithAppleButtonStyle(.white)
            .frame(height: 52)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

            Button(action: signInWithGoogle) {
                HStack(spacing: 10) {
                    Image(systemName: "g.circle.fill")
                        .font(.system(size: 20))
                        .accessibilityHidden(true)
                    Text(isSignUp ? "Sign up with Google" : "Sign in with Google")
                        .font(.system(size: 17, weight: .semibold))
                }
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .background(Color.white)
                .foregroundColor(.black)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .accessibilityLabel(isSignUp ? "Sign up with Google" : "Sign in with Google")
        }
    }

    private var orDivider: some View {
        HStack(spacing: 12) {
            Rectangle()
                .fill(Color(.separator).opacity(0.6))
                .frame(height: 0.5)
            Text("OR")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(Color(.tertiaryLabel))
                .tracking(1)
            Rectangle()
                .fill(Color(.separator).opacity(0.6))
                .frame(height: 0.5)
        }
        .padding(.vertical, 4)
    }

    // MARK: - Email/password

    private var formFields: some View {
        VStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Email")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.secondary)
                    .tracking(0.3)
                TextField("", text: $email, prompt: Text("you@example.com").foregroundColor(Color(.placeholderText)))
                    .focused($focusedField, equals: .email)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .password }
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .padding(14)
                    .background(Color(.tertiarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(focusedField == .email ? Color.white.opacity(0.35) : Color.clear, lineWidth: 1)
                    )
                    .foregroundColor(.white)
                    .font(.system(size: 16))
                    .animation(.easeOut(duration: 0.18), value: focusedField)
                    .accessibilityLabel("Email")
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Password")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.secondary)
                    .tracking(0.3)
                SecureField("", text: $password, prompt: Text("••••••••").foregroundColor(Color(.placeholderText)))
                    .focused($focusedField, equals: .password)
                    .submitLabel(.go)
                    .onSubmit { submit() }
                    .textContentType(isSignUp ? .newPassword : .password)
                    .padding(14)
                    .background(Color(.tertiarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(focusedField == .password ? Color.white.opacity(0.35) : Color.clear, lineWidth: 1)
                    )
                    .foregroundColor(.white)
                    .font(.system(size: 16))
                    .animation(.easeOut(duration: 0.18), value: focusedField)
                    .accessibilityLabel("Password")
            }
        }
    }

    // MARK: - Submit + toggle

    private var submitButton: some View {
        Button(action: submit) {
            Group {
                if isLoading {
                    ProgressView().tint(.black)
                } else {
                    Text(isSignUp ? "Create Account" : "Sign In")
                        .font(.system(size: 17, weight: .semibold))
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .background(Color.white)
            .foregroundColor(.black)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .disabled(isLoading || email.isEmpty || password.isEmpty)
        .opacity(email.isEmpty || password.isEmpty ? 0.5 : 1)
        .animation(.easeOut(duration: 0.18), value: email.isEmpty || password.isEmpty)
    }

    private var toggleButton: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                isSignUp.toggle()
                errorMessage = nil
            }
        } label: {
            (Text(isSignUp ? "Already have an account? " : "Don't have an account? ")
                .foregroundColor(.secondary)
             + Text(isSignUp ? "Sign in" : "Sign up")
                .foregroundColor(.white)
                .fontWeight(.semibold))
                .font(.system(size: 14))
        }
    }

    // MARK: - Email/Password

    private func submit() {
        guard !email.isEmpty, !password.isEmpty else { return }
        Keyboard.dismiss()
        isLoading = true
        errorMessage = nil

        Task {
            do {
                if isSignUp {
                    try await AuthService.shared.signUp(email: email, password: password)
                } else {
                    try await AuthService.shared.signIn(email: email, password: password)
                }
            } catch let error as AuthError {
                switch error {
                case .signUpFailed(let msg):
                    if msg.contains("already") || msg.contains("exists") || msg.contains("registered") {
                        errorMessage = "This account already exists."
                        withAnimation {
                            isSignUp = false
                        }
                    } else {
                        errorMessage = msg
                    }
                default:
                    errorMessage = error.localizedDescription
                }
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }

    // MARK: - Apple Sign In

    private func handleAppleSignIn(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .success(let auth):
            guard let credential = auth.credential as? ASAuthorizationAppleIDCredential,
                  let identityToken = credential.identityToken,
                  let tokenString = String(data: identityToken, encoding: .utf8) else {
                errorMessage = "Apple sign in failed"
                return
            }
            // The raw nonce stashed in onRequest must accompany the
            // id_token so Supabase can verify SHA256(raw) == hash-in-token.
            let nonce = appleRawNonce

            isLoading = true
            Task {
                do {
                    try await AuthService.shared.signInWithIdToken(
                        provider: "apple",
                        idToken: tokenString,
                        nonce: nonce
                    )
                } catch {
                    errorMessage = error.localizedDescription
                }
                isLoading = false
            }

        case .failure(let error):
            if (error as NSError).code != ASAuthorizationError.canceled.rawValue {
                errorMessage = "Apple sign in failed"
            }
        }
    }

    // MARK: - Google Sign In

    private func signInWithGoogle() {
        // ASWebAuthenticationSession is iOS's purpose-built OAuth runner.
        // It handles the auth UI in-app, intercepts the redirect by
        // matching the callback URL scheme, and delivers the URL back
        // to us via completion — NO "Open in Promptly" system prompt,
        // no UIApplication.shared.open. This is the pattern Spotify,
        // Discord, every production iOS app uses.
        let supabaseUrl = "https://ejxkzsfruykvgeouymfy.supabase.co"
        let scheme = "app.usepromptly.ios"
        let redirectUrl = "\(scheme)://auth-callback"
        let urlString = "\(supabaseUrl)/auth/v1/authorize?provider=google&redirect_to=\(redirectUrl)"
        guard let url = URL(string: urlString) else {
            errorMessage = "Couldn't build sign-in URL"
            return
        }

        isLoading = true
        oauthCoordinator.start(url: url, callbackScheme: scheme) { result in
            Task { @MainActor in
                switch result {
                case .success(let callbackUrl):
                    do {
                        try await Self.completeGoogleSignIn(callbackUrl: callbackUrl)
                    } catch {
                        errorMessage = error.localizedDescription
                    }
                case .failure(let error):
                    // User cancellation is silent; everything else surfaces.
                    if (error as NSError).code != ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        errorMessage = error.localizedDescription
                    }
                }
                isLoading = false
            }
        }
    }

    /// Parse `access_token` + `refresh_token` out of the callback URL
    /// fragment (Supabase implicit OAuth returns them after `#`) and
    /// adopt the session.
    private static func completeGoogleSignIn(callbackUrl: URL) async throws {
        // Supabase puts tokens in the URL FRAGMENT, not the query.
        // URLComponents.fragment is a raw string we have to parse
        // ourselves — it has the same `key=value&...` shape as a query.
        let raw = callbackUrl.fragment ?? callbackUrl.query ?? ""
        let pairs = raw.split(separator: "&").compactMap { kv -> (String, String)? in
            let parts = kv.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { return nil }
            return (parts[0], parts[1].removingPercentEncoding ?? parts[1])
        }
        let dict = Dictionary(uniqueKeysWithValues: pairs)

        if let providerError = dict["error_description"] ?? dict["error"] {
            throw AuthError.signInFailed(providerError)
        }
        guard let accessToken = dict["access_token"],
              let refreshToken = dict["refresh_token"] else {
            throw AuthError.signInFailed("Sign-in callback missing tokens")
        }
        try await AuthService.shared.adoptOAuthSession(
            accessToken: accessToken,
            refreshToken: refreshToken
        )
    }

    // MARK: - Nonce helpers (Apple Sign-In)

    /// Cryptographically-random 32-character nonce. URL-safe charset so it
    /// survives any encoding in the round-trip through Apple → Supabase.
    private static func makeRawNonce(length: Int = 32) -> String {
        let charset: [Character] = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._")
        var bytes = [UInt8](repeating: 0, count: length)
        let status = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
        guard status == errSecSuccess else {
            // Fallback — extremely unlikely path. UUID gives us 128 bits
            // of entropy which is still cryptographically safe enough
            // for the nonce binding.
            return UUID().uuidString.replacingOccurrences(of: "-", with: "")
        }
        return String(bytes.map { charset[Int($0) % charset.count] })
    }

    /// SHA-256 hex-encoded — what Apple expects in `request.nonce`.
    private static func sha256Hex(_ input: String) -> String {
        let digest = SHA256.hash(data: Data(input.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - OAuth coordinator
//
// Owns the live ASWebAuthenticationSession + presentation anchor. The
// view holds it as @State so the session isn't deallocated mid-flight.

final class OAuthCoordinator: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func start(url: URL, callbackScheme: String, completion: @escaping (Result<URL, Error>) -> Void) {
        let s = ASWebAuthenticationSession(
            url: url,
            callbackURLScheme: callbackScheme
        ) { callback, error in
            if let error {
                completion(.failure(error))
            } else if let callback {
                completion(.success(callback))
            } else {
                completion(.failure(NSError(domain: "OAuthCoordinator", code: -1)))
            }
        }
        s.presentationContextProvider = self
        // false → reuse Safari cookies so users already signed into
        // Google in Safari skip the password prompt. Production apps
        // do this; ephemeral mode is a privacy-paranoid choice.
        s.prefersEphemeralWebBrowserSession = false
        self.session = s
        s.start()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // Find the key window. ASPresentationAnchor is a UIWindow.
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first(where: { $0.activationState == .foregroundActive })
            ?? (UIApplication.shared.connectedScenes.first as? UIWindowScene)
        return scene?.windows.first(where: { $0.isKeyWindow })
            ?? scene?.windows.first
            ?? ASPresentationAnchor()
    }
}
