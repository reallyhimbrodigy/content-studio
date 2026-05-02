import SwiftUI
import AVKit

struct LibraryView: View {
    @EnvironmentObject private var appState: AppState
    @State private var edits: [VideoJob] = []
    @State private var isLoading = true
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
        do { edits = try await APIService.shared.getUserEdits() } catch {}
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

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                // Large thumbnail + tap-to-play card — the actual video opens in
                // iOS's native fullscreen video modal via VideoPlayerPresenter
                // (no embedded AVPlayerViewController = no overlapping UI).
                if let urlStr = edit.rendered_video_url {
                    Button {
                        VideoPlayerPresenter.present(urlString: urlStr, jobId: edit.id)
                    } label: {
                        ZStack {
                            if let thumbStr = edit.thumbnail_url, let thumbUrl = URL(string: thumbStr) {
                                AsyncImage(url: thumbUrl) { phase in
                                    if let image = phase.image {
                                        image.resizable().aspectRatio(contentMode: .fit)
                                    } else {
                                        Color(.secondarySystemBackground)
                                    }
                                }
                            } else {
                                Color(.secondarySystemBackground)
                            }

                            LinearGradient(
                                colors: [.black.opacity(0.0), .black.opacity(0.35)],
                                startPoint: .center, endPoint: .bottom
                            )
                            .allowsHitTesting(false)

                            Circle()
                                .fill(.ultraThinMaterial)
                                .frame(width: 72, height: 72)
                                .overlay {
                                    Image(systemName: "play.fill")
                                        .font(.system(size: 26, weight: .semibold))
                                        .foregroundColor(.white)
                                        .offset(x: 2)
                                }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(maxHeight: .infinity)
                    }
                    .buttonStyle(.plain)
                }

                VStack(spacing: 14) {
                    if let vibe = edit.vibe_input, !vibe.isEmpty {
                        Text(vibe)
                            .font(.system(size: 14))
                            .foregroundColor(Color(.secondaryLabel))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .lineLimit(2)
                    }

                    if let urlStr = edit.rendered_video_url, let url = URL(string: urlStr) {
                        HStack(spacing: 12) {
                            ShareLink(item: url) {
                                HStack(spacing: 6) {
                                    Image(systemName: "square.and.arrow.up")
                                    Text("Share")
                                }
                                .font(.system(size: 15, weight: .semibold))
                                .frame(maxWidth: .infinity)
                                .frame(height: 46)
                                .background(Color.white)
                                .foregroundColor(.black)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            }

                            Button {
                                dismiss()
                                Task {
                                    try? await APIService.shared.deleteEdit(id: edit.id)
                                    onDelete()
                                }
                            } label: {
                                Image(systemName: "trash")
                                    .font(.system(size: 16))
                                    .frame(width: 46, height: 46)
                                    .background(Color(.tertiarySystemBackground))
                                    .foregroundColor(.red)
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            }
                        }
                    }
                }
                .padding(16)
                .background(Color(.systemBackground))
            }

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.white)
                    .frame(width: 36, height: 36)
                    .background(.ultraThinMaterial)
                    .clipShape(Circle())
            }
            .padding(.leading, 16)
            .padding(.top, 8)
        }
        .presentationDragIndicator(.visible)
    }
}
