import SwiftUI

/// The account, small, in the header.
///
/// Deliberately an initial rather than a photo: the app has no avatar upload and
/// an email-OTP user has no picture, so a photo slot would be an empty circle
/// for most people. The initial comes from the display name when Apple sign-in
/// provided one, and falls back to a neutral glyph — never a placeholder face,
/// which reads as a broken image.
///
/// Signed out under deferred auth it still draws, and tapping it is one of the
/// actions that asks for an account. Hiding it would remove the only way in.
struct AccountAvatar: View {
    var onTap: () -> Void = {
        AppState.shared.showAccount = true
    }

    @State private var auth = AuthService.shared

    private var initial: String? {
        let name = auth.currentUser?.user_metadata?.full_name?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = name?.first else { return nil }
        return String(first).uppercased()
    }

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            onTap()
        } label: {
            ZStack {
                Circle()
                    .fill(Color.white.opacity(0.12))
                    .frame(width: 28, height: 28)
                if let initial {
                    Text(initial)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.white.opacity(0.9))
                } else {
                    Image(systemName: "person.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.white.opacity(0.75))
                }
            }
            .frame(width: 40, height: 40)   // full tap target around a small mark
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Account"))
    }
}
