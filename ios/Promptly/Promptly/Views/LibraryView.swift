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
                    editList
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
                // Leading: "Select All" / "Deselect All" while selecting.
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
            .sheet(item: $selectedEdit) { edit in
                VideoDetailSheet(edit: edit, onDelete: {
                    selectedEdit = nil
                    Task { await loadEdits() }
                })
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

    private var editList: some View {
        List {
            ForEach(edits) { edit in
                EditRow(
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
                    onShare: {},
                    onDelete: {
                        editToDelete = edit
                        showDeleteConfirm = true
                    },
                    onReedit: {
                        startReedit(edit)
                    }
                )
                .listRowBackground(Color(.secondarySystemBackground))
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .listRowSeparatorTint(Color(.separator))
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color(.systemBackground))
        // Reserve space for the floating action bar so the last row
        // never sits underneath it.
        .safeAreaInset(edge: .bottom) {
            if isSelecting {
                Color.clear.frame(height: 50)
            }
        }
    }

    private func startReedit(_ edit: VideoJob) {
        guard edit.status == "completed" else { return }
        appState.pendingReedit = ReeditSession(
            originalJobId: edit.id,
            oldVibe: edit.vibe_input ?? "",
            thumbnailUrl: edit.thumbnail_url
        )
        appState.selectedTab = 0  // jump to Edit tab
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

// MARK: - Edit Row

struct EditRow: View {
    let edit: VideoJob
    let isSelecting: Bool
    let isSelected: Bool
    let onTap: () -> Void
    let onShare: () -> Void
    let onDelete: () -> Void
    let onReedit: () -> Void
    @State private var showMenu = false
    @ObservedObject private var cache = VideoCache.shared

    /// True when the actual rendered video file is on local disk and
    /// playback would be instant. Until then, the row's tap is disabled
    /// (outside selection mode) and a small spinner sits over the
    /// thumbnail to signal "downloading."
    private var isCached: Bool {
        edit.status == "completed" && cache.cachedIds.contains(edit.id)
    }
    /// CDN-backed URLs stream smoothly from the edge — tap is enabled
    /// immediately. Cache fills in the background for offline replay.
    private var isStreamingReady: Bool {
        guard edit.status == "completed",
              let url = edit.rendered_video_url else { return false }
        return isStreamingReadyUrl(url)
    }
    private var isPlayable: Bool { isCached || isStreamingReady }
    private var isDownloading: Bool {
        edit.status == "completed" && !isPlayable
    }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 14) {
                // Selection circle slides in from the leading edge when
                // selection mode activates. Native Photos pattern: empty
                // circle at tertiary, filled checkmark at accent when on.
                if isSelecting {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 22, weight: .regular))
                        .foregroundColor(isSelected ? Color.accentColor : Color(.tertiaryLabel))
                        .symbolRenderingMode(.hierarchical)
                        .frame(width: 22, height: 22)
                        .transition(.move(edge: .leading).combined(with: .opacity))
                        .accessibilityHidden(true)
                }

                // Thumbnail with download state overlay. While the video
                // file is still being pulled down, the row dims the
                // thumbnail and spins a small indicator on top so the
                // user can see exactly which rows are loading.
                ZStack {
                    if let thumbUrl = edit.thumbnail_url, let url = URL(string: thumbUrl) {
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let image):
                                image.resizable().aspectRatio(contentMode: .fill)
                            default:
                                Color(.tertiarySystemBackground)
                            }
                        }
                        .frame(width: 64, height: 80)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    } else {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color(.tertiarySystemBackground))
                            .frame(width: 64, height: 80)
                            .overlay {
                                Image(systemName: "video.fill")
                                    .foregroundColor(Color(.separator))
                            }
                    }

                    if isDownloading {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color.black.opacity(0.45))
                            .frame(width: 64, height: 80)
                        ProgressView()
                            .progressViewStyle(.circular)
                            .tint(.white)
                    }
                }
                .animation(.easeInOut(duration: 0.18), value: isCached)

                // Info
                VStack(alignment: .leading, spacing: 6) {
                    Text(edit.vibe_input ?? "Video edit")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(.white)
                        .lineLimit(2)

                    HStack(spacing: 6) {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 6, height: 6)

                        Text(statusText)
                            .font(.system(size: 12))
                            .foregroundColor(.secondary)

                        Text("·")
                            .foregroundColor(Color(.separator))

                        Text(formatDate(edit.created_at ?? ""))
                            .font(.system(size: 12))
                            .foregroundColor(Color(.tertiaryLabel))
                    }
                }

                Spacer()

                // Three-dot menu — hidden during selection mode so the
                // entire row becomes a clean toggle target.
                if !isSelecting {
                    Menu {
                        if edit.status == "completed" {
                            Button(action: onReedit) {
                                Label("Re-edit", systemImage: "wand.and.stars")
                            }
                        }
                        if edit.status == "completed", let urlStr = edit.rendered_video_url, let url = URL(string: urlStr) {
                            ShareLink(item: url) {
                                Label("Share", systemImage: "square.and.arrow.up")
                            }

                            Button {
                                UIApplication.shared.open(url)
                            } label: {
                                Label("Download", systemImage: "arrow.down.circle")
                            }
                        }

                        Button(role: .destructive, action: onDelete) {
                            Label("Delete", systemImage: "trash")
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundColor(.secondary)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("More options")
                    .transition(.opacity)
                }
            }
            .padding(.vertical, 4)
            .animation(.easeInOut(duration: 0.22), value: isSelecting)
        }
        .buttonStyle(.plain)
        // Outside selection mode, completed rows aren't tappable until
        // the video is playable — either cached locally OR served from
        // the CDN (which streams smoothly without needing a local file).
        // In selection mode, every row is always tappable so the user
        // can include in-flight videos in a bulk delete.
        .disabled(!isSelecting && edit.status == "completed" && !isPlayable)
        .task(id: edit.id) {
            // Auto-warm this row's cache the moment it appears. No-op
            // for already-cached rows or rows still processing on the
            // server. Coalesces with the bulk Library prefetch via
            // VideoCache's in-flight task map.
            guard edit.status == "completed",
                  let url = edit.rendered_video_url,
                  !cache.cachedIds.contains(edit.id) else { return }
            _ = await VideoCache.shared.downloadIfNeeded(jobId: edit.id, from: url)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(edit.vibe_input ?? "Video edit")
        .accessibilityValue("\(statusText), \(formatDate(edit.created_at ?? ""))" + (isSelecting ? (isSelected ? ", selected" : ", not selected") : "") + (isDownloading ? ", downloading" : ""))
        .accessibilityAddTraits(isSelecting && isSelected ? [.isSelected] : [])
    }

    private var statusColor: Color {
        switch edit.status {
        case "completed": return .green
        case "processing", "queued": return Color.white
        case "failed": return .red
        default: return .gray
        }
    }

    private var statusText: String {
        switch edit.status {
        case "completed": return "Completed"
        case "processing": return "Processing"
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
        if diff < 604800 { return "\(Int(diff / 86400))d ago" }
        let f = DateFormatter(); f.dateFormat = "MMM d"; return f.string(from: d)
    }
}

// MARK: - Video Detail Sheet

struct VideoDetailSheet: View {
    let edit: VideoJob
    let onDelete: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var showDeleteConfirm = false

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
                    HStack(spacing: 28) {
                        ShareLink(item: url) {
                            DetailActionIcon(systemName: "square.and.arrow.up", label: "Share")
                        }
                        DetailActionButton(systemName: "arrow.uturn.left", label: "Re-edit") {
                            // Just dismiss — Library row already has its
                            // own re-edit affordance for power users; this
                            // sheet's tertiary action stays in scope but
                            // simple. (Hook up real handler if/when we
                            // want to keep parity with the Library row.)
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
