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
    /// The Credits section and the upgrade path both read live state: the
    /// balance so the row updates when a top-up lands, and the flags so the
    /// section stays dark until the meter is armed and Max is purchasable.
    @ObservedObject private var credits = CreditsService.shared
    @ObservedObject private var onboarding = OnboardingState.shared

    @State private var userName = ""
    @State private var userEmail = ""
    @State private var userPhone = ""
    @State private var userInitial = "U"
    @State private var restoreInFlight = false
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
    @State private var showFeedbackSheet = false
    @State private var feedbackText = ""
    @State private var feedbackSent = false
    @State private var showLanguagePicker = false
    /// Mirrors AppLanguage.override so the row updates the moment a choice is
    /// made. `nil` = follow the device, which is the shipped default.
    @State private var languageOverride: String? = AppLanguage.override

    private var languageRowValue: String {
        if let code = languageOverride { return AppLanguage.label(for: code) }
        return "\(String(localized: "System")) (\(AppLanguage.label(for: AppLanguage.deviceResolved)))"
    }

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
                        .padding(.bottom, 20)

                    profileRow
                        .padding(.horizontal, 20)
                        .padding(.bottom, 26)

                    // ── ACCOUNT ──
                    settingsGroup("Account") {
                        cardRow("Name", value: userName.isEmpty ? "Not set" : userName) {
                            newName = userName; showNameEdit = true
                        }
                        cardDivider
                        cardRow("Email", value: userEmail) {
                            newEmail = userEmail; showEmailEdit = true
                        }
                        if !userPhone.isEmpty {
                            cardDivider
                            cardRow("Phone", value: userPhone, trailing: .none, action: nil)
                        }
                        cardDivider
                        subscriptionCardRow
                        cardDivider
                        cardRow("Restore purchases", trailing: restoreInFlight ? .progress : .none) {
                            restorePurchases()
                        }
                        cardDivider
                        upgradeOrManageRow
                    }

                    // ── CREDITS ──
                    // Its own section, and only while the meter is live. The
                    // balance is also in the header badge, but the header shows
                    // a number and nothing else; this is where the number is
                    // explained — what the allowance is, when it renews, and
                    // how to buy more.
                    if onboarding.creditsEnabled {
                        settingsGroup("Credits") {
                            creditsBalanceRow
                            cardDivider
                            cardRow("Buy more credits", trailing: .none) {
                                Analytics.track("credits_topup_open", props: ["source": "account"])
                                AppState.shared.showCredits = true
                            }
                        }
                    }

                    // ── SETTINGS ──
                    settingsGroup("Settings") {
                        cardRow("Change password") { showPasswordReset = true }
                        cardDivider
                        // Value reads "System (हिन्दी)" when following the device
                        // so the row states BOTH that nothing is overridden and
                        // what the device actually resolved to — otherwise a user
                        // seeing "System" cannot tell which language that is.
                        cardRow(String(localized: "Language"), value: languageRowValue) {
                            showLanguagePicker = true
                        }
                        cardDivider
                        cardRow("Notifications") { openSystemSettings() }
                    }

                    // ── GET HELP ──
                    settingsGroup("Get help") {
                        cardRow("Report an issue") {
                            feedbackText = ""; feedbackSent = false; showFeedbackSheet = true
                        }
                        cardDivider
                        cardRow("Help center") { openExternal("https://usepromptly.app/help.html") }
                        cardDivider
                        cardRow("Privacy Policy") { openExternal("https://usepromptly.app/privacy.html") }
                        cardDivider
                        cardRow("Terms of Service") { openExternal("https://usepromptly.app/terms.html") }
                    }

                    // ── LOG OUT ──
                    Button { AuthService.shared.signOut() } label: {
                        Text("Log out")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(.white)
                            .frame(maxWidth: .infinity)
                            .frame(height: 52)
                            .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)

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
                    // 40 CLEARED THE PHONE AND NOT THE iPAD. "Delete account"
                    // — the last row — sat inside the home-indicator band on an
                    // 11-inch iPad, measured off the capture matrix. The safe
                    // area is the right unit for a distance to the screen edge;
                    // a constant is a guess that happens to be right on the
                    // device it was checked against.
                    .padding(.bottom, 40)
                    .safeAreaPadding(.bottom)
                }
                // THE ACCOUNT PAGE HAD NO WIDTH BOUND. Rows ran the full 834pt
                // of an iPad, which is a phone list stretched rather than a
                // layout. Capped with the same column every conversion surface
                // uses; a no-op on iPhone.
                .conversionColumn(ConversionColumn.content)
            }
            .background(Color(.systemBackground))
            // Account is a sheet now (opened from the drawer) — give it a close.
            .overlay(alignment: .topTrailing) {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    AppState.shared.showAccount = false
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(.white)
                        .frame(width: 32, height: 32)
                        .background(Color.white.opacity(0.08), in: Circle())
                }
                .padding(.trailing, 16)
                .padding(.top, 14)
                .accessibilityLabel("Close")
            }
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
            .sheet(isPresented: $showFeedbackSheet) {
                feedbackSheet
            }
            .sheet(isPresented: $showLanguagePicker) {
                languagePickerSheet
            }
        }
    }

    // MARK: - Language

    /// An OVERRIDE, not the mechanism. "System" is first and is the default:
    /// iOS already matches the device's preferred languages against the twelve
    /// we ship, and that path works. This exists for the user whose phone is in
    /// one language and who wants the app in another — a common case where a
    /// shared or work device is not set to the owner's first language.
    ///
    /// Each row is labelled in its OWN script, so someone who cannot read the
    /// current UI language can still find theirs.
    private var languagePickerSheet: some View {
        NavigationStack {
            List {
                Section {
                    languageRow(code: nil,
                                label: String(localized: "System"),
                                detail: AppLanguage.label(for: AppLanguage.deviceResolved))
                } footer: {
                    Text("Follows your device language. Change it in iOS Settings.")
                }
                Section {
                    ForEach(AppLanguage.supported, id: \.code) { lang in
                        languageRow(code: lang.code, label: lang.label, detail: nil)
                    }
                } footer: {
                    // Said plainly rather than left for the user to discover.
                    // The change genuinely lands on the next launch: almost all
                    // of this app's copy is String(localized:), which resolves
                    // against the bundle chosen at process start. Claiming an
                    // instant switch would mean a part-translated screen.
                    if AppLanguage.overridePendingRestart {
                        Text("Reopen Promptly to finish switching language.")
                    } else {
                        Text("Takes effect the next time you open Promptly.")
                    }
                }
            }
            .navigationTitle(String(localized: "Language"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Done")) { showLanguagePicker = false }
                }
            }
        }
    }

    private func languageRow(code: String?, label: String, detail: String?) -> some View {
        Button {
            AppLanguage.override = code
            languageOverride = code
            Analytics.track("language_changed", props: [
                "language": code ?? "system",
                "resolved": AppLanguage.current,
                "source": "account",
            ])
            showLanguagePicker = false
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                    if let detail {
                        Text(detail).font(.system(size: 12)).foregroundColor(.secondary)
                    }
                }
                Spacer()
                if languageOverride == code {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .semibold))
                }
            }
        }
    }

    // MARK: - Feedback sheet (passive "Send feedback" entry)

    private var feedbackSheet: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("What's on your mind? Bugs, ideas, anything — it comes straight to us.")
                    .font(.system(size: 15))
                    .foregroundColor(Color(.secondaryLabel))

                TextField("Your feedback", text: $feedbackText, axis: .vertical)
                    .lineLimit(5...12)
                    .padding(12)
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                Spacer()
            }
            .padding(20)
            .navigationTitle("Send feedback")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showFeedbackSheet = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        let text = feedbackText.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task { await FeedbackManager.shared.submitFeedback(rating: nil, text: text, jobId: nil) }
                        showFeedbackSheet = false
                    }
                    .disabled(feedbackText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    // MARK: - Subscription rows (card-styled)

    /// Current-plan status row: a gold PRO badge when Pro, a neutral FREE chip
    /// otherwise. Taps to Apple's manage page (Pro) or the paywall (free).
    private var subscriptionCardRow: some View {
        Button {
            if effectiveIsPro {
                openExternal("https://apps.apple.com/account/subscriptions")
            } else {
                AppState.shared.presentPaywall(.manual)
            }
        } label: {
            HStack(spacing: 10) {
                Text("Subscription")
                    .font(.system(size: 16))
                    .foregroundColor(.white)
                Spacer()
                // THE ACTUAL TIER, not a Pro/Free binary. With Max live, a Max
                // subscriber reading "PRO" is being told they are on the tier
                // below the one they pay for.
                if subscription.isMax {
                    Text("MAX")
                        .font(.system(size: 11, weight: .bold))
                        .padding(.horizontal, 9).padding(.vertical, 3)
                        .background(Color.white, in: Capsule())
                        .foregroundColor(.black)
                } else if effectiveIsPro {
                    PROBadge()
                } else {
                    Text("FREE")
                        .font(.system(size: 11, weight: .bold))
                        .padding(.horizontal, 9).padding(.vertical, 3)
                        .background(Color.white.opacity(0.08), in: Capsule())
                        .foregroundColor(.secondary)
                }
                chevron
            }
            .padding(.horizontal, 16).frame(height: 52).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Subscription")
        .accessibilityValue(subscription.isMax ? "Max" : (effectiveIsPro ? "Pro" : "Free"))
    }

    /// The accent CTA row — an UPGRADE PATH ONLY WHEN ONE EXISTS.
    ///
    /// This read `effectiveIsPro ? "Manage subscription" : "Upgrade to Promptly
    /// Pro"`, a binary written when Pro was the only paid tier. With Max live
    /// that is wrong at both ends: a Max subscriber was offered an upgrade to
    /// the tier BELOW the one they pay for, and a Pro subscriber was shown no
    /// path to Max at all.
    ///
    /// Three states now, and the top tier is defined by what is actually
    /// purchasable: while `max_tier` is dark Pro IS the top tier, so a Pro
    /// subscriber correctly sees Manage rather than an upgrade to something
    /// nobody can buy. That keeps this row honest without a second flag check
    /// at the call site.
    private var canUpgrade: Bool {
        if subscription.isMax { return false }
        if !effectiveIsPro { return true }
        return onboarding.maxTierEnabled   // Pro -> Max, only once Max is real
    }

    private var upgradeOrManageRow: some View {
        Button {
            if canUpgrade {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                AppState.shared.presentPaywall(.manual)
            } else {
                openExternal("https://apps.apple.com/account/subscriptions")
            }
        } label: {
            HStack(spacing: 10) {
                if canUpgrade {
                    Image(systemName: "sparkles")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(PromptlyGold.gradient)
                }
                Text(upgradeLabel)
                    .font(.system(size: 16, weight: canUpgrade ? .semibold : .regular))
                    .foregroundColor(canUpgrade ? PromptlyGold.solid : .white)
                Spacer()
                chevron
            }
            .padding(.horizontal, 16).frame(height: 52).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var upgradeLabel: String {
        if !canUpgrade { return String(localized: "Manage subscription") }
        return effectiveIsPro
            ? String(localized: "Upgrade to Promptly Max")
            : String(localized: "Upgrade to Promptly Pro")
    }

    /// Balance, allowance and renewal in one row.
    ///
    /// Every line is OMITTED rather than guessed. `balance` is nil until the
    /// server has actually been read, and a zero printed from an unread balance
    /// is the same false claim the badge refuses to make — so an unknown
    /// balance shows a dash, not a zero. The allowance line only appears when a
    /// tier allowance is known, and the renewal line only when the server sent
    /// a date.
    private var creditsBalanceRow: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Balance")
                    .font(.system(size: 16))
                    .foregroundColor(.white)
                if let sub = creditsSubtitle {
                    sub
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }
            }
            Spacer()
            // `Text(balance.map { "\(  $0 )" })` looked harmless and put a bare
            // `%lld` in the string catalog — the interpolation reads as a
            // localizable key with no sentence around it, untranslatable by
            // anyone who ever opens the catalog. `format: .number` also gets
            // locale-correct digits and grouping, which the interpolation did
            // not, and matches how CreditBadge renders the same value.
            Group {
                if let b = credits.balance {
                    Text(b, format: .number)
                        .foregroundColor(b == 0 ? .secondary : .white)
                } else {
                    Text(verbatim: "—").foregroundColor(.secondary)
                }
            }
            .font(.system(size: 16, weight: .semibold))
            .monospacedDigit()
        }
        .padding(.horizontal, 16).frame(minHeight: 52)
    }

    /// "200 credits/month - about 20 videos". Derived from the same constants
    /// the paywall uses, so the two cannot disagree about what money buys.
    ///
    /// A `Text`, NOT a `String`. Inflection is resolved when a
    /// LocalizedStringKey is rendered; `String(localized:)` returns the markup
    /// verbatim, so this line read "200 credits a month - about ^[20
    /// video](inflect: true)" to every subscriber who opened the account
    /// screen. Two catalogue gates passed it — the key is present, translated,
    /// and correctly inflected — because both check the CATALOGUE and neither
    /// checked the CALL. `inflection-render-gate.sh` now checks the call.
    private var creditsSubtitle: Text? {
        guard let monthly = onboarding.creditsMonthlyAllowance ?? ProBenefits.storeKitAllowance(),
              monthly > 0 else { return nil }
        let videos = ProBenefits.monthlyVideos(credits: monthly)
        return Text("\(monthly) credits a month - about ^[\(videos) video](inflect: true)")
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

    // MARK: - Grouped card system (ChatGPT-style)

    enum CardTrailing { case chevron, progress, none }

    /// A grouped section: an uppercase header label above a rounded card that
    /// holds the rows. Mirrors the structure in iOS Settings / ChatGPT.
    private func settingsGroup<Content: View>(_ header: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(header.uppercased())
                .font(.system(size: 12, weight: .semibold))
                .tracking(0.5)
                .foregroundColor(.secondary)
                .padding(.horizontal, 32)
            VStack(spacing: 0) { content() }
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .padding(.horizontal, 16)
        }
        .padding(.bottom, 26)
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 13, weight: .semibold))
            .foregroundColor(Color(.tertiaryLabel))
            .accessibilityHidden(true)
    }

    /// One row inside a card. `action == nil` renders a non-tappable display row.
    private func cardRow(_ label: String, value: String? = nil, tint: Color = .white,
                         trailing: CardTrailing = .chevron, action: (() -> Void)?) -> some View {
        Button { action?() } label: {
            HStack(spacing: 10) {
                Text(label)
                    .font(.system(size: 16))
                    .foregroundColor(tint)
                Spacer()
                if let v = value, !v.isEmpty {
                    Text(v)
                        .font(.system(size: 15))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
                switch trailing {
                case .chevron: chevron
                case .progress: ProgressView().controlSize(.small).tint(.secondary)
                case .none: EmptyView()
                }
            }
            .padding(.horizontal, 16).frame(height: 52).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityValue(value ?? "")
    }

    /// Inset hairline between rows in a card.
    private var cardDivider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.08))
            .frame(height: 0.5)
            .padding(.leading, 16)
    }

    // MARK: - Small actions

    private func openExternal(_ urlString: String) {
        if let url = URL(string: urlString) { UIApplication.shared.open(url) }
    }

    private func openSystemSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }

    private func restorePurchases() {
        guard !restoreInFlight else { return }
        restoreInFlight = true
        Task {
            _ = await subscription.restorePurchases()
            await UsageService.shared.refresh()
            restoreInFlight = false
        }
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
        userPhone = auth.currentUser?.phone ?? ""
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
