import SwiftUI
import PhotosUI

struct AccountView: View {
    // Observe BOTH Pro signals so the view re-renders the moment either
    // flips. RevenueCat (SubscriptionService) is authoritative for paid
    // purchases; UsageService is authoritative for server-comped or
    // RevenueCat-out-of-sync users (e.g. when profiles.tier='pro' is
    // hand-set via SQL but the iOS RevenueCat client cache hasn't
    // synced). `effectiveIsPro` returns true if EITHER says so — that's
    // the only way an SQL-comped user sees the Pro affordance.
    @ObservedObject private var subscription = SubscriptionService.shared
    @ObservedObject private var usage = UsageService.shared

    @State private var userName = ""
    @State private var userEmail = ""
    @State private var userInitial = "U"
    @State private var avatarUrl: String?
    @State private var tier = "free"
    @State private var isLoading = true

    private var effectiveIsPro: Bool {
        subscription.isPro || usage.isPro
    }
    @State private var showNameEdit = false
    @State private var showEmailEdit = false
    @State private var newName = ""
    @State private var newEmail = ""
    @State private var showDeleteAccount = false
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var showPasswordReset = false
    @State private var passwordResetSent = false
    @State private var isDeletingAccount = false
    @State private var deleteAccountError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // Large title
                    Text("Account")
                        .font(.system(size: 34, weight: .bold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 20)
                        .padding(.top, 12)
                        .padding(.bottom, 24)

                    profileRow
                        .padding(.horizontal, 20)
                        .padding(.bottom, 20)

                    divider

                    row("Name", value: userName.isEmpty ? "Not set" : userName) {
                        newName = userName
                        showNameEdit = true
                    }
                    divider

                    row("Email", value: userEmail) {
                        newEmail = userEmail
                        showEmailEdit = true
                    }
                    divider

                    subscriptionRow
                    divider

                    row("Change password") {
                        showPasswordReset = true
                    }
                    divider

                    row("Help & support") {
                        if let url = URL(string: "https://usepromptly.app/help.html") {
                            UIApplication.shared.open(url)
                        }
                    }
                    divider

                    row("Privacy policy") {
                        if let url = URL(string: "https://usepromptly.app/privacy.html") {
                            UIApplication.shared.open(url)
                        }
                    }
                    divider

                    row("Terms of service") {
                        if let url = URL(string: "https://usepromptly.app/terms.html") {
                            UIApplication.shared.open(url)
                        }
                    }
                    divider

                    // Log out button
                    Button { AuthService.shared.signOut() } label: {
                        Text("Log out")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(.black)
                            .frame(maxWidth: .infinity)
                            .frame(height: 56)
                            .background(Color.white)
                            .clipShape(Capsule())
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 32)

                    // Delete + version
                    VStack(spacing: 14) {
                        Button { showDeleteAccount = true } label: {
                            HStack(spacing: 8) {
                                if isDeletingAccount {
                                    ProgressView()
                                        .controlSize(.small)
                                        .tint(.red.opacity(0.75))
                                }
                                Text(isDeletingAccount ? "Deleting account…" : "Delete account")
                                    .font(.system(size: 13))
                                    .foregroundColor(.red.opacity(0.75))
                            }
                        }
                        .disabled(isDeletingAccount)

                        Text(versionString)
                            .font(.system(size: 12))
                            .foregroundColor(Color(.tertiaryLabel))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 24)
                    .padding(.bottom, 40)
                }
            }
            .background(Color(.systemBackground))
            .toolbar(.hidden, for: .navigationBar)
            .scrollDismissesKeyboard(.interactively)
            .dismissKeyboardOnTap()
            .task { await loadProfile() }
            .task {
                // Pull a fresh /api/usage snapshot whenever the Account
                // tab appears. Catches the "server says Pro, RevenueCat
                // says free" case (SQL-comped users, RevenueCat webhook
                // drift) so `effectiveIsPro` reflects current truth
                // without needing an app relaunch.
                await UsageService.shared.refresh()
            }
            .alert("Edit name", isPresented: $showNameEdit) {
                TextField("Name", text: $newName)
                Button("Save") { saveName() }
                Button("Cancel", role: .cancel) {}
            }
            .alert("Edit email", isPresented: $showEmailEdit) {
                TextField("Email", text: $newEmail)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                Button("Save") { saveEmail() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You'll receive a confirmation email at your new address.")
            }
            .alert("Reset password", isPresented: $showPasswordReset) {
                Button("Send reset email") { sendPasswordReset() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(passwordResetSent ? "Reset email sent to \(userEmail)" : "We'll send a password reset link to \(userEmail)")
            }
            .alert("Delete account", isPresented: $showDeleteAccount) {
                Button("Delete my account", role: .destructive) { deleteAccount() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This will permanently delete your account and all your data. This cannot be undone.")
            }
            .alert("Couldn't delete account", isPresented: Binding(
                get: { deleteAccountError != nil },
                set: { if !$0 { deleteAccountError = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(deleteAccountError ?? "")
            }
        }
    }

    // MARK: - Subscription row

    /// Inlined (rather than going through the generic `row` helper) so
    /// the Pro state can render the gold-gradient PROBadge — the helper
    /// only handles plain-text badges. Tap behaviour matches the old row:
    /// Pro → Apple's manage-subscriptions URL; free → present the paywall.
    private var subscriptionRow: some View {
        Button {
            if effectiveIsPro {
                // Apple's standard subscription-management URL — opens
                // straight into the user's subscriptions list in Settings.
                // Only correct way to cancel an App Store subscription.
                if let url = URL(string: "https://apps.apple.com/account/subscriptions") {
                    UIApplication.shared.open(url)
                }
            } else {
                AppState.shared.paywallReason = .manual
            }
        } label: {
            HStack(spacing: 8) {
                Text("Subscription")
                    .font(.system(size: 17))
                    .foregroundColor(.white)
                Spacer()
                if effectiveIsPro {
                    PROBadge()
                } else {
                    Text("FREE")
                        .font(.system(size: 11, weight: .bold))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 3)
                        .background(Color(.tertiarySystemBackground))
                        .foregroundColor(.secondary)
                        .clipShape(Capsule())
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(Color(.tertiaryLabel))
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 20)
            .frame(height: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Subscription")
        .accessibilityValue(effectiveIsPro ? "Pro" : "Free")
    }

    // MARK: - Profile row

    private var profileRow: some View {
        HStack(spacing: 14) {
            PhotosPicker(selection: $selectedPhoto, matching: .images) {
                ZStack(alignment: .bottomTrailing) {
                    avatarCircle
                        // Premium aura — a soft gold glow around the
                        // avatar when the user is Pro. Reads as "you're
                        // special" without putting a literal crown on
                        // their face. Easy to spot at a glance the
                        // moment the Account tab opens.
                        .shadow(
                            color: effectiveIsPro
                                ? PromptlyGold.solid.opacity(0.55)
                                : .clear,
                            radius: 10, y: 0
                        )
                    Circle()
                        .fill(Color.white)
                        .frame(width: 20, height: 20)
                        .overlay {
                            Image(systemName: "camera.fill")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(.black)
                        }
                        .overlay(
                            Circle().stroke(Color(.systemBackground), lineWidth: 2)
                        )
                }
            }
            .accessibilityLabel("Change profile photo")
            .onChange(of: selectedPhoto) { _, item in uploadAvatar(item) }

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(userName.isEmpty ? "User" : userName)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(.white)
                        .lineLimit(1)
                    // Inline PRO badge — sits right next to the name
                    // so it reads as part of the user's identity, not
                    // a separate status indicator. Hidden entirely for
                    // free users so the header stays clean (no "FREE"
                    // chip — free is the default, nothing to celebrate).
                    if effectiveIsPro {
                        PROBadge(compact: true)
                    }
                }
                Text(userEmail)
                    .font(.system(size: 14))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private var avatarCircle: some View {
        if let urlStr = avatarUrl, let url = URL(string: urlStr) {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    initialCircle
                }
            }
            .frame(width: 56, height: 56)
            .clipShape(Circle())
        } else {
            initialCircle
        }
    }

    private var initialCircle: some View {
        Circle()
            .fill(Color(.tertiarySystemBackground))
            .frame(width: 56, height: 56)
            .overlay {
                Text(userInitial)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(.secondary)
            }
    }

    // MARK: - Row

    private func row(_ label: String, value: String? = nil, badge: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(label)
                    .font(.system(size: 17))
                    .foregroundColor(.white)
                Spacer()
                if let badge = badge {
                    Text(badge)
                        .font(.system(size: 11, weight: .bold))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 3)
                        .background(badge == "PRO" ? Color.white : Color(.tertiarySystemBackground))
                        .foregroundColor(badge == "PRO" ? .black : .secondary)
                        .clipShape(Capsule())
                } else if let v = value {
                    Text(v)
                        .font(.system(size: 15))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(Color(.tertiaryLabel))
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 20)
            .frame(height: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityValue(badge ?? value ?? "")
    }

    private var divider: some View {
        Rectangle()
            .fill(Color(.separator).opacity(0.5))
            .frame(height: 0.5)
            .padding(.horizontal, 20)
    }

    private var versionString: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
        return "Promptly v\(version) (\(build))"
    }

    // MARK: - Actions

    private func loadProfile() async {
        let auth = AuthService.shared
        userName = auth.currentUser?.user_metadata?.full_name ?? ""
        userEmail = auth.currentUser?.email ?? ""
        userInitial = String((userName.isEmpty ? userEmail : userName).prefix(1)).uppercased()
        avatarUrl = auth.currentUser?.user_metadata?.avatar_url
        tier = await auth.getUserTier()
        isLoading = false
    }

    private func saveName() {
        Task {
            try? await AuthService.shared.updateUserName(newName)
            userName = newName
            userInitial = String(newName.prefix(1)).uppercased()
        }
    }

    private func saveEmail() {
        Task {
            guard let token = AuthService.shared.accessToken else { return }
            let url = URL(string: "https://ejxkzsfruykvgeouymfy.supabase.co/auth/v1/user")!
            var request = URLRequest(url: url)
            request.httpMethod = "PUT"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE", forHTTPHeaderField: "apikey")
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.httpBody = try? JSONEncoder().encode(["email": newEmail])
            _ = try? await URLSession.shared.data(for: request)
        }
    }

    private func sendPasswordReset() {
        Task {
            let url = URL(string: "https://ejxkzsfruykvgeouymfy.supabase.co/auth/v1/recover")!
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE", forHTTPHeaderField: "apikey")
            request.httpBody = try? JSONEncoder().encode(["email": userEmail])
            _ = try? await URLSession.shared.data(for: request)
            passwordResetSent = true
        }
    }

    private func uploadAvatar(_ item: PhotosPickerItem?) {
        guard let item = item else { return }
        Task {
            guard let data = try? await item.loadTransferable(type: Data.self),
                  let userId = AuthService.shared.currentUser?.id,
                  let token = AuthService.shared.accessToken else { return }

            let supabaseUrl = "https://ejxkzsfruykvgeouymfy.supabase.co"
            let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE"
            let filePath = "\(userId).jpg"

            var uploadReq = URLRequest(url: URL(string: "\(supabaseUrl)/storage/v1/object/avatars/\(filePath)")!)
            uploadReq.httpMethod = "POST"
            uploadReq.setValue(anonKey, forHTTPHeaderField: "apikey")
            uploadReq.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            uploadReq.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
            uploadReq.setValue("true", forHTTPHeaderField: "x-upsert")
            uploadReq.httpBody = data
            _ = try? await URLSession.shared.data(for: uploadReq)

            let publicUrl = "\(supabaseUrl)/storage/v1/object/public/avatars/\(filePath)?t=\(Int(Date().timeIntervalSince1970))"

            var updateReq = URLRequest(url: URL(string: "\(supabaseUrl)/auth/v1/user")!)
            updateReq.httpMethod = "PUT"
            updateReq.setValue("application/json", forHTTPHeaderField: "Content-Type")
            updateReq.setValue(anonKey, forHTTPHeaderField: "apikey")
            updateReq.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            updateReq.httpBody = try? JSONSerialization.data(withJSONObject: ["data": ["avatar_url": publicUrl]])
            _ = try? await URLSession.shared.data(for: updateReq)

            avatarUrl = publicUrl
            selectedPhoto = nil
        }
    }

    private func deleteAccount() {
        guard !isDeletingAccount else { return }
        isDeletingAccount = true
        Task {
            do {
                try await APIService.shared.deleteAccount()
                AuthService.shared.signOut()
            } catch {
                isDeletingAccount = false
                deleteAccountError = "We couldn't delete your account right now. Please check your connection and try again, or contact support@usepromptly.app if this keeps happening."
            }
        }
    }
}
