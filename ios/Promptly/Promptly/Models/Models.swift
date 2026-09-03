import Foundation
import UIKit
import SwiftUI
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

/// Multimodal boundary (§1, iOS half): an image attached to a chat message.
/// User side: `localKey` points into ThumbnailCache so the sent echo survives
/// chat reload. Assistant side: `url` is the server's short-TTL signed GRANT
/// (spec §1.2 — the key never leaves the server); an expired URL degrades to
/// a placeholder, never an error state.
struct ChatAttachmentPayload: Codable, Hashable, Identifiable {
    var kind: String = "image"
    var mime: String = "image/jpeg"
    /// Ephemeral signed GRANT — valid for one TTL window, never an identity.
    var url: String?
    /// The persistent identity: the private-prefix storage key. Re-resolve a
    /// fresh url from this on read (same discipline as rendered_video_url —
    /// a chat reopened next week must not show dead images).
    var key: String?
    var localKey: String?
    var id: String { key ?? url ?? localKey ?? kind }
}

struct ChatMessage: Identifiable {
    // `var` (not `let`) so a restored message can keep its ORIGINAL id across a
    // persist→reload round-trip. The in-flight render lifecycle (upload →
    // jobId → SSE) is keyed by this id; if reload minted a fresh UUID, an
    // in-progress dispatch could no longer find its own bubble after the user
    // switched chats and came back. Set once at construction/restore only.
    var id = UUID()
    let role: MessageRole
    var content: String
    var videoAttachment: VideoAttachment?
    var attachments: [ChatAttachmentPayload]?

    /// The text this message contributes to the model's conversation history.
    /// History is a text-only contract, so an image-only turn contributes a
    /// stable placeholder — and every history REBUILDER (chat switch, edit,
    /// regenerate) must use this same accessor, or live and reloaded
    /// histories silently diverge (an assistant reply with no user turn).
    var historyText: String {
        if !content.isEmpty { return content }
        if !(attachments ?? []).isEmpty {
            return role == .user ? "(sent an image)" : "(replied with an image)"
        }
        return ""
    }
    var jobId: String?
    var jobStatus: String?
    var jobProgress: Int?
    var stepMessage: String?
    /// Phase D ask-back: set when the job is parked at needs_input with an ask.
    /// The progress bubble renders the ask card; cleared on answer/skip.
    var ask: AskPayload?
    var renderedVideoUrl: String?       // Progressive MP4 (faststart, CDN-served)
    var hlsManifestUrl: String?         // HLS .m3u8 master — preferred when present
    var thumbnailUrl: String?
    /// §6 post package — posting-ready copy (hook / caption / rationale) shown
    /// under the finished video. Fetched once on completion; nil until then.
    var postPackage: PostPackage?
    var error: String?
    var isThinking: Bool = false
    /// 225 item 2: transient (not persisted) — true while an assistant reply is
    /// actively streaming, so the bubble can show a blinking caret at the tail.
    var isStreaming: Bool = false
    /// Transient (not persisted): set true the moment a job truly completes,
    /// just before the processing bubble is swapped for the finished video.
    /// The progress views observe this to release the bar's cap and let it
    /// sweep to 100 over ~0.7s, so the bar visibly finishes instead of
    /// vanishing mid-fill. See TrickleProgress.complete().
    var isFinishing: Bool = false
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
    /// Credits returned when this render failed. nil = no refund reported.
    /// PERSISTED, because a refund the user cannot see is indistinguishable
    /// from never having been charged — and one that vanishes on chat switch
    /// is worse, since they saw it once and then it was gone.
    var creditsRefunded: Int? = nil
    /// This render was refused for zero credits. Drives the in-thread block.
    /// Persisted so a user who backgrounds the app on the refusal still sees
    /// why their send did not run.
    var creditsExhausted: Bool = false
    /// False when the server could not read the balance — the surface then
    /// omits the number rather than stating a zero it never read.
    var creditsBalanceKnown: Bool = false
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
    /// TRANSIENT (never persisted): true once the server-side job row is
    /// KNOWN to exist (dispatch success / a reconcile decode / an SSE event).
    /// Gates the cancel button — jobId now exists during upload (pre-row),
    /// and cancelling a row that doesn't exist yet is a 404 no-op that would
    /// leave the dispatch running and the user charged after "cancelling".
    var serverRowExists: Bool = false
    /// TRANSIENT (never persisted): set once when we silently auto-retry a
    /// worker-coded UPLOAD_STALLED failure (a stalled source upload). Guarantees
    /// the auto-retry fires at most once — a second UPLOAD_STALLED surfaces the
    /// honest error + the "Upload a new video" recovery instead of looping.
    var didAutoRetryUploadStall: Bool = false
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
    /// Instrumentation (224): where the source came from ("local" | "icloud") and
    /// its duration in seconds, stamped on the job so the iCloud reliability fix
    /// is measurable (which UNS jobs were iCloud) and wait-time can be deconfounded
    /// from clip length. Nil until the pick/strategy resolves.
    var sourceType: String?
    var sourceDuration: Double?
}

// MARK: - Persisted Chat Threads
//
// A chat is a serialized conversation thread that survives app restarts
// and is synced across devices via Supabase. Each chat owns an ordered
// list of `SerializedMessage` records — the at-rest shape of ChatMessage,
// stripped of transient render state (stepMessage, stageTimeline, isThinking).
// jobProgress IS persisted (last-known bar position) so a relaunch can
// rehydrate the bar to true progress immediately; the durable poll then
// corrects it monotonically, so a slightly-stale persisted value never shows
// backward motion.

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

extension Chat {
    /// The frame for the thumbnail-first chat-list row: the MOST RECENT completed
    /// render's thumbnail (so a re-edited chat shows its latest video). Reads the
    /// persisted message fields — no network fetch. nil ⇒ no finished render yet ⇒
    /// the row shows a neutral placeholder, never a broken frame.
    var latestRenderThumbnailUrl: String? {
        messages.last(where: { $0.renderedVideoUrl?.isEmpty == false })?.thumbnailUrl
    }

    /// Whether this chat holds any finished video (drives frame vs placeholder).
    var hasCompletedRender: Bool {
        messages.contains { $0.renderedVideoUrl?.isEmpty == false }
    }
}

struct SerializedMessage: Codable, Hashable {
    var id: String
    var role: String              // "user" | "assistant" | "system"
    var content: String
    var jobId: String?
    var jobStatus: String?        // final state only ("completed" / "failed" / "needs_clarification")
    var jobProgress: Int?         // last-known bar position (30–100 display band) — persisted so a
                                  // relaunch rehydrates the bar to TRUE progress instead of 0; the
                                  // immediate durable poll then corrects it (monotonic, only rises).
    var ask: AskPayload?          // Phase D ask-back — persisted so a parked question survives
                                  // background/relaunch and re-shows from the polled row.
    var renderedVideoUrl: String?
    var hlsManifestUrl: String?
    var thumbnailUrl: String?
    var postPackage: PostPackage?        // §6 post package — persisted so it survives chat reload
    var attachmentThumbnailUrl: String?  // for re-edit / "you sent a video" rows
    var attachmentFileName: String?
    var attachments: [ChatAttachmentPayload]?   // multimodal images (optional => old rows decode fine)
    var error: String?
    var originalVibe: String?
    var isOnboarding: Bool?
    // Retry cache — persisted so a user who closes the app on a failed
    // bubble still sees the Retry button on reload. All four fields are
    // optional in storage (only failed retryable messages have them set).
    var creditsRefunded: Int?
    var creditsExhausted: Bool?
    var cachedSourceUrl: String?
    var cachedProxyUrl: String?
    var cachedVibe: String?
    var isRetryable: Bool?

    /// True for a persisted render placeholder still in flight (no video yet).
    /// Used to decide whether a cold relaunch should reopen this chat so the
    /// progress bar resumes (force-quit→relaunch acceptance).
    var isInFlightRender: Bool {
        role == "assistant" && renderedVideoUrl == nil
            && (jobStatus == "processing" || jobStatus == "queued"
                || jobStatus == "needs_input"   // parked on a Phase D question — reopen to show it
                || (jobId != nil && jobStatus == nil))
    }

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
        // In-flight assistant placeholder. Persist it so the user can navigate
        // away mid-render — OR mid-UPLOAD, before a jobId exists yet — and find
        // the progress bubble still there on return. Two recovery paths re-bind
        // it: (1) if it already has a jobId, the reloader restarts SSE +
        // reconciles vs the DB; (2) if it's still uploading (no jobId), the
        // dispatch coordinator routes the jobId back onto this message by its
        // stable id the moment the upload completes (see EditorView's outcome
        // routing). Persisting the no-jobId upload phase is what stops the
        // bubble from vanishing when you switch chats while it's uploading.
        if message.role == .assistant
            && (message.jobId != nil
                || message.jobStatus == "processing"
                || message.jobStatus == "queued") {
            return true
        }
        // Otherwise: assistant text bubbles with content but no job.
        return !message.isThinking && message.jobStatus == nil
            && (!message.content.isEmpty || !(message.attachments ?? []).isEmpty)
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
        self.jobProgress = message.jobProgress
        self.ask = message.ask
        self.renderedVideoUrl = message.renderedVideoUrl
        self.hlsManifestUrl = message.hlsManifestUrl
        self.thumbnailUrl = message.thumbnailUrl
        self.postPackage = message.postPackage
        self.attachmentThumbnailUrl = message.videoAttachment?.remoteThumbnailUrl
        self.attachmentFileName = message.videoAttachment?.fileName
        self.attachments = message.attachments
        self.error = message.error
        self.originalVibe = message.originalVibe
        self.isOnboarding = message.isOnboarding ? true : nil
        self.creditsRefunded = message.creditsRefunded
        self.creditsExhausted = message.creditsExhausted ? true : nil
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
        // Keep the original id so an in-flight dispatch/SSE keyed on it can
        // still find this bubble after a persist→reload round-trip.
        if let uuid = UUID(uuidString: id) { msg.id = uuid }
        msg.jobId = jobId
        msg.jobStatus = jobStatus
        msg.jobProgress = jobProgress
        msg.ask = ask
        msg.renderedVideoUrl = renderedVideoUrl
        msg.hlsManifestUrl = hlsManifestUrl
        msg.thumbnailUrl = thumbnailUrl
        msg.postPackage = postPackage
        msg.attachments = attachments
        msg.error = error
        msg.originalVibe = originalVibe
        msg.isOnboarding = isOnboarding ?? false
        msg.creditsRefunded = creditsRefunded
        msg.creditsExhausted = creditsExhausted ?? false
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
        // In-flight if the render hasn't produced a video yet AND it's either
        // actively processing/queued (covers the UPLOAD phase, which has no
        // jobId) or a jobId-bearing placeholder with no status yet.
        let isInFlight = renderedVideoUrl == nil
            && (jobStatus == "processing"
                || jobStatus == "queued"
                || jobStatus == "needs_input"   // Phase D: parked on a question
                || (jobId != nil && jobStatus == nil))
        if isInFlight && parsedRole == .assistant {
            if jobId == nil {
                // TERMINAL AT LOAD (stuck-jobs directive): an in-flight bubble
                // with no job id died during upload — there is no row to
                // reconcile against and never will be. The infinite
                // "Picking up where it left off..." corpse is not representable:
                // it terminalizes into the failure card right here.
                msg.jobStatus = "failed"
                msg.error = "This upload didn't finish — the connection was likely too slow for this clip. Your video is safe on your device. Try again on Wi-Fi, or trim it to a shorter highlight."
                msg.stageTimeline = nil
                msg.stepMessage = nil
            } else {
                msg.stageTimeline = StageTimeline(mode: "full")
                if jobStatus == nil { msg.jobStatus = "processing" }
                // Keep the parked question label; the poll re-shows the ask card.
                msg.stepMessage = jobStatus == "needs_input" ? "Lumen has a question" : "Picking up where it left off..."
            }
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
    let phone: String?
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

/// Shared cross-surface state. A chat's re-edit action (MessageBubble) sets
/// `pendingReedit`; EditorView consumes the session, shows the context chip, and
/// clears it once the re-edit job dispatches.
final class AppState: ObservableObject {
    static let shared = AppState()
    @Published var selectedTab: Int = 0
    @Published var pendingReedit: ReeditSession?
    /// Drives the ChatGPT-style sidebar drawer in AppShell. EditorView's
    /// hamburger button toggles this; the drawer overlay listens for the
    /// transition. Lives on AppState so any view can dismiss it without
    /// having to plumb a binding through the hierarchy.
    @Published var sidebarOpen: Bool = false
    /// Sidebar-restructure: Account is a sheet opened from the drawer; AppShell binds
    /// a `.sheet` to it. (The Library sheet was DELETED — every video lives in its
    /// own chat now.) `selectedTab` is retired to a constant 0 (Edit is the sole
    /// full-screen surface) — kept only so legacy guards still read 0.
    @Published var showAccount: Bool = false
    /// The credits top-up sheet. Raised by the header badge.
    @Published var showCredits: Bool = false
    /// The exit offer, presented from the CREDIT WALL rather than the paywall.
    /// The credit wall never constructs `UpgradePaywall` — it goes in-thread
    /// bubble -> `showCredits` -> CreditsTopUpView — so the catch that lives in
    /// UpgradePaywall cannot reach it. This is the independent trigger.
    @Published var showExitOffer: Bool = false
    /// Attribution, asked AFTER first value rather than inside the funnel.
    /// Set once, by the first completed render; `hasSeenAttributionGate` makes
    /// it once-ever regardless of how many videos follow.
    @Published var showAttribution: Bool = false
    /// Bumped by `landOnChat()` on every authenticated landing. EditorView
    /// observes it and focuses the composer — so a sign-in ALWAYS ends with the
    /// keyboard up, ready to type a vibe (build 217).
    @Published var composerFocusToken: Int = 0

    /// The explicit post-auth navigation reset (build 217, the "ALWAYS" rule):
    /// every successful sign-in lands on the chat surface with the composer
    /// focused — never on a stale Account/Library sheet the previous session left
    /// open. Dismiss all sheets, close the drawer, select the chat surface, and
    /// signal the composer to focus. No auth path may skip this.
    func landOnChat() {
        showAccount = false
        sidebarOpen = false
        selectedTab = 0
        paywallReason = nil
        exportGateContext = nil
        composerFocusToken &+= 1
    }

    /// Clears the drawer/sheet nav state on SIGN-OUT so it can't persist into the
    /// next session (the bug: sign-out left showAccount=true → re-auth re-opened
    /// the Account sheet). Paired with `landOnChat()` on sign-in.
    func clearNavForSignOut() {
        showAccount = false
        sidebarOpen = false
    }
    /// The paywall the root sheet (AppShell) is bound to — non-nil ⇒ presented.
    /// READ-ONLY to the rest of the app: trigger sites must go through
    /// `presentPaywall` / `deferPaywall` / `flushDeferredPaywall`, never set this
    /// directly. That routing is what stops a presentation dropped behind a
    /// blocking modal (a full-screen player, a mid-dismiss sheet) from leaving
    /// this stuck non-nil and muting every later trigger for the session — the
    /// RACE 1 / RACE 2 wedge. Decision core: `PaywallRouting`.
    @Published private(set) var paywallReason: PaywallReason?
    private var paywallRouting = PaywallRouting<PaywallReason>()

    /// The trial WALL (distinct from the upgrade paywall): set when an enforced
    /// `.none` account hits a gated door post-flip (APIError.wallRequired). The
    /// shell presents TrialWallView(context: .door) as a full-screen cover — a
    /// `.none` user reaches no usable screen. Inert while the wall knob is off.
    @Published var wallPresented: Bool = false
    func presentWall() { wallPresented = true }
    func dismissWall() { wallPresented = false }

    /// The blocked video's identity for an `.exportGate` paywall
    /// (exportgate_personalization). Set by `presentPaywall` when the reason is
    /// `.exportGate` (nil from call sites that don't know the video — the
    /// paywall then falls back to the generic header) and cleared on dismissal
    /// so a later paywall can never inherit a stale thumbnail.
    @Published private(set) var exportGateContext: ExportGatePaywallContext?

    /// Present the paywall now (wedge-proof). Use from a trigger with no blocking
    /// modal on screen; if a stale reason is stuck (a sheet that never actually
    /// presented), this re-drives so the request can't be silently muted.
    ///
    /// `exportContext` (`.exportGate` only): what the export surface knows about
    /// the blocked video — its thumbnail for the personalized ask, and (when the
    /// caller holds both durations) the passthrough signal the bad-render
    /// suppressor gates on. Defaulted so every existing call site is unchanged.
    func presentPaywall(_ reason: PaywallReason, exportContext: ExportGatePaywallContext? = nil) {
        if case .exportGate = reason {
            // bad_render_suppressor: a render the client can MEASURE as a
            // passthrough (see ExportGatePaywallContext.isPassthroughRender) is
            // the wrong moment to ask for money — skip the wall entirely and
            // record the suppression. Flag off, or no duration signal from the
            // caller = present exactly as today. NOTE: un-blocking the save
            // itself is the exporter/server's half — this site only owns the ask.
            // assumeIsolated is safe here: both .exportGate call sites hop to
            // the main actor first (MessageBubble's MainActor.run), and this
            // method mutates @Published state so main is already a requirement.
            let suppressorOn = MainActor.assumeIsolated {
                OnboardingState.shared.badRenderSuppressorEnabled
            }
            if suppressorOn, exportContext?.isPassthroughRender == true {
                Analytics.track("paywall_suppressed_bad_render", props: ["context": "export_gate"])
                return
            }
            exportGateContext = exportContext
        }
        trackFreeLimitHit(reason)
        paywallRouting.request(reason)
        mirrorPaywallRouting()
    }

    #if DEBUG
    /// DEBUG-only: verify the export paywall branch TODAY via the dry-run gate probe,
    /// zero flips [SERVER_CONTRACTS_226]. Probes the gate for `jobId`; if a free user
    /// would be gated it drives the SAME `.manual` paywall the post-flip export uses,
    /// so the branch is proven on a real device (run once as Pro → allowed, once as
    /// free → paywall). Returns a one-line report. DEBUG + explicit-call only → zero
    /// effect on Release/TestFlight, and it never touches the shipping export flow
    /// (a free user still saves publicly while the gate is dark).
    @MainActor
    @discardableResult
    func debugVerifyExportPaywallBranch(jobId: String) async -> String {
        let decision = await APIService.shared.gateProbe(jobId: jobId)
        let report: String
        switch decision {
        case .allowed(let tier):
            report = "gate_probe: allowed (tier=\(tier)) — Pro, no paywall ✓"
        case .gated(let tier, let reason):
            presentPaywall(.manual)   // the exact branch the post-flip 402 drives
            report = "gate_probe: gated (tier=\(tier), reason=\(reason ?? "—")) — paywall presented ✓"
        case .indeterminate(let status):
            report = "gate_probe: indeterminate (status=\(status)) — fail-open, no paywall"
        }
        print("[gate-probe] \(report)")
        return report
    }
    #endif

    /// UPGRADE-funnel head: a free user encountered a Pro-gated limit. Fired from
    /// the SINGLE routing chokepoint (present + defer) so every gated door counts
    /// once, with the specific cap in `limit`. `.manual` is intentionally excluded
    /// — it covers both genuine upgrade taps (Account) and the second-upload cap,
    /// so the real second_upload encounter is fired explicitly at its site.
    private func trackFreeLimitHit(_ reason: PaywallReason) {
        let limit: String?
        switch reason {
        case .dailyRenders: limit = "daily_cap"
        case .dailyChats:   limit = "daily_chats"
        case .reedit:       limit = "re_edit"
        case .lumen:        limit = "lumen"
        case .concurrency:  limit = "second_upload"
        case .exportGate:   limit = "export"
        case .manual:       limit = nil
        // NOT free-limit encounters. `free_limit_hit` is the head of the
        // UPGRADE funnel — a free user hitting a Pro-gated cap. These three are
        // scheduled surfaces (first run, the enforced wall, post-onboarding);
        // counting them would inflate the cap metric with views nobody was
        // blocked into. Listed explicitly rather than via `default` so the next
        // reason added has to make this same decision on purpose.
        case .firstLaunch, .trialWall, .secondPaywall: limit = nil
        }
        if let limit { Analytics.track("free_limit_hit", props: ["limit": limit]) }
    }

    /// Park a paywall behind a blocking modal (full-screen player, or a sheet
    /// that's mid-dismiss). Shows nothing yet — call `flushDeferredPaywall()`
    /// from the modal's dismissal hook to present it once the context is free.
    func deferPaywall(_ reason: PaywallReason) {
        trackFreeLimitHit(reason) // the cap was encountered now, even if shown later
        paywallRouting.park(reason)
    }

    /// Promote a parked paywall now that the blocking modal has dismissed.
    /// A no-op when nothing is parked, so it's safe to call on every close.
    ///
    /// This is called from the video player's dismissal completion (RACE 1). The
    /// player is a full-screen UIKit modal, and presenting the root SwiftUI
    /// `.sheet` immediately after it dismisses is SILENTLY DROPPED — proven by
    /// presentation (sync, one-runloop async, and a 0.35s delay all fail; only a
    /// UIKit present works). So present the parked paywall via UIKit from the
    /// topmost view controller instead of routing it through `paywallReason`.
    func flushDeferredPaywall() {
        guard let reason = paywallRouting.takeParked() else { return }
        presentPaywallFromTop(reason)
    }

    /// Present the paywall via UIKit from the topmost view controller — the only
    /// reliable way to raise it right after a full-screen UIKit modal (the player)
    /// dismisses. Every OTHER trigger presents from a SwiftUI context and uses the
    /// `.sheet` via `presentPaywall`, which works there.
    private func presentPaywallFromTop(_ reason: PaywallReason) {
        guard let top = AppState.topViewController() else {
            presentPaywall(reason) // no topmost found — fall back rather than drop
            return
        }
        weak var hostRef: UIViewController?
        let paywall = UpgradePaywall(
            isPresented: Binding(get: { true }, set: { shown in if !shown { hostRef?.dismiss(animated: true) } }),
            reason: reason
        )
        let host = UIHostingController(rootView: paywall)
        host.modalPresentationStyle = .fullScreen
        host.modalTransitionStyle = .crossDissolve
        hostRef = host
        top.present(host, animated: true)
    }

    /// The topmost presented view controller — where a modal must be presented
    /// from so it actually appears.
    static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first?.windows.first
        var vc = window?.rootViewController
        while let presented = vc?.presentedViewController { vc = presented }
        return vc
    }

    /// Call when the paywall sheet is dismissed (user closed it) so the router
    /// stays in sync and anything queued behind it is promoted.
    func dismissPaywall() {
        exportGateContext = nil
        paywallRouting.dismissed()
        mirrorPaywallRouting()
    }

    /// Mirror the pure router's decision onto the @Published binding. On a
    /// non-nil→non-nil change SwiftUI's `reason != nil` binding wouldn't
    /// re-present, so re-drive through nil across a runloop tick.
    private func mirrorPaywallRouting() {
        if paywallRouting.needsRedrive {
            paywallRouting.redriveHandled()
            let target = paywallRouting.reason
            paywallReason = nil
            DispatchQueue.main.async { [weak self] in self?.paywallReason = target }
        } else {
            paywallReason = paywallRouting.reason
        }
    }
}

/// What the export surface KNOWS about the blocked video at the moment the
/// export gate 402s — threaded into `AppState.presentPaywall(_:exportContext:)`
/// and consumed by PaywallView (the personalized `.exportGate` header) and the
/// bad-render suppressor. Every field is optional: absent data personalizes
/// nothing and suppresses nothing (the paywall renders exactly as today).
struct ExportGatePaywallContext: Equatable {
    /// `ChatMessage.thumbnailUrl` of the video whose save/share was gated.
    var thumbnailUrl: String? = nil
    /// Source-clip and delivered-render durations in seconds, when the export
    /// surface holds BOTH. Feed `isPassthroughRender`; either absent → no
    /// signal, never a guess.
    var sourceDuration: Double? = nil
    var renderDuration: Double? = nil

    /// bad_render_suppressor's ONLY honest client-side thinness signal: a
    /// render whose duration is ≈ the source's reads as a passthrough (nothing
    /// was cut). The client holds no cut/segment counts — `postPackage` is
    /// prose — so duration-vs-duration is the one measurable proxy. Requires
    /// BOTH durations; partial data never fabricates a verdict.
    static let passthroughDurationRatio = 0.97
    var isPassthroughRender: Bool {
        guard let source = sourceDuration, let render = renderDuration,
              source > 0, render > 0 else { return false }
        return render / source >= Self.passthroughDurationRatio
    }
}

/// Codable for symmetry with ReeditSession; only the case matters at
/// runtime so the picker view in PaywallView can render the right copy.
enum PaywallReason: Equatable, Hashable {
    case dailyRenders(used: Int, limit: Int)
    case dailyChats(used: Int, limit: Int)
    case reedit
    case manual
    /// User tapped the locked premium model (Lumen) in the composer picker.
    case lumen
    /// Free user tried to start a 2nd video while one is already in flight —
    /// the account-global concurrency cap (1 free / 10 pro). Server-enforced at
    /// the upload door; this drives the honest "one at a time" upgrade copy.
    case concurrency
    /// Save/Share hit the server export gate's 402 (out of free exports). Kept
    /// distinct from .manual so the context split can see the highest-intent
    /// blocked moment — a user trying to keep their own video — the day
    /// EXPORT_GATE_ENABLED arms. Inert until then (gate returns 501 → free save).
    case exportGate
    /// The first-launch wall, now a beat inside OnboardingV2Flow. A REASON
    /// rather than a separate view: the entry-specific headline and CTA are the
    /// only things that differed, and four implementations of one paywall is
    /// what let the approved design reach `manual` and not `first_launch`.
    case firstLaunch
    /// The enforced trial wall (`wall_enforcement`). Its analytics context
    /// stays "door" so the existing funnel split is unbroken.
    case trialWall
    /// The post-onboarding second paywall (legacy V1 flow).
    case secondPaywall
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

/// Single source of truth for "is this render finished?". Canonical durable
/// terminals (`completed, failed, canceled, needs_input`) + the transient re-edit
/// SSE status `needs_clarification` + the legacy `error` alias for `failed`. The
/// progress UI MUST stop on any of these — no screen may spin past a terminal
/// row — and pollers/SSE must treat them all as done. (No `complete`/`cancelled`:
/// those redundant spellings are normalized away by the canonical migration and
/// the worker v193 + app now write canonical.)
enum JobLifecycle {
    static let terminal: Set<String> = [
        "completed", "failed", "canceled", "needs_input",
        "needs_clarification", "error",
    ]
    static func isTerminal(_ status: String?) -> Bool {
        guard let s = status else { return false }
        return terminal.contains(s)
    }
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
        PipelineStage(id: "upload_local", title: String(localized: "Sending your video"),          icon: "arrow.up.circle",           authoritative: true,  parent: nil,      modes: ["full"]),
        PipelineStage(id: "analyze",      title: String(localized: "Getting your video ready"),        icon: "magnifyingglass",           authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "transcribe",   title: String(localized: "Writing down what you said"),       icon: "waveform",                  authoritative: true,  parent: nil,      modes: ["full"]),
        PipelineStage(id: "face_detect",  title: String(localized: "Watching where faces move"), icon: "face.smiling",              authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "shots",        title: String(localized: "Finding where the scenes change"),        icon: "rectangle.split.3x1",       authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "trend",        title: String(localized: "Looking at what works well"), icon: "chart.line.uptrend.xyaxis", authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "plan_diff",    title: String(localized: "Deciding what to change"),   icon: "wand.and.stars",            authoritative: true,  parent: nil,      modes: ["tweak"]),
        PipelineStage(id: "plan",         title: String(localized: "Making a plan for your video"),      icon: "pencil.and.outline",        authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "broll_search", title: String(localized: "Finding more video to add"),      icon: "film.stack",                authoritative: true,  parent: nil,      modes: ["full", "reinterpret"]),
        PipelineStage(id: "render",       title: String(localized: "Putting your video together"),           icon: "sparkles",                  authoritative: true,  parent: nil,      modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "timing",       title: String(localized: "Matching your video to the music"),       icon: "timer",                     authoritative: false, parent: "render", modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "captions",     title: String(localized: "Adding your captions"), icon: "text.bubble",               authoritative: false, parent: "render", modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "sfx",          title: String(localized: "Adding sounds"),        icon: "speaker.wave.2",            authoritative: false, parent: "render", modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "transitions",  title: String(localized: "Making it flow better"),         icon: "arrow.triangle.swap",       authoritative: false, parent: "render", modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "encode",       title: String(localized: "Saving your video"),                  icon: "film",                      authoritative: false, parent: "render", modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "thumbnail",    title: String(localized: "Choosing your cover picture"),      icon: "photo.on.rectangle",        authoritative: true,  parent: nil,      modes: ["full", "reinterpret", "tweak"]),
        PipelineStage(id: "upload",       title: String(localized: "Almost done"),          icon: "square.and.arrow.up",       authoritative: true,  parent: nil,      modes: ["full", "reinterpret", "tweak"])
    ]

    static func stages(for mode: String) -> [PipelineStage] {
        all.filter { $0.modes.contains(mode) }
    }

    static func stage(id: String) -> PipelineStage? {
        all.first { $0.id == id }
    }

    /// Index of the `plan` stage in `all` — the cancel cutoff. The cheap CPU
    /// work (download/transcribe/analyze) precedes it; the edit recipe + the
    /// expensive GPU render start at `plan`.
    static let planIndex: Int = all.firstIndex(where: { $0.id == "plan" }) ?? all.count

    /// True iff a render currently at `currentStageId` can still be cancelled:
    /// there is a known current stage and it comes BEFORE `plan`. Pure — unit
    /// tested. Terminal (completed/failed) is handled by the caller, which
    /// clears the stage when the render ends.
    static func isCancellable(currentStageId: String?) -> Bool {
        guard let id = currentStageId,
              let idx = all.firstIndex(where: { $0.id == id }) else { return false }
        return idx < planIndex
    }
}

@MainActor
final class StageTimeline: ObservableObject {
    @Published private(set) var stages: [PipelineStage]
    @Published private(set) var states: [String: StageState]
    @Published private(set) var currentStageId: String?
    @Published private(set) var currentDerivedId: String?
    @Published private(set) var isFinished: Bool = false

    /// Whether the in-progress render can still be cancelled — current stage is
    /// before the edit recipe (`plan`) and the render hasn't finished.
    var isCancellable: Bool {
        !isFinished && PipelineCatalog.isCancellable(currentStageId: currentStageId)
    }

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
