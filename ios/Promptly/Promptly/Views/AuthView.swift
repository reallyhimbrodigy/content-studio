import SwiftUI
import AuthenticationServices
import CryptoKit

struct AuthView: View {
    @State private var email = ""
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var otpEmail: String?  // non-nil → present the OTP sheet for this email
    @FocusState private var focusedField: Field?

    /// Raw nonce stashed between Apple's `onRequest` and `onCompletion`.
    /// We hash this with SHA-256 → set as `request.nonce` (Apple bakes
    /// the hash into the issued id_token). The raw nonce is then sent
    /// to Supabase alongside the id_token so it can verify the binding.
    /// Without this end-to-end nonce flow, Supabase rejects every Apple
    /// id_token — which is why the previous button "went nowhere."
    @State private var appleRawNonce: String = ""
    @State private var showInviteField = false
    @State private var inviteCode = ""
    @State private var inviteApplied = false
    @State private var inviteError = false

    /// Owns the ASWebAuthenticationSession for Google sign-in. Held so
    /// the session isn't deallocated while the OAuth flow is presenting.
    @State private var oauthCoordinator = OAuthCoordinator()

    private enum Field: Hashable { case email }

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

                    inviteCodeBlock

                    Spacer(minLength: 32)
                }
                .padding(.horizontal, 24)
                // Center the auth form in a sane column on iPad. Without
                // this the SignInWithAppleButton stretches across an
                // 1180pt-wide screen which both looks broken and is what
                // Apple flagged in the App Review rejection of build 151.
                .frame(maxWidth: 460)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            // Note: deliberately NOT using .dismissKeyboardOnTap() here.
            // On iPad (specifically iPadOS 26.x), the simultaneousGesture
            // intercepts taps on SignInWithAppleButton before Apple's
            // button can handle them — caused App Review rejection of
            // build 151. .scrollDismissesKeyboard(.interactively) above
            // handles keyboard dismissal via swipe, which is enough.
        }
        .preferredColorScheme(.dark)
        .fullScreenCover(item: Binding(
            get: { otpEmail.map { OtpPresentation(email: $0) } },
            set: { otpEmail = $0?.email }
        )) { presentation in
            OtpInputView(email: presentation.email) {
                otpEmail = nil
            }
        }
    }

    /// Wraps the email so SwiftUI's `.fullScreenCover(item:)` has an
    /// Identifiable to track. The email itself is the identity.
    private struct OtpPresentation: Identifiable {
        let email: String
        var id: String { email }
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
            // PromptlyLogo PNG now has a proper alpha channel (built
            // 170 converted the asset from solid-black-background RGB
            // to RGBA where black = transparent, white = opaque).
            // Renders cleanly as a silhouette against any background;
            // no blend mode or mask trickery required.
            Image("PromptlyLogo")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 88, height: 88)
                .shadow(color: .white.opacity(0.18), radius: 18, y: 0)
                .accessibilityHidden(true)

            Text("Promptly")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundColor(.white)
                .tracking(-0.5)
        }
    }

    // MARK: - Invite code (the fresh-install referral path)

    /// A universal link only opens the app for someone who ALREADY has it. The
    /// population this loop needs — people installing for the first time —
    /// arrives via the App Store, where the code does not survive: iOS carries
    /// no deferred-deep-link state and we ship no attribution SDK. The landing
    /// page holds the code up and tells the recipient to enter it here; until
    /// now there was nowhere to enter it, so that instruction dead-ended and
    /// the loop could only ever attribute referrals to existing users.
    ///
    /// COLLAPSED BY DEFAULT, and placed below the primary auth actions. This
    /// screen's job is to get someone signed in; an always-open field here
    /// competes with that for no benefit to the majority who have no code.
    @ViewBuilder
    private var inviteCodeBlock: some View {
        if let pending = ReferralService.shared.pendingCode {
            // The link path already worked. Confirm it rather than ask again —
            // being asked for a code you already supplied reads as a failure.
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 13))
                    .foregroundColor(.green.opacity(0.8))
                Text("Invite code \(pending) applied")
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
            }
            .accessibilityElement(children: .combine)
        } else if showInviteField {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    TextField(String(localized: "Invite code"), text: $inviteCode)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled(true)
                        .textContentType(.oneTimeCode)
                        .font(.system(size: 15, weight: .medium, design: .monospaced))
                        .foregroundColor(.white)
                        .padding(.horizontal, 14)
                        .frame(height: 44)
                        .background(Color.white.opacity(0.06),
                                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .onChange(of: inviteCode) { _, new in
                            // Normalise as they type so what they see is what
                            // is stored and what the landing page showed them.
                            let up = new.uppercased()
                            if up != new { inviteCode = up }
                            inviteError = false
                        }

                    Button {
                        if ReferralService.shared.enterCodeManually(inviteCode) {
                            inviteApplied = true
                            inviteError = false
                        } else {
                            inviteError = true
                        }
                    } label: {
                        Text("Apply")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(.black)
                            .padding(.horizontal, 18)
                            .frame(height: 44)
                            .background(Color.white,
                                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .disabled(inviteCode.isEmpty)
                    .opacity(inviteCode.isEmpty ? 0.5 : 1)
                }

                if inviteApplied {
                    Text("Invite code applied. Sign in to finish.")
                        .font(.system(size: 12.5))
                        .foregroundColor(.green.opacity(0.85))
                } else if inviteError {
                    // Says what is wrong and what to do, per the house rule on
                    // error copy — not a bare "invalid".
                    Text("That code doesn't look right. Check the letters and try again.")
                        .font(.system(size: 12.5))
                        .foregroundColor(.orange.opacity(0.9))
                        .multilineTextAlignment(.center)
                }
            }
            .transition(.opacity)
        } else {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) { showInviteField = true }
                Analytics.track("referral_code_field_opened",
                                props: ["source": "signup", "context": "signup"])
            } label: {
                Text("Have an invite code?")
                    .font(.system(size: 13.5))
                    .foregroundColor(.secondary)
                    .underline()
            }
        }
    }

    private var titleBlock: some View {
        VStack(spacing: 6) {
            Text("Sign in to Promptly")
                .font(.system(size: 22, weight: .semibold))
                .foregroundColor(.white)

            Text("The editor for short-form talking-head videos.")
                .font(.system(size: 14))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    // MARK: - Social buttons

    private var socialButtons: some View {
        VStack(spacing: 10) {
            SignInWithAppleButton(
                .continue,
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
                    Text("Continue with Google")
                        .font(.system(size: 17, weight: .semibold))
                }
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .background(Color.white)
                .foregroundColor(.black)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .accessibilityLabel("Continue with Google")
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

    // MARK: - Email (passwordless OTP)

    private var formFields: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Email")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.secondary)
                .tracking(0.3)
            TextField("", text: $email, prompt: Text("you@example.com").foregroundColor(Color(.placeholderText)))
                .focused($focusedField, equals: .email)
                .submitLabel(.go)
                .onSubmit { sendCode() }
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
    }

    // MARK: - Submit

    private var submitButton: some View {
        Button(action: sendCode) {
            Group {
                if isLoading {
                    ProgressView().tint(.black)
                } else {
                    Text("Continue with Email")
                        .font(.system(size: 17, weight: .semibold))
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .background(Color.white)
            .foregroundColor(.black)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .disabled(isLoading || !looksLikeEmail(email))
        .opacity(looksLikeEmail(email) ? 1 : 0.5)
        .animation(.easeOut(duration: 0.18), value: looksLikeEmail(email))
    }

    private var toggleButton: some View {
        // Passwordless removes the sign-up vs. sign-in toggle entirely —
        // the same flow handles both. Keep an empty placeholder so the
        // outer body doesn't need to be refactored, and add a one-line
        // disclosure so users understand new accounts are auto-created.
        Text("New here? Just enter your email — we'll create your account.")
            .font(.system(size: 12))
            .foregroundColor(Color(.tertiaryLabel))
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
    }

    // MARK: - OTP send

    private func sendCode() {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard looksLikeEmail(trimmed) else { return }
        Keyboard.dismiss()
        isLoading = true
        errorMessage = nil

        Task {
            do {
                try await AuthService.shared.sendOtp(email: trimmed)
                otpEmail = trimmed
            } catch {
                errorMessage = "Couldn't send code. Check your email and try again."
            }
            isLoading = false
        }
    }

    private func looksLikeEmail(_ s: String) -> Bool {
        // Cheap structural check — Supabase does real validation server-side
        // and rejects bad emails on /auth/v1/otp. This just prevents the
        // user from sending a clearly-broken value (no @, no domain).
        let parts = s.split(separator: "@")
        return parts.count == 2 && parts[1].contains(".")
    }

    // MARK: - Apple Sign In

    private func handleAppleSignIn(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .success(let auth):
            print("[apple] credential received")
            guard let credential = auth.credential as? ASAuthorizationAppleIDCredential else {
                errorMessage = "Apple sign in: unexpected credential type"
                print("[apple] credential cast failed: \(type(of: auth.credential))")
                return
            }
            guard let identityToken = credential.identityToken,
                  let tokenString = String(data: identityToken, encoding: .utf8) else {
                errorMessage = "Apple sign in: missing identity token"
                print("[apple] identityToken missing")
                return
            }
            print("[apple] identityToken length=\(tokenString.count)")
            let nonce = appleRawNonce

            isLoading = true
            Task {
                do {
                    // PRIMARY PATH: send the nonce. This is the secure
                    // mode that protects against replay attacks. Works
                    // when Supabase project has the nonce-validation bug
                    // (#2378) fixed OR has "Skip nonce check" toggled on.
                    try await AuthService.shared.signInWithIdToken(
                        provider: "apple",
                        idToken: tokenString,
                        nonce: nonce
                    )
                    print("[apple] sign in succeeded")
                } catch let primaryError {
                    // FALLBACK: if Supabase rejects with a 400 (likely
                    // "Nonces mismatch" due to the known server bug),
                    // retry WITHOUT the nonce. This sacrifices replay
                    // protection but unblocks sign-in on projects that
                    // can't toggle Skip Nonce Check from the dashboard.
                    let message = primaryError.localizedDescription.lowercased()
                    let looksLikeNonceBug = message.contains("nonce") || message.contains("400")
                    if looksLikeNonceBug {
                        print("[apple] primary signin failed (\(primaryError.localizedDescription)) — retrying without nonce")
                        do {
                            try await AuthService.shared.signInWithIdToken(
                                provider: "apple",
                                idToken: tokenString,
                                nonce: nil
                            )
                            print("[apple] no-nonce fallback succeeded")
                        } catch {
                            print("[apple] no-nonce fallback also failed: \(error.localizedDescription)")
                            errorMessage = "Apple sign in: \(error.localizedDescription)"
                        }
                    } else {
                        print("[apple] sign in failed: \(primaryError.localizedDescription)")
                        errorMessage = "Apple sign in: \(primaryError.localizedDescription)"
                    }
                }
                isLoading = false
            }

        case .failure(let error):
            let nsError = error as NSError
            if nsError.code == ASAuthorizationError.canceled.rawValue {
                print("[apple] user canceled")
                return
            }
            // Surface the SPECIFIC iOS error code so we can diagnose:
            // .notHandled / .invalidResponse / .failed / .unknown each
            // points to a different root cause.
            let codeName: String
            switch ASAuthorizationError.Code(rawValue: nsError.code) {
            case .unknown: codeName = "unknown"
            case .invalidResponse: codeName = "invalidResponse"
            case .notHandled: codeName = "notHandled (often: Sign In with Apple capability missing from App ID)"
            case .failed: codeName = "failed"
            case .notInteractive: codeName = "notInteractive"
            default: codeName = "code=\(nsError.code)"
            }
            print("[apple] failure: \(codeName) — \(nsError.localizedDescription)")
            errorMessage = "Apple sign in failed (\(codeName))"
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
        // Dictionary(uniqueKeysWithValues:) TRAPS on a duplicate key — a
        // malformed/hostile callback fragment with a repeated key would crash
        // the whole OAuth path (EXC_BREAKPOINT class). Keep the first value.
        let dict = Dictionary(pairs, uniquingKeysWith: { first, _ in first })

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
