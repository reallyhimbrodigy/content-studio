import SwiftUI
import AVKit

struct LibraryView: View {
    @EnvironmentObject private var appState: AppState
    @State private var edits: [VideoJob] = []
    @State private var isLoading = true
    @State private var loadFailed = false
    @State private var hasLoadedOnce = false
    @State private var editToDelete: VideoJob?
    @State private var showDeleteConfirm = false
    @State private var selectedEdit: VideoJob?
    /// RACE 2: the edit whose Re-edit was tapped inside the detail sheet. Held
    /// until the sheet's onDismiss so the handoff (and paywall) fires after close.
    @State private var reeditAfterDismiss: VideoJob?

    // Multi-select / bulk delete. Mirrors the Photos / Files / Mail
    // selection pattern: trailing "Select" → "Done"; leading "Select All"
    // when active; bottom action bar slides in showing the live count.
    @State private var isSelecting = false
    @State private var selectedIds: Set<String> = []
    @State private var showBulkDeleteConfirm = false
    @State private var isDeletingBulk = false

    private var navTitle: String {
        if isSelecting {
            if selectedIds.isEmpty { return "Select Items" }
            return "\(selectedIds.count) Selected"
        }
        return "Library"
    }

    private var allSelectableIds: [String] { edits.map { $0.id } }

    var body: some View {
        NavigationStack {
            ZStack {
                Color(.systemBackground).ignoresSafeArea()

                if isLoading {
                    ProgressView().tint(.white)
                } else if loadFailed && edits.isEmpty {
                    failedState
                } else if edits.isEmpty {
                    emptyState
                } else {
                    editGrid
                }

                // Bottom action bar — slides in when selection mode is on.
                // Native Photos pattern: pinned to the bottom safe area,
                // ultraThinMaterial blur, large red Delete title with the
                // live count, disabled when nothing is selected.
                if isSelecting {
                    VStack {
                        Spacer()
                        bulkActionBar
                    }
                    .ignoresSafeArea(.keyboard)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .navigationTitle(navTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color(.systemBackground), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                // Leading: "Select All" / "Deselect All" while selecting; a Close
                // button (Library is a sheet now) otherwise.
                ToolbarItem(placement: .topBarLeading) {
                    if isSelecting {
                        Button(selectedIds.count == allSelectableIds.count ? "Deselect All" : "Select All") {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            if selectedIds.count == allSelectableIds.count {
                                selectedIds.removeAll()
                            } else {
                                selectedIds = Set(allSelectableIds)
                            }
                        }
                        .foregroundColor(.white)
                    } else {
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            AppState.shared.showLibrary = false
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 15, weight: .semibold))
                        }
                        .foregroundColor(.white)
                        .accessibilityLabel("Close")
                    }
                }
                // Trailing: "Select" enters mode; "Done" exits.
                ToolbarItem(placement: .topBarTrailing) {
                    if isSelecting {
                        Button("Done") { exitSelectMode() }
                            .fontWeight(.semibold)
                            .foregroundColor(.white)
                    } else if !edits.isEmpty {
                        Button("Select") {
                            withAnimation(.easeInOut(duration: 0.22)) {
                                isSelecting = true
                            }
                        }
                        .foregroundColor(.white)
                    }
                }
            }
            .refreshable { if !isSelecting { await loadEdits() } }
            .task { await loadEdits() }
            // The MainTabView keeps Library mounted (via opacity-toggled
            // ZStack) so .task only fires once at app launch. If auth
            // wasn't ready then, the initial load throws notAuthenticated
            // and the view sticks on emptyState/failedState until the
            // user manually pull-to-refreshes. Reload whenever the user
            // navigates INTO this tab so a fresh sign-in or a transient
            // auth blip self-heals on tap.
            .onChange(of: appState.selectedTab) { _, newTab in
                guard newTab == 1, !isSelecting else { return }
                Task { await loadEdits() }
            }
            .confirmationDialog("Delete this edit?", isPresented: $showDeleteConfirm, presenting: editToDelete) { edit in
                Button("Delete", role: .destructive) { deleteEdit(edit) }
            }
            .confirmationDialog(
                bulkConfirmMessage,
                isPresented: $showBulkDeleteConfirm,
                titleVisibility: .visible
            ) {
                Button("Delete \(selectedIds.count) \(selectedIds.count == 1 ? "Edit" : "Edits")", role: .destructive) {
                    bulkDelete()
                }
                Button("Cancel", role: .cancel) { }
            }
            .sheet(item: $selectedEdit, onDismiss: {
                // RACE 2 fix: run the re-edit handoff (and, for a free user, its
                // paywall) only AFTER the detail sheet has fully dismissed. Doing
                // both in the same tick silently drops the paywall — the exact rule
                // ModelPicker follows via its own onDismiss.
                if let e = reeditAfterDismiss {
                    reeditAfterDismiss = nil
                    startReedit(e)
                }
            }) { edit in
                VideoDetailSheet(
                    edit: edit,
                    onDelete: {
                        selectedEdit = nil
                        Task { await loadEdits() }
                    },
                    onReedit: {
                        // Signal intent only; the sheet's own dismiss() closes it
                        // and the onDismiss above performs the handoff post-close.
                        reeditAfterDismiss = edit
                    }
                )
            }
        }
    }

    private var bulkConfirmMessage: String {
        let n = selectedIds.count
        return n == 1
            ? "Delete this edit? It will be removed from your library."
            : "Delete \(n) edits? They will be removed from your library."
    }

    @ViewBuilder
    private var bulkActionBar: some View {
        HStack {
            Spacer()
            Button {
                guard !selectedIds.isEmpty else { return }
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                showBulkDeleteConfirm = true
            } label: {
                Group {
                    if isDeletingBulk {
                        ProgressView().tint(.red)
                    } else {
                        HStack(spacing: 6) {
                            Image(systemName: "trash")
                                .font(.system(size: 16, weight: .semibold))
                            Text(selectedIds.isEmpty ? "Delete" : "Delete (\(selectedIds.count))")
                                .font(.system(size: 17, weight: .semibold))
                        }
                    }
                }
                .foregroundColor(selectedIds.isEmpty ? Color(.tertiaryLabel) : .red)
                .frame(height: 44)
                .frame(maxWidth: .infinity)
            }
            .disabled(selectedIds.isEmpty || isDeletingBulk)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .padding(.top, 10)
        .background(
            Rectangle()
                .fill(.ultraThinMaterial)
                .overlay(alignment: .top) {
                    Rectangle()
                        .fill(Color(.separator).opacity(0.6))
                        .frame(height: 0.5)
                }
                .ignoresSafeArea(edges: .bottom)
        )
    }

    private func toggleSelection(_ id: String) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        if selectedIds.contains(id) {
            selectedIds.remove(id)
        } else {
            selectedIds.insert(id)
        }
    }

    private func exitSelectMode() {
        withAnimation(.easeInOut(duration: 0.22)) {
            isSelecting = false
            selectedIds.removeAll()
        }
    }

    /// Fan out deletes in parallel — typical user picks 5-20 items, doing
    /// them serially would feel laggy. APIService.deleteEdit is idempotent
    /// server-side so any racing duplicates are safe.
    private func bulkDelete() {
        let ids = selectedIds
        guard !ids.isEmpty else { return }
        isDeletingBulk = true
        Task {
            await withTaskGroup(of: Void.self) { group in
                for id in ids {
                    group.addTask {
                        try? await APIService.shared.deleteEdit(id: id)
                        await VideoCache.shared.remove(jobId: id)
                    }
                }
            }
            await loadEdits()
            await MainActor.run {
                isDeletingBulk = false
                exitSelectMode()
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 20) {
            Image(systemName: "video.fill")
                .font(.system(size: 40))
                .foregroundColor(Color(.separator))

            Text("No edits yet")
                .font(.system(size: 20, weight: .semibold))
                .foregroundColor(.white)

            Text("Create your first edit and\nit will show up here.")
                .font(.system(size: 15))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    // Distinct state for "fetch failed" so we don't lie to the user with
    // "No edits yet" when actually we couldn't load them. Tap retries.
    private var failedState: some View {
        Button {
            Task {
                isLoading = true
                await loadEdits()
            }
        } label: {
            VStack(spacing: 20) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 40))
                    .foregroundColor(Color(.separator))

                Text("Couldn't load your library")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(.white)

                Text("Tap to retry.")
                    .font(.system(size: 15))
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .buttonStyle(.plain)
    }

    // Two-column card grid — the video-first Library look. Each card is a
    // square thumbnail with a centered play button, title, and time below.
    // Every behavior the List had is preserved (tap → detail sheet, selection
    // mode, cache/prefetch, download + status states, re-edit via context menu).
    private var gridColumns: [GridItem] {
        [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]
    }

    private var editGrid: some View {
        ScrollView {
            LazyVGrid(columns: gridColumns, alignment: .leading, spacing: 20) {
                ForEach(edits) { edit in
                    EditCard(
                        edit: edit,
                        isSelecting: isSelecting,
                        isSelected: selectedIds.contains(edit.id),
                        onTap: {
                            if isSelecting {
                                toggleSelection(edit.id)
                            } else if edit.status == "completed" {
                                selectedEdit = edit
                            }
                        },
                        onDelete: {
                            editToDelete = edit
                            showDeleteConfirm = true
                        },
                        onReedit: {
                            startReedit(edit)
                        }
                    )
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            // Reserve room for the floating bulk-action bar so the last row
            // never sits underneath it.
            .padding(.bottom, isSelecting ? 78 : 28)
            .animation(.easeInOut(duration: 0.22), value: isSelecting)
        }
        .scrollContentBackground(.hidden)
        .background(Color(.systemBackground))
    }

    private func startReedit(_ edit: VideoJob) {
        guard edit.status == "completed" else { return }
        Analytics.track("reedit_tap", props: ["source": "library", "isPro": SubscriptionService.shared.effectiveIsPro])
        // Pro gate: re-edit is paid. Free users see the paywall instead
        // of getting dropped into the editor where the dispatch would
        // eventually 402 anyway. Matches the MessageBubble gate so all
        // entry points behave identically. effectiveIsPro so server-comped
        // users (SQL update, RevenueCat-out-of-sync) get through too.
        if !SubscriptionService.shared.effectiveIsPro {
            appState.presentPaywall(.reedit)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            return
        }
        appState.pendingReedit = ReeditSession(
            originalJobId: edit.id,
            oldVibe: edit.vibe_input ?? "",
            thumbnailUrl: edit.thumbnail_url
        )
        appState.showLibrary = false  // dismiss the Library sheet; EditorView picks up pendingReedit
    }

    private func loadEdits() async {
        do {
            let fetched = try await APIService.shared.getUserEdits()
            edits = fetched
            loadFailed = false
        } catch {
            // Don't blow away a previously-populated list — keep what we
            // had so the user isn't staring at "No edits" because of a
            // transient blip. Only flip to the failed state if we have
            // nothing to show.
            print("[library] loadEdits failed: \(error.localizedDescription)")
            loadFailed = true
        }
        hasLoadedOnce = true
        isLoading = false
        // Eager prefetch: warm the local cache for the most-recent
        // completed edits so taps in the Library are Photos-app instant.
        // Up to 50 — the cache eviction at 1 GB is the real ceiling, and
        // serialized downloads inside VideoCache mean these don't burst
        // the network even at 50 concurrent calls. Anything older than
        // the 50 most-recent gets fetched lazily on first tap.
        let toPrefetch: [(id: String, url: String)] = edits
            .prefix(50)
            .compactMap { edit in
                guard edit.status == "completed",
                      let url = edit.rendered_video_url else { return nil }
                return (edit.id, url)
            }
        for entry in toPrefetch {
            Task.detached(priority: .background) {
                await VideoCache.shared.downloadIfNeeded(jobId: entry.id, from: entry.url)
            }
        }
    }

    private func deleteEdit(_ edit: VideoJob) {
        Task {
            try? await APIService.shared.deleteEdit(id: edit.id)
            await loadEdits()
        }
    }
}

// MARK: - Edit Card (grid)

struct EditCard: View {
    let edit: VideoJob
    let isSelecting: Bool
    let isSelected: Bool
    let onTap: () -> Void
    let onDelete: () -> Void
    let onReedit: () -> Void
    @ObservedObject private var cache = VideoCache.shared
    @StateObject private var exporter: VideoExporter

    init(
        edit: VideoJob,
        isSelecting: Bool,
        isSelected: Bool,
        onTap: @escaping () -> Void,
        onDelete: @escaping () -> Void,
        onReedit: @escaping () -> Void
    ) {
        self.edit = edit
        self.isSelecting = isSelecting
        self.isSelected = isSelected
        self.onTap = onTap
        self.onDelete = onDelete
        self.onReedit = onReedit
        _exporter = StateObject(wrappedValue: VideoExporter(
            videoUrlStr: edit.rendered_video_url ?? "",
            thumbnailUrlStr: edit.thumbnail_url
        ))
    }

    /// True when the rendered file is on local disk and playback is instant.
    private var isCached: Bool {
        edit.status == "completed" && cache.cachedIds.contains(edit.id)
    }
    /// CDN-backed URLs stream smoothly from the edge — tap enabled immediately.
    private var isStreamingReady: Bool {
        guard edit.status == "completed",
              let url = edit.rendered_video_url else { return false }
        return isStreamingReadyUrl(url)
    }
    private var isPlayable: Bool { isCached || isStreamingReady }
    private var isDownloading: Bool { edit.status == "completed" && !isPlayable }
    private var isCompleted: Bool { edit.status == "completed" }

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 9) {
                thumbnail

                VStack(alignment: .leading, spacing: 3) {
                    Text(edit.vibe_input?.isEmpty == false ? edit.vibe_input! : "Video edit")
                        .font(.system(size: 14.5, weight: .medium))
                        .foregroundColor(.white)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)

                    Text(subtitle)
                        .font(.system(size: 12.5))
                        .foregroundColor(isCompleted ? Color(.tertiaryLabel) : statusColor)
                        .lineLimit(1)
                }
                .padding(.horizontal, 2)
            }
        }
        .buttonStyle(.plain)
        // Outside selection mode, completed cards aren't tappable until the
        // video is playable (cached OR CDN-streamable). In selection mode
        // every card is tappable so in-flight videos can be bulk-deleted.
        .disabled(!isSelecting && isCompleted && !isPlayable)
        .contextMenu {
            if !isSelecting {
                if isCompleted {
                    Button(action: onReedit) {
                        Label("Re-edit", systemImage: "wand.and.stars")
                    }
                }
                if isCompleted, let urlStr = edit.rendered_video_url, let url = URL(string: urlStr) {
                    Button { exporter.save() } label: {
                        Label("Save to Photos", systemImage: "square.and.arrow.down")
                    }
                    ShareLink(item: url) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                }
                Button(role: .destructive, action: onDelete) {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
        .task(id: edit.id) {
            // Auto-warm this card's cache the moment it appears. No-op for
            // already-cached or still-processing rows. Coalesces with the
            // bulk Library prefetch via VideoCache's in-flight task map.
            guard isCompleted,
                  let url = edit.rendered_video_url,
                  !cache.cachedIds.contains(edit.id) else { return }
            _ = await VideoCache.shared.downloadIfNeeded(jobId: edit.id, from: url)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(edit.vibe_input ?? "Video edit")
        .accessibilityValue("\(statusText), \(formatDate(edit.created_at ?? ""))" + (isSelecting ? (isSelected ? ", selected" : ", not selected") : "") + (isDownloading ? ", downloading" : ""))
        .accessibilityAddTraits(isSelecting && isSelected ? [.isSelected] : [])
    }

    // Square thumbnail with a centered play button + status/selection overlays.
    private var thumbnail: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if let thumbUrl = edit.thumbnail_url, let url = URL(string: thumbUrl) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().aspectRatio(contentMode: .fill)
                        case .empty:
                            ZStack {
                                Color(.tertiarySystemBackground)
                                ProgressView().tint(.white.opacity(0.5))
                            }
                        default:
                            placeholderFill
                        }
                    }
                } else {
                    placeholderFill
                }
            }
            // Subtle vignette so the play button reads on bright frames.
            .overlay {
                LinearGradient(
                    colors: [.black.opacity(0.28), .black.opacity(0.0), .black.opacity(0.12)],
                    startPoint: .top, endPoint: .bottom
                )
                .allowsHitTesting(false)
            }
            .overlay { centerOverlay }
            .overlay(alignment: .topTrailing) {
                if isSelecting {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 22, weight: .regular))
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(
                            isSelected ? Color.white : Color.white.opacity(0.9),
                            isSelected ? Color.accentColor : Color.black.opacity(0.25)
                        )
                        .padding(8)
                        .shadow(color: .black.opacity(0.35), radius: 3, y: 1)
                        .transition(.scale.combined(with: .opacity))
                        .accessibilityHidden(true)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Color.white.opacity(isSelected ? 0.0 : 0.06), lineWidth: 0.5)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Color.accentColor, lineWidth: isSelected ? 2.5 : 0)
            )
            .animation(.easeInOut(duration: 0.18), value: isCached)
            .animation(.easeInOut(duration: 0.18), value: isSelected)
    }

    private var placeholderFill: some View {
        ZStack {
            Color(.tertiarySystemBackground)
            Image(systemName: "video.fill")
                .font(.system(size: 26))
                .foregroundColor(Color(.separator))
        }
    }

    @ViewBuilder
    private var centerOverlay: some View {
        if isDownloading {
            ZStack {
                Color.black.opacity(0.35)
                ProgressView().progressViewStyle(.circular).tint(.white)
            }
        } else if isCompleted {
            // Play button — the video-first affordance from the mockup.
            ZStack {
                Circle()
                    .fill(.ultraThinMaterial)
                    .frame(width: 46, height: 46)
                    .overlay(Circle().stroke(Color.white.opacity(0.18), lineWidth: 0.5))
                    .shadow(color: .black.opacity(0.3), radius: 10, y: 3)
                Image(systemName: "play.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(.white)
                    .offset(x: 1.5)
            }
            .allowsHitTesting(false)
        } else if edit.status == "failed" {
            ZStack {
                Color.black.opacity(0.35)
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(.white.opacity(0.85))
            }
        } else {
            // processing / queued
            ZStack {
                Color.black.opacity(0.3)
                ProgressView().progressViewStyle(.circular).tint(.white)
            }
        }
    }

    private var subtitle: String {
        isCompleted ? formatDate(edit.created_at ?? "") : statusText
    }

    private var statusColor: Color {
        switch edit.status {
        case "completed": return .green
        case "processing", "queued": return Color(.secondaryLabel)
        case "failed": return .red
        default: return .gray
        }
    }

    private var statusText: String {
        switch edit.status {
        case "completed": return "Completed"
        case "processing": return "Processing…"
        case "queued": return "Queued"
        case "failed": return "Failed"
        default: return edit.status
        }
    }

    private func formatDate(_ dateStr: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: dateStr) ?? {
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: dateStr)
        }()
        guard let d = date else { return "" }
        let diff = Date().timeIntervalSince(d)
        if diff < 60 { return "Now" }
        if diff < 3600 { return "\(Int(diff / 60))m ago" }
        if diff < 86400 { return "\(Int(diff / 3600))h ago" }
        if diff < 172800 { return "Yesterday" }
        if diff < 604800 { return "\(Int(diff / 86400))d ago" }
        let f = DateFormatter(); f.dateFormat = "MMM d"; return f.string(from: d)
    }
}

// MARK: - Video Detail Sheet

struct VideoDetailSheet: View {
    let edit: VideoJob
    let onDelete: () -> Void
    let onReedit: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var showDeleteConfirm = false
    @StateObject private var exporter: VideoExporter

    init(edit: VideoJob, onDelete: @escaping () -> Void, onReedit: @escaping () -> Void) {
        self.edit = edit
        self.onDelete = onDelete
        self.onReedit = onReedit
        _exporter = StateObject(wrappedValue: VideoExporter(
            videoUrlStr: edit.rendered_video_url ?? "",
            thumbnailUrlStr: edit.thumbnail_url
        ))
    }

    // The Save action button morphs as it works — same affordance the
    // chat-side Save uses. Idle = down-arrow, loading = hourglass-ish
    // spinner via SF Symbol fallback, success = check, error = warning.
    private var saveIcon: String {
        switch exporter.saveState {
        case .idle:    return "arrow.down.to.line"
        case .loading: return "arrow.down.circle"
        case .success: return "checkmark"
        case .error:   return "exclamationmark.triangle"
        }
    }
    private var saveLabel: String {
        switch exporter.saveState {
        case .idle:    return "Save"
        case .loading: return "Saving…"
        case .success: return "Saved"
        case .error:   return "Failed"
        }
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            // Backdrop: blurred thumbnail blown up behind the card. Gives
            // the sheet a cinematic, color-tinted depth without us having
            // to do any color extraction. Falls back to pure black if
            // no thumbnail (very rare — only the moment before a render
            // completes, in which case this sheet isn't reachable).
            if let thumbStr = edit.thumbnail_url, let thumbUrl = URL(string: thumbStr) {
                AsyncImage(url: thumbUrl) { phase in
                    if let image = phase.image {
                        image
                            .resizable()
                            .scaledToFill()
                            .blur(radius: 60)
                            .opacity(0.55)
                            .overlay(Color.black.opacity(0.4))
                    } else {
                        Color.black
                    }
                }
                .ignoresSafeArea()
            } else {
                Color.black.ignoresSafeArea()
            }

            VStack(spacing: 0) {
                // Headroom for the close button.
                Color.clear.frame(height: 52)

                // Video preview — vertical aspect, breathing room around
                // it, generous rounded corners. Tap to open the player.
                if let urlStr = edit.rendered_video_url {
                    Button {
                        VideoPlayerPresenter.present(
                            urlString: urlStr,
                            hlsManifestUrl: edit.hls_manifest_url,
                            thumbnailUrl: edit.thumbnail_url,
                            jobId: edit.id,
                            title: edit.vibe_input
                        )
                    } label: {
                        ZStack {
                            if let thumbStr = edit.thumbnail_url, let thumbUrl = URL(string: thumbStr) {
                                AsyncImage(url: thumbUrl) { phase in
                                    if let image = phase.image {
                                        image.resizable().scaledToFill()
                                    } else {
                                        Color.white.opacity(0.04)
                                    }
                                }
                            } else {
                                Color.white.opacity(0.04)
                            }

                            // Light vignette pulls focus to the play button.
                            LinearGradient(
                                colors: [.black.opacity(0.05), .black.opacity(0.0), .black.opacity(0.25)],
                                startPoint: .top, endPoint: .bottom
                            )
                            .allowsHitTesting(false)

                            ZStack {
                                Circle()
                                    .fill(.ultraThinMaterial)
                                    .frame(width: 76, height: 76)
                                    .overlay(Circle().stroke(Color.white.opacity(0.16), lineWidth: 0.5))
                                    .shadow(color: .black.opacity(0.35), radius: 18, y: 6)
                                Image(systemName: "play.fill")
                                    .font(.system(size: 28, weight: .semibold))
                                    .foregroundColor(.white)
                                    .offset(x: 2)
                            }
                        }
                        .aspectRatio(9.0/16.0, contentMode: .fit)
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 28, style: .continuous)
                                .stroke(Color.white.opacity(0.08), lineWidth: 0.5)
                        )
                        .shadow(color: .black.opacity(0.45), radius: 30, y: 16)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 28)
                }

                Spacer(minLength: 18)

                // Title — restrained, light weight, single line. The vibe
                // input is the title; "Your edit" is the unobtrusive eyebrow.
                VStack(spacing: 4) {
                    Text("Your edit")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(1.2)
                        .foregroundColor(Color.white.opacity(0.45))
                    Text(edit.vibe_input?.isEmpty == false ? edit.vibe_input! : "Untitled")
                        .font(.system(size: 22, weight: .semibold, design: .default))
                        .foregroundColor(.white)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                }

                Spacer(minLength: 22)

                // Circular icon action row — all three actions in
                // ultraThinMaterial circles, equal weight. Replaces the
                // jarring red trash + giant white pill that was
                // breaking the visual harmony.
                if let urlStr = edit.rendered_video_url, let url = URL(string: urlStr) {
                    HStack(spacing: 22) {
                        DetailActionButton(systemName: saveIcon, label: saveLabel) {
                            exporter.save()
                        }
                        ShareLink(item: url) {
                            DetailActionIcon(systemName: "square.and.arrow.up", label: "Share")
                        }
                        // Pro-aware Re-edit affordance. Pro users see the
                        // standard ultra-thin chrome with the gold-gradient
                        // icon + a soft gold glow ("premium feature");
                        // free users see a lock glyph inside the circle
                        // with no gold — visually communicates that the
                        // button isn't for them, but tapping still pops
                        // the paywall via the onReedit closure so they
                        // can convert.
                        ReeditDetailButton(isPro: SubscriptionService.shared.effectiveIsPro) {
                            // Stash intent, then dismiss — the parent sheet's
                            // onDismiss fires the re-edit/paywall once closed (RACE 2).
                            onReedit()
                            dismiss()
                        }
                        DetailActionButton(systemName: "trash", label: "Delete") {
                            showDeleteConfirm = true
                        }
                    }
                    .padding(.bottom, 36)
                }
            }

            // Close button.
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 36, height: 36)
                    .background(.ultraThinMaterial)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(Color.white.opacity(0.12), lineWidth: 0.5))
            }
            .padding(.leading, 18)
            .padding(.top, 14)
        }
        .preferredColorScheme(.dark)
        .presentationDragIndicator(.visible)
        .confirmationDialog(
            "Delete this edit?",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                dismiss()
                Task {
                    try? await APIService.shared.deleteEdit(id: edit.id)
                    onDelete()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This edit will be permanently removed.")
        }
    }
}

// MARK: - Action button primitives
//
// Two flavors because ShareLink needs a label-only View while Button
// owns its tap action. Identical visual weight so the row reads as
// one unit.

private struct DetailActionIcon: View {
    let systemName: String
    let label: String
    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle()
                    .fill(.ultraThinMaterial)
                    .frame(width: 56, height: 56)
                    .overlay(Circle().stroke(Color.white.opacity(0.12), lineWidth: 0.5))
                Image(systemName: systemName)
                    .font(.system(size: 19, weight: .medium))
                    .foregroundColor(.white)
            }
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(Color.white.opacity(0.7))
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

private struct DetailActionButton: View {
    let systemName: String
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        }) {
            DetailActionIcon(systemName: systemName, label: label)
        }
        .buttonStyle(.plain)
    }
}

/// Re-edit variant of the DetailAction circle button. Shape and size
/// match the other actions in the sheet so the row stays rhythmic;
/// what changes is the icon styling per Pro state.
private struct ReeditDetailButton: View {
    let isPro: Bool
    let action: () -> Void
    var body: some View {
        Button(action: {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        }) {
            VStack(spacing: 8) {
                ZStack {
                    Circle()
                        .fill(.ultraThinMaterial)
                        .frame(width: 56, height: 56)
                        .overlay(
                            Circle().stroke(
                                isPro ? AnyShapeStyle(PromptlyGold.gradient)
                                      : AnyShapeStyle(Color.white.opacity(0.12)),
                                lineWidth: isPro ? 1.2 : 0.5
                            )
                        )
                        .shadow(
                            color: isPro ? PromptlyGold.solid.opacity(0.35) : .clear,
                            radius: 10, y: 0
                        )
                    if isPro {
                        Image(systemName: "wand.and.stars")
                            .font(.system(size: 19, weight: .medium))
                            .foregroundStyle(PromptlyGold.gradient)
                    } else {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(.white.opacity(0.7))
                    }
                }
                Text("Re-edit")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(Color.white.opacity(0.7))
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Re-edit this video")
        .accessibilityValue(isPro ? "" : "Pro feature, tap to unlock")
    }
}
