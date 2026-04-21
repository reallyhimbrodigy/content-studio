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
    var renderedVideoUrl: String?
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
    var fileName: String = "video.mp4"
    var uploadTask: Task<Void, Never>?
}

struct VideoJob: Identifiable, Codable {
    let id: String
    let status: String
    let vibe_input: String?
    let rendered_video_url: String?
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
    static let all: [PipelineStage] = [
        PipelineStage(id: "download",     title: "Loading your footage",          icon: "arrow.down.circle",         authoritative: true,  parent: nil,      modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "transcribe",   title: "Transcribing every word",       icon: "waveform",                  authoritative: true,  parent: nil,      modes: ["full"]),
        PipelineStage(id: "face_detect",  title: "Tracking faces frame-by-frame", icon: "face.smiling",              authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "beats",        title: "Detecting beat and rhythm",     icon: "metronome",                 authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "trend",        title: "Matching viral style patterns", icon: "chart.line.uptrend.xyaxis", authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "plan_diff",    title: "Figuring out what to change",   icon: "wand.and.stars",            authoritative: true,  parent: nil,      modes: ["tweak"]),
        PipelineStage(id: "plan",         title: "Writing your edit recipe",      icon: "pencil.and.outline",        authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "hook",         title: "Finding the perfect hook",      icon: "bolt.circle",               authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "broll_search", title: "Sourcing B-roll cutaways",      icon: "film.stack",                authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "render",       title: "Rendering your edit",           icon: "sparkles",                  authoritative: true,  parent: nil,      modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "timing",       title: "Timing cuts to the beat",       icon: "timer",                     authoritative: false, parent: "render", modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "color",        title: "Applying your color grade",     icon: "paintpalette",              authoritative: false, parent: "render", modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "speed",        title: "Composing speed ramps",         icon: "speedometer",               authoritative: false, parent: "render", modes: ["full", "reinterpret", "tweak"]),
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

    init(mode: String) {
        let filtered = PipelineCatalog.stages(for: mode)
        self.stages = filtered
        self.states = Dictionary(uniqueKeysWithValues: filtered.map { ($0.id, StageState.upcoming) })
    }

    /// Called when the worker emits an authoritative `step` token. Infers skips
    /// and completions from the ordering in the filtered catalog.
    func receive(stepToken token: String) {
        guard !isFinished else { return }
        guard let idx = stages.firstIndex(where: { $0.id == token }) else {
            // Unknown token for this mode — ignore. Could happen if worker adds a new
            // stage that the client catalog doesn't know about. Forward compat: we
            // don't crash, we just don't track it visually.
            return
        }
        let stage = stages[idx]

        // Walk earlier stages: upcoming → skipped, in_progress → completed.
        for i in 0..<idx {
            let prev = stages[i]
            switch states[prev.id] ?? .upcoming {
            case .upcoming:    states[prev.id] = .skipped
            case .inProgress:  states[prev.id] = .completed
            default:           break
            }
        }

        // Start this one (if not already past)
        if states[stage.id] == .upcoming || states[stage.id] == nil {
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
    /// Closes out the timeline: any in_progress → completed; upcoming → skipped.
    func finish() {
        derivedTask?.cancel()
        derivedTask = nil
        for stage in stages {
            switch states[stage.id] ?? .upcoming {
            case .inProgress: states[stage.id] = .completed
            case .upcoming:   states[stage.id] = .skipped
            default: break
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
