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
    @Published var uploadedUrl: String?
    @Published var uploadProgress: Double = 0
    @Published var isLoading = true
    /// Set true when the upload Task throws. The pending tile shows a
    /// red error overlay; otherwise the tile is clean — upload progress
    /// is no longer surfaced on the tile (matches iMessage / WhatsApp
    /// behavior where attachments don't show transfer state).
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

    /// Decide whether a live ChatMessage is worth persisting at all.
    /// Mid-render assistant placeholders ("processing", isThinking, no
    /// renderedVideoUrl yet) are dropped — they'd look broken on reload
    /// because the SSE stream that drives them is gone.
    static func shouldPersist(_ message: ChatMessage) -> Bool {
        if message.role == .user { return true }
        // Assistant rows: only keep if there's something concrete to show
        // (final job state, rendered video, or surfaced error). Drop
        // in-flight placeholders.
        if let status = message.jobStatus, ["completed", "failed", "needs_clarification"].contains(status) {
            return true
        }
        if message.renderedVideoUrl != nil || message.error != nil {
            return true
        }
        // Everything else (isThinking, processing without final state) — drop.
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
        currentStageId = stage.id
        startDerivedNarration(parentId: stage.id)
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
