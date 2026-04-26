import SwiftUI
import AuthenticationServices

struct AuthView: View {
    @State private var email = ""
    @State private var password = ""
    @State private var isSignUp = false
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()

            ScrollView {
                VStack(spacing: 28) {
                    Spacer(minLength: 60)

                    // Logo
                    Text("Promptly")
                        .font(.system(size: 28, weight: .bold))
                        .foregroundColor(.white)

                    // Title
                    VStack(spacing: 8) {
                        Text(isSignUp ? "Create your account" : "Welcome back")
                            .font(.system(size: 24, weight: .bold))
                            .foregroundColor(.white)

                        Text("AI-powered video editing")
                            .font(.system(size: 15))
                            .foregroundColor(.secondary)
                    }

                    // Social sign-in buttons
                    VStack(spacing: 12) {
                        // Sign in with Apple
                        SignInWithAppleButton(
                            isSignUp ? .signUp : .signIn,
                            onRequest: { request in
                                request.requestedScopes = [.email, .fullName]
                            },
                            onCompletion: handleAppleSignIn
                        )
                        .signInWithAppleButtonStyle(.white)
                        .frame(height: 52)
                        .cornerRadius(14)

                        // Sign in with Google
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
                            .cornerRadius(14)
                        }
                        .accessibilityLabel(isSignUp ? "Sign up with Google" : "Sign in with Google")
                    }

                    // Divider
                    HStack {
                        Rectangle().fill(Color(.separator)).frame(height: 0.5)
                        Text("OR").font(.system(size: 12, weight: .medium)).foregroundColor(Color(.tertiaryLabel))
                        Rectangle().fill(Color(.separator)).frame(height: 0.5)
                    }

                    // Email/Password form
                    VStack(spacing: 16) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Email")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(.secondary)

                            TextField("", text: $email, prompt: Text("you@example.com").foregroundColor(Color(.placeholderText)))
                                .textContentType(.emailAddress)
                                .keyboardType(.emailAddress)
                                .autocapitalization(.none)
                                .disableAutocorrection(true)
                                .padding(14)
                                .background(Color(.tertiarySystemBackground))
                                .cornerRadius(12)
                                .foregroundColor(.white)
                                .font(.system(size: 16))
                                .accessibilityLabel("Email")
                        }

                        VStack(alignment: .leading, spacing: 6) {
                            Text("Password")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(.secondary)

                            SecureField("", text: $password, prompt: Text("••••••••").foregroundColor(Color(.placeholderText)))
                                .textContentType(isSignUp ? .newPassword : .password)
                                .padding(14)
                                .background(Color(.tertiarySystemBackground))
                                .cornerRadius(12)
                                .foregroundColor(.white)
                                .font(.system(size: 16))
                                .accessibilityLabel("Password")
                        }
                    }

                    // Error
                    if let error = errorMessage {
                        Text(error)
                            .font(.system(size: 14))
                            .foregroundColor(.red)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }

                    // Submit button
                    Button(action: submit) {
                        Group {
                            if isLoading {
                                ProgressView().tint(.white)
                            } else {
                                Text(isSignUp ? "Create Account" : "Sign In")
                                    .font(.system(size: 17, weight: .semibold))
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                        .background(Color.white)
                        .foregroundColor(.black)
                        .cornerRadius(14)
                    }
                    .disabled(isLoading || email.isEmpty || password.isEmpty)
                    .opacity(email.isEmpty || password.isEmpty ? 0.5 : 1)

                    // Toggle
                    Button(action: { withAnimation { isSignUp.toggle(); errorMessage = nil } }) {
                        Text(isSignUp ? "Already have an account? **Sign in**" : "Don't have an account? **Sign up**")
                            .font(.system(size: 14))
                            .foregroundColor(.secondary)
                    }

                    Spacer(minLength: 40)
                }
                .padding(.horizontal, 24)
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    // MARK: - Email/Password

    private func submit() {
        guard !email.isEmpty, !password.isEmpty else { return }
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

            isLoading = true
            Task {
                do {
                    try await AuthService.shared.signInWithIdToken(provider: "apple", idToken: tokenString)
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
        // Open Supabase OAuth flow in browser
        let supabaseUrl = "https://ejxkzsfruykvgeouymfy.supabase.co"
        let redirectUrl = "app.usepromptly.ios://auth-callback"
        let urlString = "\(supabaseUrl)/auth/v1/authorize?provider=google&redirect_to=\(redirectUrl)"
        if let url = URL(string: urlString) {
            UIApplication.shared.open(url)
        }
    }
}
