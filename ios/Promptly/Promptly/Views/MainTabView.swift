import SwiftUI

/// The primary surface. Sidebar-restructure (2026-07-24): the bottom Edit/Library/
/// Account tab bar was removed — Edit is now the sole full-screen surface, and
/// Library + Account are sheets opened from the drawer (AppShell). The struct name
/// is kept so AppShell's call site doesn't churn.
///
/// In-app ready-state (2026-07-30): a returning user who has a FINISHED video they
/// haven't watched yet sees it here — a dismissible card pinned above the editor's
/// top bar — instead of it being buried in the Library sheet. This recovery path
/// works for EVERY user regardless of push tokens, permissions, or email: it reads
/// the same completed-edit list the Library does and tracks "seen" ids locally.
struct MainTabView: View {
    // Singleton store, observed for the featured/dismissed state. Using the shared
    // instance keeps the seen-set + last fetch consistent across foreground cycles.
    @StateObject private var readyStore = ReadyStateStore.shared

    var body: some View {
        EditorView()
            .ignoresSafeArea(.keyboard)
            .background(Color(.systemBackground))
            // The ready-state card sits ABOVE the editor's own custom top bar (which
            // is itself a top safe-area inset). It reserves space only while a
            // featured video exists, so navigation is untouched the rest of the time.
            .safeAreaInset(edge: .top, spacing: 0) {
                Group {
                    if let job = readyStore.featured {
                        ReadyVideoBanner(
                            job: job,
                            extraCount: readyStore.extraCount,
                            onOpen: { readyStore.markSeen(job.id) },
                            onDismiss: { readyStore.dismissFeatured() }
                        )
                        .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
                .animation(.spring(response: 0.42, dampingFraction: 0.86), value: readyStore.featured?.id)
            }
            // Compute the featured unviewed video on first mount…
            .task { await readyStore.refresh() }
            // …and again on every foreground resume, so a render that finished while
            // the app was backgrounded surfaces the moment the user returns.
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
                Task { await readyStore.refresh() }
            }
    }
}

// MARK: - Ready-state store
//
// Sources completed videos from the SAME endpoint the Library uses
// (APIService.getUserEdits) and computes "the most recent COMPLETED video the user
// has NOT yet seen." "Seen" is a Set<String> of job ids persisted in UserDefaults —
// a job is unviewed iff its id isn't in that set.
//
// Heuristic (documented per the additive-feature brief): because "seen" can only be
// tracked from the moment this feature ships, we ALSO require the edit to be recent
// (created within `recencyWindow`). Without it, every pre-existing completed edit in
// a returning user's library would read as "unviewed" on the first launch after
// update and the card would surface an ancient, already-watched video. The window
// keeps the card honest — it fires for genuinely-just-finished renders the user
// hasn't opened, which is exactly the recovery case — while still catching a video
// that completed a few days ago and was never watched.
@MainActor
final class ReadyStateStore: ObservableObject {
    static let shared = ReadyStateStore()

    /// The most recent unviewed completed video, or nil when there's nothing to show.
    @Published private(set) var featured: VideoJob?
    /// How many OTHER unviewed completed videos exist beyond the featured one.
    @Published private(set) var extraCount: Int = 0

    /// UserDefaults key for the set of job ids the user has already seen (opened or
    /// dismissed). Stored as a [String] since Set isn't a plist type.
    private let seenKey = "promptly.readyState.seenJobIds"

    /// Only feature edits completed within this window (see heuristic note above).
    private static let recencyWindow: TimeInterval = 7 * 24 * 60 * 60  // 7 days

    /// Last successful fetch, kept so markSeen/dismiss can recompute without a
    /// network round-trip.
    private var lastFetched: [VideoJob] = []

    /// A render-complete push tap asks us to open ONE specific job's video. On a
    /// cold launch the tap fires before the window and the edits list exist, so we
    /// hold the request and drain it (drainPendingOpen) after the next successful
    /// fetch AND once a scene is foreground-active. `pendingOpenAt` expires the
    /// request so a much-later foreground never yanks the user into a stale video.
    private var pendingOpenJobId: String?
    private var pendingOpenAt: Date?

    private init() {}

    // MARK: Seen-set persistence

    private var seenIds: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: seenKey) ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: seenKey) }
    }

    /// Mark a job id as seen so its card never shows again, then recompute.
    func markSeen(_ id: String) {
        var s = seenIds
        guard !s.contains(id) else { return }
        s.insert(id)
        seenIds = s
        recompute()
    }

    /// Dismiss the current card without opening it — same effect as opening for the
    /// purposes of "show once": the featured video is marked seen.
    func dismissFeatured() {
        guard let f = featured else { return }
        Analytics.track("ready_banner_dismiss", props: ["jobId": f.id])
        markSeen(f.id)
    }

    // MARK: Fetch + compute

    func refresh() async {
        do {
            lastFetched = try await APIService.shared.getUserEdits()
            recompute()
            // A push tap may be waiting on this fetch to resolve its job.
            drainPendingOpen()
        } catch {
            // Best-effort recovery affordance: a fetch failure just means no card
            // this pass. The Library sheet surfaces load errors to the user; the
            // card stays silent so it never becomes a source of noise.
            print("[readyState] refresh failed: \(error.localizedDescription)")
        }
    }

    /// Entry point for a render-complete push tap. Before this, a tap ignored the
    /// jobId and only refreshed the banner — landing on the home surface and, on a
    /// re-tap of an already-seen job, on nothing at all. Now the tap lands on the
    /// actual video: resolve the job and present the player, deferring past the
    /// cold-launch window if the UI/edits aren't up yet. Falls back to the banner
    /// (via refresh) when the job can't be resolved.
    func requestOpenJob(_ jobId: String) {
        pendingOpenJobId = jobId
        pendingOpenAt = Date()
        // Warm path: edits already loaded → present immediately.
        drainPendingOpen()
        // Still pending (cold launch, or job not in the cached list) → fetch, which
        // drains again once it returns. MainTabView's .task/foreground refresh also
        // drains, so a tap that arrives before the scene is active still lands.
        if pendingOpenJobId != nil {
            Task { await refresh() }
        }
    }

    /// Present the pending job's video if it has resolved AND a scene is
    /// foreground-active. Keeps the request pending (does not clear) when the job
    /// isn't in the list yet or the window isn't up — so a later drain lands it —
    /// but drops it once the request is older than the expiry so a stale tap never
    /// interrupts a much-later session.
    private func drainPendingOpen() {
        guard let jobId = pendingOpenJobId, let at = pendingOpenAt else { return }
        if Date().timeIntervalSince(at) > 120 {
            pendingOpenJobId = nil
            pendingOpenAt = nil
            return
        }
        guard let job = lastFetched.first(where: { $0.id == jobId }) else { return }
        // The player presents over the key window; on a cold launch the tap runs
        // before any scene is foreground-active, where present() would no-op. Hold
        // the request until the UI is up rather than losing it.
        let active = UIApplication.shared.connectedScenes
            .contains { $0.activationState == .foregroundActive }
        guard active else { return }
        pendingOpenJobId = nil
        pendingOpenAt = nil
        markSeen(job.id) // so the banner doesn't also surface it — one landing, not two
        guard let urlStr = job.rendered_video_url, !urlStr.isEmpty else { return }
        VideoPlayerPresenter.present(
            urlString: urlStr,
            hlsManifestUrl: job.hls_manifest_url,
            thumbnailUrl: job.thumbnail_url,
            jobId: job.id,
            title: job.vibe_input
        )
    }

    private func recompute() {
        let seen = seenIds
        let cutoff = Date().addingTimeInterval(-Self.recencyWindow)

        let candidates = lastFetched
            .filter { job in
                job.status == "completed"
                    && (job.rendered_video_url?.isEmpty == false)
                    && !seen.contains(job.id)
                    && (Self.parseDate(job.created_at) ?? .distantPast) >= cutoff
            }
            .sorted {
                (Self.parseDate($0.created_at) ?? .distantPast)
                    > (Self.parseDate($1.created_at) ?? .distantPast)
            }

        let newFeatured = candidates.first
        // Only reassign (and fire the "shown" event) when the featured id actually
        // changes, so recompute() during a foreground refresh doesn't re-trigger the
        // insertion transition or double-count the impression.
        if featured?.id != newFeatured?.id {
            featured = newFeatured
            if let f = newFeatured {
                Analytics.track("ready_banner_shown", props: ["jobId": f.id])
            }
        }
        extraCount = max(0, candidates.count - 1)
    }

    /// Parses the API's ISO-8601 created_at (with or without fractional seconds).
    /// Mirrors LibraryView's date parsing so recency math agrees across surfaces.
    private static func parseDate(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}

// MARK: - Ready-state card
//
// Restrained, on-brand card: thumbnail + "Your video is ready 🎬" + a subtle
// subtitle, gold-accented to match the app's Pro language (PromptlyGold). Tapping
// the body opens the video through the SAME player path the Library detail sheet
// uses (VideoPlayerPresenter.present). Tapping the ✕ dismisses. Both mark the video
// seen so the card shows exactly once.
private struct ReadyVideoBanner: View {
    let job: VideoJob
    let extraCount: Int
    let onOpen: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            // Tappable open region — the thumbnail + copy. Kept as a plain
            // contentShape + onTapGesture (not a Button) so it never competes with
            // the dismiss Button beside it for the same touch.
            HStack(spacing: 12) {
                thumbnail

                VStack(alignment: .leading, spacing: 2) {
                    Text("Your video is ready 🎬")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(.white)
                        .lineLimit(1)

                    Text(subtitle)
                        .font(.system(size: 12.5))
                        .foregroundColor(Color(.secondaryLabel))
                        .lineLimit(1)
                }

                Spacer(minLength: 4)
            }
            .contentShape(Rectangle())
            .onTapGesture { open() }

            // Dismiss.
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(Color(.secondaryLabel))
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .padding(.vertical, 9)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(.secondarySystemBackground))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(PromptlyGold.gradient, lineWidth: 1)
                        .opacity(0.55)
                )
        )
        .shadow(color: .black.opacity(0.35), radius: 14, y: 6)
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Your video is ready. \(subtitle). Double tap to watch.")
    }

    private func open() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        onOpen()  // mark seen before presenting, so returning never re-shows it
        Analytics.track("ready_banner_open", props: ["jobId": job.id])
        guard let urlStr = job.rendered_video_url else { return }
        // Reuse the exact player entry point the Library detail sheet uses — cache-,
        // HLS-, and CDN-aware, presents its own full-screen player over the key window.
        VideoPlayerPresenter.present(
            urlString: urlStr,
            hlsManifestUrl: job.hls_manifest_url,
            thumbnailUrl: job.thumbnail_url,
            jobId: job.id,
            title: job.vibe_input
        )
    }

    private var subtitle: String {
        if extraCount > 0 {
            return "Tap to watch · \(extraCount) more ready in Library"
        }
        if let v = job.vibe_input, !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return v
        }
        return "Tap to watch your new edit"
    }

    private var thumbnail: some View {
        RoundedRectangle(cornerRadius: 11, style: .continuous)
            .fill(Color(.tertiarySystemBackground))
            .frame(width: 46, height: 46)
            .overlay {
                if let t = job.thumbnail_url, let u = URL(string: t) {
                    AsyncImage(url: u) { phase in
                        if let img = phase.image {
                            img.resizable().scaledToFill()
                        } else {
                            filmIcon
                        }
                    }
                } else {
                    filmIcon
                }
            }
            // Play affordance so the thumbnail reads as tappable video.
            .overlay {
                Image(systemName: "play.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(.white)
                    .shadow(color: .black.opacity(0.55), radius: 3, y: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .stroke(Color.white.opacity(0.08), lineWidth: 0.5)
            )
    }

    private var filmIcon: some View {
        Image(systemName: "film.fill")
            .font(.system(size: 18))
            .foregroundStyle(PromptlyGold.gradient)
    }
}
