import Foundation
import UIKit
import UniformTypeIdentifiers
import CoreTransferable

struct MovieFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let tempDir = FileManager.default.temporaryDirectory
            let copy = tempDir.appendingPathComponent(UUID().uuidString + ".mp4")
            if FileManager.default.fileExists(atPath: copy.path) {
                try FileManager.default.removeItem(at: copy)
            }
            try FileManager.default.copyItem(at: received.file, to: copy)
            return Self(url: copy)
        }
    }
}

struct ChatMessage: Identifiable {
    let id = UUID()
    let role: MessageRole
    var content: String
    var videoAttachment: VideoAttachment?
    var jobId: String?
    var jobStatus: String?
    var jobProgress: Int?
    var stepMessage: String?
    var renderedVideoUrl: String?       // Progressive MP4 (faststart, CDN-served)
    var hlsManifestUrl: String?         // HLS .m3u8 master — preferred when present
    var thumbnailUrl: String?
    var error: String?
    var isThinking: Bool = false
    var stageTimeline: StageTimeline?  // Pipeline stage narrative (reference type so mutations propagate)
    var originalVibe: String?          // For in-chat Re-edit: the vibe that produced this video
    /// True for the auto-generated welcome message injected into empty
    /// chats. We persist it so the chat shows the same friendly intro
    /// on every reload, but we EXCLUDE it from `conversationHistory`
    /// passed to the chat API so it doesn't burn context tokens or bias
    /// the AI's tone.
    var isOnboarding: Bool = false

    // MARK: - Retry cache (structured-failure recovery)
    //
    // When a render fails with the backend's structured envelope and
    // retryable: true, we stash the public S3 URLs + vibe text here
    // so the user can one-tap Retry without re-uploading or re-typing.
    // The spec calls this out explicitly: "cache the source video URL
    // and vibe text in the failure state. Don't re-upload, don't re-
    // type." Survives chat reload via SerializedMessage so a user who
    // closes the app and comes back later still sees the Retry path.
    /// Public S3 URL of the source video the failed dispatch was using.
    var cachedSourceUrl: String? = nil
    /// Public S3 URL of the matching Gemini proxy (may be nil if the
    /// proxy upload failed or this was a .stream / single-PUT path).
    var cachedProxyUrl: String? = nil
    /// The vibe text the user typed before the failed dispatch.
    var cachedVibe: String? = nil
    /// True iff the backend's structured failure said retryable: true.
    /// Drives visibility of the Retry button — non-retryable failures
    /// still show user_message but no retry affordance (the spec wants
    /// requires_new_video / requires_vibe_change to push the user
    /// toward a fresh start instead).
    var isRetryable: Bool = false
}

enum MessageRole {
    case user, assistant, system
}

struct VideoAttachment {
    let localUrl: URL
    let fileName: String
    var thumbnail: UIImage?
    // Remote thumbnail for re-edit flows where we don't have a local UIImage —
    // MessageBubble falls back to this AsyncImage URL when `thumbnail` is nil.
    var remoteThumbnailUrl: String?
}

class PendingVideo: Identifiable, ObservableObject {
    let id = UUID()
    @Published var thumbnail: UIImage?
    @Published var fileUrl: URL?
    /// Public S3 URL of the high-res source upload (background URLSession,
    /// 60-120s on cellular). Used for the actual render. Set the moment
    /// we know the eventual URL — the upload may still be in flight.
    @Published var uploadedUrl: String?
    /// True only after the source PUT to S3 returns successfully — i.e.
    /// the bytes are actually in the bucket. The dispatch loop in send()
    /// must wait for THIS, not for `uploadedUrl`, before creating the
    /// render job. `uploadedUrl` is set the moment we know the future
    /// URL (so the prewarm + UI know what's coming), but the worker on
    /// the other end will 404 + time out after 180s if it polls before
    /// the bytes land. Production failure: a 26s clip on slow cellular
    /// took > 180s to upload, worker timed out, job was lost.
    @Published var sourceUploadCompleted: Bool = false
    /// True once the proxy upload Task has reached a terminal state —
    /// either succeeded (in which case proxyUploadedUrl is also set)
    /// or definitively failed/skipped (in which case proxyUploadedUrl
    /// is nil and the dispatcher omits proxy_video_url, falling the
    /// worker back to its on-server encode). The dispatcher must wait
    /// for this flag in addition to `sourceUploadCompleted` so a fast
    /// source upload doesn't race ahead of a slow proxy upload — the
    /// spec requires the proxy to be in S3 before the worker tries to
    /// fetch it, OR the field must be omitted entirely. Either is OK;
    /// the in-between (URL passed but bytes not landed yet) wastes 30s
    /// of worker time on the 404 fallback.
    @Published var proxyUploadFinished: Bool = false
    /// Public S3 URL of the low-res proxy upload (foreground URLSession,
    /// 5-10s). Used for cloud AI analysis (Gemini, transcript). When this
    /// is set, the user can tap Send even though the source upload is
    /// still going — the worker polls for the source while AI analyzes
    /// the proxy in parallel.
    @Published var proxyUploadedUrl: String?
    /// 0…1, source upload progress (background, slow).
    @Published var uploadProgress: Double = 0
    /// 0…1, proxy upload progress (foreground, fast).
    @Published var proxyUploadProgress: Double = 0
    @Published var isLoading = true
    /// Set true when the upload Task throws. The pending tile shows a
    /// red error overlay; otherwise the tile is clean.
    @Published var uploadFailed = false
    var fileName: String = "video.mp4"
    var uploadTask: Task<Void, Never>?
}

// MARK: - Persisted Chat Threads
//
// A chat is a serialized conversation thread that survives app restarts
// and is synced across devices via Supabase. Each chat owns an ordered
// list of `SerializedMessage` records — the at-rest shape of ChatMessage,
// stripped of transient render state (jobProgress, stepMessage,
// stageTimeline, isThinking) so we never persist mid-flight progress
// values that would look stale on reload.

struct Chat: Codable, Identifiable, Hashable {
    let id: String
    var title: String
    var messages: [SerializedMessage]
    var createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case title
        case messages
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct SerializedMessage: Codable, Hashable {
    var id: String
    var role: String              // "user" | "assistant" | "system"
    var content: String
    var jobId: String?
    var jobStatus: String?        // final state only ("completed" / "failed" / "needs_clarification")
    var renderedVideoUrl: String?
    var hlsManifestUrl: String?
    var thumbnailUrl: String?
    var attachmentThumbnailUrl: String?  // for re-edit / "you sent a video" rows
    var attachmentFileName: String?
    var error: String?
    var originalVibe: String?
    var isOnboarding: Bool?
    // Retry cache — persisted so a user who closes the app on a failed
    // bubble still sees the Retry button on reload. All four fields are
    // optional in storage (only failed retryable messages have them set).
    var cachedSourceUrl: String?
    var cachedProxyUrl: String?
    var cachedVibe: String?
    var isRetryable: Bool?

    /// Decide whether a live ChatMessage is worth persisting at all.
    /// Includes mid-render placeholders that have a jobId — those re-bind
    /// to the live SSE stream on reload via EditorView's resumeSSEForInFlight
    /// + reconcile, so the user doesn't lose the progress bar when they
    /// leave and come back to a chat with an active render.
    static func shouldPersist(_ message: ChatMessage) -> Bool {
        if message.role == .user { return true }
        // Final assistant states — always persist.
        if let status = message.jobStatus, ["completed", "failed", "needs_clarification"].contains(status) {
            return true
        }
        if message.renderedVideoUrl != nil || message.error != nil {
            return true
        }
        // In-flight assistant placeholder with a real jobId. Persist it
        // so the user can navigate away mid-render and find the progress
        // bubble still there on return. The chat reloader restarts SSE
        // and runs reconcile against the DB so the bar isn't stale.
        if message.jobId != nil && message.role == .assistant {
            return true
        }
        // Otherwise: assistant text bubbles with content but no job.
        return !message.isThinking && message.jobStatus == nil && !message.content.isEmpty
    }

    @MainActor
    init(from message: ChatMessage) {
        self.id = message.id.uuidString
        switch message.role {
        case .user: self.role = "user"
        case .assistant: self.role = "assistant"
        case .system: self.role = "system"
        }
        self.content = message.content
        self.jobId = message.jobId
        self.jobStatus = message.jobStatus
        self.renderedVideoUrl = message.renderedVideoUrl
        self.hlsManifestUrl = message.hlsManifestUrl
        self.thumbnailUrl = message.thumbnailUrl
        self.attachmentThumbnailUrl = message.videoAttachment?.remoteThumbnailUrl
        self.attachmentFileName = message.videoAttachment?.fileName
        self.error = message.error
        self.originalVibe = message.originalVibe
        self.isOnboarding = message.isOnboarding ? true : nil
        self.cachedSourceUrl = message.cachedSourceUrl
        self.cachedProxyUrl = message.cachedProxyUrl
        self.cachedVibe = message.cachedVibe
        self.isRetryable = message.isRetryable ? true : nil

        // Persist the local UIImage to disk so chat reload can restore
        // the user-side video tile. UIImage doesn't survive JSON
        // serialization, so without this the bubble re-renders empty.
        if message.role == .user, let thumb = message.videoAttachment?.thumbnail {
            ThumbnailCache.shared.save(thumb, for: message.id.uuidString)
        }
    }

    @MainActor
    func toChatMessage() -> ChatMessage {
        let parsedRole: MessageRole = {
            switch role {
            case "user": return .user
            case "system": return .system
            default: return .assistant
            }
        }()
        var msg = ChatMessage(role: parsedRole, content: content)
        msg.jobId = jobId
        msg.jobStatus = jobStatus
        msg.renderedVideoUrl = renderedVideoUrl
        msg.hlsManifestUrl = hlsManifestUrl
        msg.thumbnailUrl = thumbnailUrl
        msg.error = error
        msg.originalVibe = originalVibe
        msg.isOnboarding = isOnboarding ?? false
        msg.cachedSourceUrl = cachedSourceUrl
        msg.cachedProxyUrl = cachedProxyUrl
        msg.cachedVibe = cachedVibe
        msg.isRetryable = isRetryable ?? false
        // Restore an in-flight stage timeline so the bubble shows a
        // progress UI immediately on chat reload (instead of looking
        // like the assistant ghosted the user). The actual stage state
        // re-syncs as soon as SSE reconnects or the reconciler runs.
        // We default to the "full" pipeline catalog — re-edit timelines
        // share the same stage IDs, so the first real `step` token
        // re-anchors the right one regardless.
        let isInFlight = jobId != nil
            && (jobStatus == "processing" || jobStatus == "queued" || jobStatus == nil)
            && renderedVideoUrl == nil
        if isInFlight && parsedRole == .assistant {
            msg.stageTimeline = StageTimeline(mode: "full")
            if jobStatus == nil { msg.jobStatus = "processing" }
            msg.stepMessage = "Picking up where it left off..."
        }
        if attachmentThumbnailUrl != nil || attachmentFileName != nil {
            // Restore the local UIImage from disk if we cached it during
            // the original send. id is the SerializedMessage.id which
            // matches the original ChatMessage.id.uuidString.
            let restoredThumb = ThumbnailCache.shared.load(for: id)
            msg.videoAttachment = VideoAttachment(
                localUrl: URL(fileURLWithPath: ""),
                fileName: attachmentFileName ?? "",
                thumbnail: restoredThumb,
                remoteThumbnailUrl: attachmentThumbnailUrl
            )
        }
        return msg
    }
}

extension Chat {
    /// Pull a one-line title out of the first user message. Mirrors
    /// ChatGPT's auto-titling: trim, take the leading content, cap at
    /// ~40 chars without breaking mid-word.
    static func deriveTitle(from messages: [SerializedMessage]) -> String {
        guard let first = messages.first(where: { $0.role == "user" && !$0.content.isEmpty }) else {
            return "New Chat"
        }
        let raw = first.content.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.count <= 42 { return raw.isEmpty ? "New Chat" : raw }
        let cap = raw.prefix(42)
        if let lastSpace = cap.lastIndex(of: " ") {
            return String(raw[..<lastSpace]) + "…"
        }
        return String(cap) + "…"
    }

    /// One-line preview of the chat for the sidebar row's secondary text.
    /// Walks backwards from the latest message and surfaces the first
    /// non-empty content. Skips title-redundant content (the first user
    /// message is already the title).
    var preview: String {
        let title = self.title.trimmingCharacters(in: .whitespacesAndNewlines)
        for msg in messages.reversed() {
            let content = msg.content.trimmingCharacters(in: .whitespacesAndNewlines)
            if content.isEmpty { continue }
            if content == title && messages.count == 1 { continue }
            return content
        }
        return ""
    }
}

struct VideoJob: Identifiable, Codable {
    let id: String
    let status: String
    let vibe_input: String?
    let rendered_video_url: String?
    let hls_manifest_url: String?
    let thumbnail_url: String?
    let created_at: String?
    let error_message: String?
}

struct AuthResponse: Codable {
    let access_token: String
    let user: AuthUser
}

struct AuthUser: Codable {
    let id: String
    let email: String?
    let user_metadata: UserMetadata?
}

struct UserMetadata: Codable {
    let full_name: String?
    let avatar_url: String?
}

struct SupabaseSession: Codable {
    let access_token: String
    let refresh_token: String
    let user: AuthUser
}

struct JobCreateResponse: Codable {
    let success: Bool?
    let job_id: String?
    let jobId: String?
    let error: String?

    var resolvedJobId: String? { job_id ?? jobId }
}

struct ReeditSession: Identifiable, Equatable {
    let id = UUID()
    let originalJobId: String
    let oldVibe: String
    let thumbnailUrl: String?
}

/// Shared cross-tab state. Library sets `pendingReedit` + switches `selectedTab`
/// to 0; EditorView consumes the session, shows the context chip, and clears it
/// once the re-edit job dispatches.
final class AppState: ObservableObject {
    static let shared = AppState()
    @Published var selectedTab: Int = 0
    @Published var pendingReedit: ReeditSession?
    /// Drives the ChatGPT-style sidebar drawer in AppShell. EditorView's
    /// hamburger button toggles this; the drawer overlay listens for the
    /// transition. Lives on AppState so any view can dismiss it without
    /// having to plumb a binding through the hierarchy.
    @Published var sidebarOpen: Bool = false
    /// Request a paywall sheet from anywhere in the view tree. The root
    /// (AppShell) presents PaywallView when this becomes non-nil and
    /// clears it on dismiss. Setting from a leaf view (re-edit tap,
    /// usage badge, server 402 handler) is what triggers the flow —
    /// no binding plumbing required.
    @Published var paywallReason: PaywallReason?
}

/// Codable for symmetry with ReeditSession; only the case matters at
/// runtime so the picker view in PaywallView can render the right copy.
enum PaywallReason: Equatable, Hashable {
    case dailyRenders(used: Int, limit: Int)
    case dailyChats(used: Int, limit: Int)
    case reedit
    case manual
}

// MARK: - Pipeline stages (render progress narrative)
//
// Mirrors shared/pipeline-stages.json from content-studio. Each stage has a
// title, an SF Symbol, an `authoritative` flag (true = worker emits this
// token via send_progress; false = client narrates it during the parent's
// in_progress window), and a modes filter.
//
// Stage inference rules (in StageTimeline.receive):
//   Upcoming → Skipped     when a LATER stage starts without this one firing
//   In progress → Completed when the NEXT stage starts
//   Upcoming (at finish) → Skipped
// No explicit "skip" event needed from the server — skips are inferred.

struct PipelineStage: Identifiable, Hashable {
    let id: String
    let title: String
    let icon: String          // SF Symbol name
    let authoritative: Bool   // true = server emits this token
    let parent: String?       // parent stage id for derived children
    let modes: [String]       // modes where this stage is expected
}

enum StageState: String {
    case upcoming, inProgress, completed, skipped
}

enum PipelineCatalog {
    // Baked-in snapshot of shared/pipeline-stages.json — keep in sync.
    //
    // `download` is intentionally absent from this client-side catalog even
    // though the worker still emits it — the step is either sub-second
    // (boto3[crt] + same-region) or a no-op (prewarm Volume cache hit), and
    // showing "Loading your footage" for 0-1s looks like a regression vs.
    // the production apps Promptly competes with. StageTimeline.receive()
    // gracefully ignores unknown tokens, so worker-emitted `download` events
    // fall on the floor without side effects. First stage the user ever sees
    // is whatever lands after download — transcribe, face_detect, or (for
    // prewarm-cached jobs) straight to plan.
    // Order matches the server's actual emission order so that as each
    // token arrives over SSE, the stage that comes alive in the UI is
    // genuinely the next one. Stages the server doesn't currently emit
    // (`beats`, `hook` from a previous pipeline design) have been
    // removed — they were the "not needed" tags polluting the expanded
    // view, since they'd flip to skipped the moment any later token
    // arrived.
    static let all: [PipelineStage] = [
        PipelineStage(id: "upload_local", title: "Uploading your video",          icon: "arrow.up.circle",           authoritative: true,  parent: nil,      modes: ["full"]),
        PipelineStage(id: "analyze",      title: "Preparing your footage",        icon: "magnifyingglass",           authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "transcribe",   title: "Transcribing every word",       icon: "waveform",                  authoritative: true,  parent: nil,      modes: ["full"]),
        PipelineStage(id: "face_detect",  title: "Tracking faces frame-by-frame", icon: "face.smiling",              authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "shots",        title: "Detecting shot changes",        icon: "rectangle.split.3x1",       authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "trend",        title: "Matching viral style patterns", icon: "chart.line.uptrend.xyaxis", authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "plan_diff",    title: "Figuring out what to change",   icon: "wand.and.stars",            authoritative: true,  parent: nil,      modes: ["tweak"]),
        PipelineStage(id: "plan",         title: "Writing your edit recipe",      icon: "pencil.and.outline",        authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "broll_search", title: "Sourcing B-roll cutaways",      icon: "film.stack",                authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "render",       title: "Rendering your edit",           icon: "sparkles",                  authoritative: true,  parent: nil,      modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "timing",       title: "Timing cuts to the beat",       icon: "timer",                     authoritative: false, parent: "render", modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "captions",     title: "Placing captions word-by-word", icon: "text.bubble",               authoritative: false, parent: "render", modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "sfx",          title: "Layering sound effects",        icon: "speaker.wave.2",            authoritative: false, parent: "render", modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "transitions",  title: "Stitching transitions",         icon: "arrow.triangle.swap",       authoritative: false, parent: "render", modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "encode",       title: "Final encode",                  icon: "film",                      authoritative: false, parent: "render", modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "thumbnail",    title: "Picking your cover frame",      icon: "photo.on.rectangle",        authoritative: true,  parent: nil,      modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "upload",       title: "Publishing to your library",    icon: "square.and.arrow.up",       authoritative: true,  parent: nil,      modes: ["full", "reinterpret", "tweak"])
    ]

    static func stages(for mode: String) -> [PipelineStage] {
        all.filter { $0.modes.contains(mode) }
    }

    static func stage(id: String) -> PipelineStage? {
        all.first { $0.id == id }
    }
}

@MainActor
final class StageTimeline: ObservableObject {
    @Published private(set) var stages: [PipelineStage]
    @Published private(set) var states: [String: StageState]
    @Published private(set) var currentStageId: String?
    @Published private(set) var currentDerivedId: String?
    @Published private(set) var isFinished: Bool = false

    private var derivedTask: Task<Void, Never>?

    init(mode: String, startWith: String? = nil) {
        let filtered = PipelineCatalog.stages(for: mode)
        self.stages = filtered
        self.states = Dictionary(uniqueKeysWithValues: filtered.map { ($0.id, StageState.upcoming) })
        if let startWith, filtered.contains(where: { $0.id == startWith }) {
            self.states[startWith] = .inProgress
            self.currentStageId = startWith
        }
    }

    /// Called when the worker emits an authoritative `step` token. Earlier
    /// stages get marked completed (not skipped) so out-of-order arrivals
    /// don't paint them as "not needed" — the server runs every catalog
    /// stage on the success path, so the user shouldn't see anything
    /// labeled skipped during a successful render.
    func receive(stepToken token: String) {
        guard !isFinished else { return }
        guard let idx = stages.firstIndex(where: { $0.id == token }) else {
            // Unknown token for this mode — ignore. Could happen if worker adds a new
            // stage that the client catalog doesn't know about. Forward compat: we
            // don't crash, we just don't track it visually.
            return
        }
        let stage = stages[idx]

        // Walk earlier stages: anything not already completed → completed.
        // Includes `.skipped` so a stage that was wrongly auto-skipped by
        // a previous out-of-order token gets corrected when its own token
        // finally arrives. Upcoming → completed (not skipped) because the
        // server's success path runs every stage in the catalog; missing
        // a token usually means SSE delivered events out of order, not
        // that the stage was actually skipped.
        for i in 0..<idx {
            let prev = stages[i]
            let cur = states[prev.id] ?? .upcoming
            if cur != .completed {
                states[prev.id] = .completed
            }
        }

        // Start this one (unless we've already moved past it).
        let curState = states[stage.id] ?? .upcoming
        if curState != .completed {
            states[stage.id] = .inProgress
        }
        // Only kick off the derived narration when this is a brand-new
        // current stage. The worker re-emits the same `render` token on
        // every progress tick during the render phase; without this
        // guard, each tick CANCELS the in-flight derived task and
        // restarts the cycle from index 0 ("timing"). On a long render
        // (~30s) the user sees the substage label flip back and forth
        // between "Timing cuts to the beat" and "Placing captions
        // word-by-word" 20+ times — looks completely broken. Restarting
        // only on stage CHANGE makes the cycle play through cleanly,
        // matching the actual pipeline flow.
        let isNewStage = currentStageId != stage.id
        currentStageId = stage.id
        if isNewStage {
            startDerivedNarration(parentId: stage.id)
        }
    }

    /// Client-side narration through derived children of an authoritative
    /// stage during its in_progress window (e.g. render's timing/color/speed
    /// /captions cycling). Dwell time is 3.2s/child; on parent completion the
    /// next receive() marks them all completed in one sweep.
    private func startDerivedNarration(parentId: String) {
        derivedTask?.cancel()
        let children = stages.filter { $0.parent == parentId && !$0.authoritative }
        guard !children.isEmpty else {
            currentDerivedId = nil
            return
        }

        derivedTask = Task { @MainActor [weak self] in
            guard let self else { return }
            for (i, child) in children.enumerated() {
                if Task.isCancelled { break }
                if i > 0 {
                    let prev = children[i - 1]
                    if self.states[prev.id] == .inProgress {
                        self.states[prev.id] = .completed
                    }
                }
                self.states[child.id] = .inProgress
                self.currentDerivedId = child.id
                let dwellNanos: UInt64 = i == children.count - 1 ? 8_000_000_000 : 3_200_000_000
                try? await Task.sleep(nanoseconds: dwellNanos)
            }
        }
    }

    /// Called on final SSE event (completed / failed / needs_clarification).
    /// On a successful render, every catalog stage genuinely ran on the
    /// server — close all of them out as completed even if the SSE feed
    /// dropped some intermediate tokens. The "skipped" state is reserved
    /// for failure paths that explicitly mark stages skipped, not for
    /// gaps in the SSE stream.
    func finish() {
        derivedTask?.cancel()
        derivedTask = nil
        for stage in stages {
            let cur = states[stage.id] ?? .upcoming
            if cur != .completed && cur != .skipped {
                states[stage.id] = .completed
            }
        }
        currentDerivedId = nil
        isFinished = true
    }

    deinit {
        derivedTask?.cancel()
    }
}

struct ChatResponse: Codable {
    let reply: String?
    let error: String?
}

struct UploadUrlResponse: Codable {
    let uploadUrl: String?
    let publicUrl: String?
    let key: String?
    let error: String?
}

struct UploadResponse: Codable {
    let videoUrl: String?
    let fileName: String?
    let error: String?
}

struct UserProfile: Codable {
    let tier: String?
}
