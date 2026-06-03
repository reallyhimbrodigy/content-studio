import SwiftUI

/// Six-digit OTP entry. Pasted codes auto-fill all six slots; typing
/// auto-advances between slots; backspace falls back to the previous
/// slot. Verify fires automatically when the sixth digit lands.
///
/// Lifecycle:
///   1. AuthView calls sendOtp(email:) and pushes this view.
///   2. User types or pastes the 6-digit code from the email.
///   3. On the 6th digit we call verifyOtp(email:, code:); on success
///      AuthService saves the session and the AuthShell transitions to
///      AppShell. On failure we wipe the field and show an error.
///   4. A "resend" button is gated to a 30-second cooldown so users
///      can't spam Resend's send quota.
struct OtpInputView: View {
    let email: String
    let onDismiss: () -> Void

    @State private var code: String = ""
    @State private var isVerifying = false
    @State private var errorMessage: String?
    @State private var resendCooldown: Int = 30
    @State private var resendTimer: Timer?
    @State private var isResending = false
    @FocusState private var focused: Bool

    var body: some View {
        ZStack {
            backdrop.ignoresSafeArea()

            VStack(spacing: 28) {
                Spacer(minLength: 60)

                header

                otpField
                    .padding(.top, 8)

                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 13.5))
                        .foregroundColor(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .transition(.opacity)
                }

                if isVerifying {
                    ProgressView()
                        .tint(.white)
                        .padding(.top, 4)
                }

                Spacer(minLength: 0)

                resendRow

                Spacer().frame(height: 32)
            }
            .padding(.horizontal, 24)
            // Match AuthView's iPad layout — centered column, max width.
            .frame(maxWidth: 460)
            .frame(maxWidth: .infinity)

            VStack {
                HStack {
                    Button {
                        onDismiss()
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(.white)
                            .frame(width: 36, height: 36)
                            .background(.ultraThinMaterial)
                            .clipShape(Circle())
                    }
                    .padding(.leading, 18)
                    .padding(.top, 14)
                    Spacer()
                }
                Spacer()
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            // Focus immediately so the keyboard rises without an extra tap.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                focused = true
            }
            startResendCooldown()
        }
        .onDisappear { resendTimer?.invalidate() }
    }

    // MARK: - Subviews

    private var backdrop: some View {
        ZStack {
            Color.black
            RadialGradient(
                colors: [Color.white.opacity(0.06), Color.clear],
                center: UnitPoint(x: 0.5, y: 0.25),
                startRadius: 10,
                endRadius: 280
            )
        }
    }

    private var header: some View {
        VStack(spacing: 8) {
            Text("Check your email")
                .font(.system(size: 24, weight: .bold))
                .foregroundColor(.white)

            VStack(spacing: 2) {
                Text("We sent a 6-digit code to")
                    .font(.system(size: 14))
                    .foregroundColor(.secondary)
                Text(email)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.white)
            }
        }
        .multilineTextAlignment(.center)
    }

    private var otpField: some View {
        ZStack {
            // Six visible slots. Style only — the actual input is the
            // invisible TextField below.
            HStack(spacing: 12) {
                ForEach(0..<6, id: \.self) { i in
                    digitSlot(at: i)
                }
            }

            // Invisible text field — captures all input and propagates to
            // the slots via `code`. Always-focused so paste works from
            // the keyboard's autofill bar, and a long-press paste menu
            // anywhere in the row also lands here.
            TextField("", text: Binding(
                get: { code },
                set: { newValue in
                    let digits = newValue.filter { $0.isNumber }
                    let trimmed = String(digits.prefix(6))
                    if trimmed != code {
                        code = trimmed
                        if code.count == 6 { verify() }
                    }
                }
            ))
            .focused($focused)
            .keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
            .foregroundColor(.clear)
            .accentColor(.clear)
            .frame(maxWidth: .infinity, maxHeight: 60)
            .opacity(0.001)
            .contentShape(Rectangle())
            .onTapGesture { focused = true }
        }
        .frame(height: 64)
    }

    private func digitSlot(at index: Int) -> some View {
        let digit: String = {
            guard index < code.count else { return "" }
            let i = code.index(code.startIndex, offsetBy: index)
            return String(code[i])
        }()
        let isActive = index == code.count

        return Text(digit)
            .font(.system(size: 28, weight: .semibold, design: .monospaced))
            .foregroundColor(.white)
            .frame(width: 44, height: 56)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.white.opacity(0.08))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(isActive ? Color.white.opacity(0.55) : Color.clear, lineWidth: 1.5)
            )
    }

    private var resendRow: some View {
        VStack(spacing: 6) {
            if resendCooldown > 0 {
                Text("Didn't get the code? You can resend in \(resendCooldown)s")
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
            } else {
                Button {
                    resend()
                } label: {
                    HStack(spacing: 6) {
                        if isResending {
                            ProgressView()
                                .tint(.white)
                                .scaleEffect(0.7)
                        }
                        Text(isResending ? "Resending…" : "Resend code")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.white)
                    }
                }
                .disabled(isResending)
            }
        }
    }

    // MARK: - Actions

    private func verify() {
        guard !isVerifying else { return }
        isVerifying = true
        errorMessage = nil
        UIImpactFeedbackGenerator(style: .light).impactOccurred()

        Task {
            do {
                try await AuthService.shared.verifyOtp(email: email, code: code)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                // AuthService.saveSession() flips isAuthenticated; the
                // root WindowGroup automatically swaps to AppShell.
            } catch {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                code = ""
                errorMessage = "That code didn't work. Try again or resend."
                focused = true
            }
            isVerifying = false
        }
    }

    private func resend() {
        guard !isResending else { return }
        isResending = true
        errorMessage = nil

        Task {
            do {
                try await AuthService.shared.sendOtp(email: email)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                startResendCooldown()
            } catch {
                errorMessage = "Couldn't resend right now. Check your connection."
            }
            isResending = false
        }
    }

    private func startResendCooldown() {
        resendTimer?.invalidate()
        resendCooldown = 30
        resendTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { timer in
            Task { @MainActor in
                if resendCooldown > 0 {
                    resendCooldown -= 1
                } else {
                    timer.invalidate()
                }
            }
        }
    }
}
