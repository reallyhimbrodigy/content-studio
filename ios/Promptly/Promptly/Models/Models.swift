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
}

enum MessageRole {
    case user, assistant, system
}

struct VideoAttachment {
    let localUrl: URL
    let fileName: String
    var thumbnail: UIImage?
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
