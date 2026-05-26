import SwiftUI

/// Single source of truth for the user's profile circle. Used in the
/// sidebar header (ChatGPT-style top-right) and anywhere else we need
/// a tap-target that represents the signed-in user.
///
/// Source order:
///   1. `user_metadata.avatar_url` from Supabase — set by AccountView
///      when the user uploads a photo (covers both Apple/Google OAuth
///      avatars and manual uploads).
///   2. Initial letter fallback in a tinted circle when no photo exists.
///
/// The avatar URL is read on every render so a fresh upload reflects
/// without an app restart — Supabase's avatar URLs include a `?t=`
/// timestamp suffix that busts SwiftUI's AsyncImage cache.
struct ProfileAvatar: View {
    var size: CGFloat = 32

    private var avatarUrl: String? {
        AuthService.shared.currentUser?.user_metadata?.avatar_url
    }

    private var initial: String {
        let name = AuthService.shared.currentUser?.user_metadata?.full_name ?? ""
        let email = AuthService.shared.currentUser?.email ?? ""
        let source = name.isEmpty ? email : name
        guard let first = source.first else { return "?" }
        return String(first).uppercased()
    }

    var body: some View {
        Group {
            if let urlStr = avatarUrl, !urlStr.isEmpty, let url = URL(string: urlStr) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        fallback
                    }
                }
            } else {
                fallback
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().stroke(Color.white.opacity(0.08), lineWidth: 0.5))
    }

    private var fallback: some View {
        ZStack {
            Circle()
                .fill(Color(.tertiarySystemBackground))
            Text(initial)
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundColor(.primary)
        }
    }
}
