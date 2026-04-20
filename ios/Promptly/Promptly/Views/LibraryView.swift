import SwiftUI
import AVKit

struct LibraryView: View {
    @State private var edits: [VideoJob] = []
    @State private var isLoading = true
    @State private var editToDelete: VideoJob?
    @State private var showDeleteConfirm = false
    @State private var selectedEdit: VideoJob?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                if isLoading {
                    ProgressView().tint(.white)
                } else if edits.isEmpty {
                    emptyState
                } else {
                    editList
                }
            }
            .navigationTitle("Library")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color.black, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .refreshable { await loadEdits() }
            .task { await loadEdits() }
            .confirmationDialog("Delete this edit?", isPresented: $showDeleteConfirm, presenting: editToDelete) { edit in
                Button("Delete", role: .destructive) { deleteEdit(edit) }
            }
            .sheet(item: $selectedEdit) { edit in
                VideoDetailSheet(edit: edit, onDelete: {
                    selectedEdit = nil
                    Task { await loadEdits() }
                })
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 20) {
            Image(systemName: "video.fill")
                .font(.system(size: 40))
                .foregroundColor(.white.opacity(0.1))

            Text("No edits yet")
                .font(.system(size: 20, weight: .semibold))
                .foregroundColor(.white)

            Text("Create your first edit and\nit will show up here.")
                .font(.system(size: 15))
                .foregroundColor(.white.opacity(0.4))
                .multilineTextAlignment(.center)
        }
    }

    private var editList: some View {
        List {
            ForEach(edits) { edit in
                EditRow(edit: edit, onTap: {
                    if edit.status == "completed" { selectedEdit = edit }
                }, onShare: {
                    // Handled via ShareLink in the row
                }, onDelete: {
                    editToDelete = edit
                    showDeleteConfirm = true
                })
                .listRowBackground(Color(.secondarySystemBackground))
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .listRowSeparatorTint(Color.white.opacity(0.06))
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color.black)
    }

    private func loadEdits() async {
        do { edits = try await APIService.shared.getUserEdits() } catch {}
        isLoading = false
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
    let onTap: () -> Void
    let onShare: () -> Void
    let onDelete: () -> Void
    @State private var showMenu = false

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 14) {
                // Thumbnail
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
                                .foregroundColor(.white.opacity(0.1))
                        }
                }

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
                            .foregroundColor(.white.opacity(0.4))

                        Text("·")
                            .foregroundColor(.white.opacity(0.2))

                        Text(formatDate(edit.created_at ?? ""))
                            .font(.system(size: 12))
                            .foregroundColor(.white.opacity(0.3))
                    }
                }

                Spacer()

                // Three-dot menu
                Menu {
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
                        .foregroundColor(.white.opacity(0.4))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
            }
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
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
    @State private var player: AVPlayer?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                // Video player — fills most of the screen
                if let urlStr = edit.rendered_video_url, let url = URL(string: urlStr) {
                    VideoPlayer(player: player ?? AVPlayer(url: url))
                        .onAppear {
                            if player == nil {
                                player = AVPlayer(url: url)
                                player?.play()
                            }
                        }
                        .onDisappear {
                            player?.pause()
                        }
                }

                // Bottom bar with actions and info
                VStack(spacing: 16) {
                    // Vibe text
                    if let vibe = edit.vibe_input, !vibe.isEmpty {
                        Text(vibe)
                            .font(.system(size: 14))
                            .foregroundColor(.white.opacity(0.6))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .lineLimit(2)
                    }

                    // Action buttons
                    if let urlStr = edit.rendered_video_url, let url = URL(string: urlStr) {
                        HStack(spacing: 12) {
                            ShareLink(item: url) {
                                HStack(spacing: 6) {
                                    Image(systemName: "square.and.arrow.up")
                                    Text("Share")
                                }
                                .font(.system(size: 15, weight: .medium))
                                .frame(maxWidth: .infinity)
                                .frame(height: 44)
                                .background(Color.white)
                                .foregroundColor(.black)
                                .cornerRadius(10)
                            }

                            Button {
                                player?.pause()
                                dismiss()
                                Task {
                                    try? await APIService.shared.deleteEdit(id: edit.id)
                                    onDelete()
                                }
                            } label: {
                                Image(systemName: "trash")
                                    .font(.system(size: 15))
                                    .frame(width: 44, height: 44)
                                    .background(Color(.tertiarySystemBackground))
                                    .foregroundColor(.red)
                                    .cornerRadius(10)
                            }
                        }
                    }
                }
                .padding(16)
                .background(Color.black)
            }

            // Close button — top left
            VStack {
                HStack {
                    Button {
                        player?.pause()
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.white)
                            .frame(width: 32, height: 32)
                            .background(.ultraThinMaterial)
                            .clipShape(Circle())
                    }
                    .padding(.leading, 16)
                    .padding(.top, 8)
                    Spacer()
                }
                Spacer()
            }
        }
        .presentationDragIndicator(.visible)
    }
}
