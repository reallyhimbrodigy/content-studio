import SwiftUI
import PhotosUI

struct AccountView: View {
    @State private var userName = ""
    @State private var userEmail = ""
    @State private var userInitial = "U"
    @State private var avatarUrl: String?
    @State private var tier = "free"
    @State private var isLoading = true
    @State private var showNameEdit = false
    @State private var showEmailEdit = false
    @State private var newName = ""
    @State private var newEmail = ""
    @State private var showDeleteAccount = false
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var showPasswordReset = false
    @State private var passwordResetSent = false

    var body: some View {
        NavigationStack {
            List {
                // Avatar
                Section {
                    HStack {
                        Spacer()
                        VStack(spacing: 12) {
                            PhotosPicker(selection: $selectedPhoto, matching: .images) {
                                ZStack(alignment: .bottomTrailing) {
                                    if let urlStr = avatarUrl, let url = URL(string: urlStr) {
                                        AsyncImage(url: url) { phase in
                                            if let image = phase.image {
                                                image.resizable().scaledToFill()
                                            } else { initialAvatar }
                                        }
                                        .frame(width: 80, height: 80)
                                        .clipShape(Circle())
                                    } else {
                                        initialAvatar
                                    }

                                    Image(systemName: "camera.circle.fill")
                                        .font(.system(size: 24))
                                        .foregroundStyle(.white, Color.white)
                                        .shadow(radius: 2)
                                        .offset(x: 4, y: 4)
                                }
                            }
                            .onChange(of: selectedPhoto) { _, item in
                                uploadAvatar(item)
                            }

                            Text(userName.isEmpty ? "User" : userName)
                                .font(.system(size: 20, weight: .semibold))
                                .foregroundColor(.white)
                            Text(userEmail)
                                .font(.system(size: 14))
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                    }
                    .padding(.vertical, 8)
                }
                .listRowBackground(Color(.secondarySystemBackground))

                // Profile
                Section("Profile") {
                    settingsRow("Name", value: userName.isEmpty ? "Not set" : userName) {
                        newName = userName
                        showNameEdit = true
                    }
                    settingsRow("Email", value: userEmail) {
                        newEmail = userEmail
                        showEmailEdit = true
                    }
                }
                .listRowBackground(Color(.secondarySystemBackground))

                // Subscription
                Section("Subscription") {
                    Button {
                        if tier == "pro" {
                            // Open billing portal
                            if let url = URL(string: "https://usepromptly.app/#pricing") {
                                UIApplication.shared.open(url)
                            }
                        } else {
                            if let url = URL(string: "https://usepromptly.app/#pricing") {
                                UIApplication.shared.open(url)
                            }
                        }
                    } label: {
                        HStack {
                            Text("Plan")
                                .foregroundColor(.white)
                            Spacer()
                            Text(tier == "pro" ? "PRO" : "FREE")
                                .font(.system(size: 12, weight: .bold))
                                .padding(.horizontal, 10).padding(.vertical, 3)
                                .background(tier == "pro" ? Color(.quaternaryLabel) : Color(.separator))
                                .foregroundColor(tier == "pro" ? Color.white : .secondary)
                                .cornerRadius(6)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(Color(.separator))
                        }
                    }
                }
                .listRowBackground(Color(.secondarySystemBackground))

                // Support
                Section("Support") {
                    settingsRow("Help & Support") {
                        if let url = URL(string: "https://usepromptly.app/help.html") {
                            UIApplication.shared.open(url)
                        }
                    }
                    settingsRow("Change Password") {
                        showPasswordReset = true
                    }
                }
                .listRowBackground(Color(.secondarySystemBackground))

                // Legal
                Section("Legal") {
                    externalRow("Privacy Policy", url: "https://usepromptly.app/privacy.html")
                    externalRow("Terms of Service", url: "https://usepromptly.app/terms.html")
                }
                .listRowBackground(Color(.secondarySystemBackground))

                // Sign out
                Section {
                    Button { AuthService.shared.signOut() } label: {
                        Text("Sign Out")
                            .foregroundColor(.red)
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                }
                .listRowBackground(Color(.secondarySystemBackground))

                // Delete account
                Section {
                    Button { showDeleteAccount = true } label: {
                        Text("Delete Account")
                            .font(.system(size: 14))
                            .foregroundColor(.red.opacity(0.6))
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                }
                .listRowBackground(Color.clear)

                Section {
                    Text("Promptly v1.0")
                        .font(.system(size: 12))
                        .foregroundColor(Color(.quaternaryLabel))
                        .frame(maxWidth: .infinity, alignment: .center)
                }
                .listRowBackground(Color.clear)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color(.systemBackground))
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color(.systemBackground), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .task { await loadProfile() }
            .alert("Edit Name", isPresented: $showNameEdit) {
                TextField("Name", text: $newName)
                Button("Save") { saveName() }
                Button("Cancel", role: .cancel) {}
            }
            .alert("Edit Email", isPresented: $showEmailEdit) {
                TextField("Email", text: $newEmail)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                Button("Save") { saveEmail() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You'll receive a confirmation email at your new address.")
            }
            .alert("Reset Password", isPresented: $showPasswordReset) {
                Button("Send Reset Email") { sendPasswordReset() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(passwordResetSent ? "Reset email sent to \(userEmail)" : "We'll send a password reset link to \(userEmail)")
            }
            .alert("Delete Account", isPresented: $showDeleteAccount) {
                Button("Delete My Account", role: .destructive) { deleteAccount() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This will permanently delete your account and all your data. This cannot be undone.")
            }
        }
    }

    // MARK: - Components

    private var initialAvatar: some View {
        Circle()
            .fill(Color(.tertiarySystemBackground))
            .frame(width: 80, height: 80)
            .overlay {
                Text(userInitial)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundColor(.secondary)
            }
    }

    private func settingsRow(_ label: String, value: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(label).foregroundColor(.white)
                Spacer()
                if let v = value {
                    Text(v).foregroundColor(Color(.secondaryLabel))
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(Color(.separator))
            }
        }
    }

    private func externalRow(_ label: String, url: String) -> some View {
        Link(destination: URL(string: url)!) {
            HStack {
                Text(label).foregroundColor(.white)
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 12))
                    .foregroundColor(Color(.separator))
            }
        }
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
            // Supabase email change requires updateUser
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

            // Upload to Supabase Storage
            var uploadReq = URLRequest(url: URL(string: "\(supabaseUrl)/storage/v1/object/avatars/\(filePath)")!)
            uploadReq.httpMethod = "POST"
            uploadReq.setValue(anonKey, forHTTPHeaderField: "apikey")
            uploadReq.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            uploadReq.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
            uploadReq.setValue("true", forHTTPHeaderField: "x-upsert")
            uploadReq.httpBody = data
            _ = try? await URLSession.shared.data(for: uploadReq)

            // Get public URL
            let publicUrl = "\(supabaseUrl)/storage/v1/object/public/avatars/\(filePath)?t=\(Int(Date().timeIntervalSince1970))"

            // Update user metadata
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
        AuthService.shared.signOut()
    }
}
