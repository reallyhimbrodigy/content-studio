import SwiftUI

struct AuthView: View {
    @State private var email = ""
    @State private var password = ""
    @State private var isSignUp = false
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            Color(hex: "121212").ignoresSafeArea()

            ScrollView {
                VStack(spacing: 32) {
                    Spacer(minLength: 60)

                    // Logo
                    Text("Promptly")
                        .font(.system(size: 28, weight: .bold, design: .default))
                        .foregroundColor(.white)

                    // Title
                    VStack(spacing: 8) {
                        Text(isSignUp ? "Create your account" : "Welcome back")
                            .font(.system(size: 24, weight: .bold))
                            .foregroundColor(.white)

                        Text("AI-powered video editing")
                            .font(.system(size: 15))
                            .foregroundColor(.white.opacity(0.4))
                    }

                    // Form
                    VStack(spacing: 16) {
                        // Email
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Email")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(.white.opacity(0.5))

                            TextField("", text: $email, prompt: Text("you@example.com").foregroundColor(.white.opacity(0.25)))
                                .textContentType(.emailAddress)
                                .keyboardType(.emailAddress)
                                .autocapitalization(.none)
                                .disableAutocorrection(true)
                                .padding(14)
                                .background(Color(hex: "2C2C2E"))
                                .cornerRadius(12)
                                .foregroundColor(.white)
                                .font(.system(size: 16))
                        }

                        // Password
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Password")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(.white.opacity(0.5))

                            SecureField("", text: $password, prompt: Text("••••••••").foregroundColor(.white.opacity(0.25)))
                                .textContentType(isSignUp ? .newPassword : .password)
                                .padding(14)
                                .background(Color(hex: "2C2C2E"))
                                .cornerRadius(12)
                                .foregroundColor(.white)
                                .font(.system(size: 16))
                        }
                    }

                    // Error
                    if let error = errorMessage {
                        Text(error)
                            .font(.system(size: 14))
                            .foregroundColor(Color(hex: "FF453A"))
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }

                    // Submit button
                    Button(action: submit) {
                        Group {
                            if isLoading {
                                ProgressView()
                                    .tint(.white)
                            } else {
                                Text(isSignUp ? "Create Account" : "Sign In")
                                    .font(.system(size: 17, weight: .semibold))
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                        .background(Color(hex: "3B82F6"))
                        .foregroundColor(.white)
                        .cornerRadius(14)
                    }
                    .disabled(isLoading || email.isEmpty || password.isEmpty)
                    .opacity(email.isEmpty || password.isEmpty ? 0.5 : 1)

                    // Toggle
                    Button(action: { withAnimation { isSignUp.toggle(); errorMessage = nil } }) {
                        Text(isSignUp ? "Already have an account? **Sign in**" : "Don't have an account? **Sign up**")
                            .font(.system(size: 14))
                            .foregroundColor(.white.opacity(0.5))
                    }

                    Spacer(minLength: 40)
                }
                .padding(.horizontal, 24)
            }
        }
    }

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
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }
}
