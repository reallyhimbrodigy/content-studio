import Foundation

/// The API error surface, kept in its own file (Foundation-only, no app deps) so
/// pure consumers like ExportRouting — and their standalone unit tests — can
/// compile against it without dragging in APIService's networking stack.
enum APIError: LocalizedError {
    case notAuthenticated
    case jobCreationFailed(String)
    case uploadFailed
    case deleteFailed
    /// Server returned 404 on the export endpoint — the job's private clean-export
    /// key is NULL (an old render made before the private pipeline). This is the
    /// EXPLICIT fallback case: the caller reverts to saving the public asset.
    /// It is deliberately DISTINCT from paymentRequired so a 402 can never be
    /// mistaken for "fall back" — a 402 that fell back would defeat the paywall.
    case exportNotAvailable
    /// Server returned 402 — daily quota hit or a Pro-only feature was
    /// called by a free user. `kind` is "render", "chat", or "reedit" so
    /// the caller can present the right paywall reason.
    case paymentRequired(kind: String, limit: Int?, message: String)
    /// Server returned 403 `wall_required` — an enforced `.none` account hit a
    /// gated door (post-flip; inert while the wall knob is off). The client
    /// routes to the trial wall (TrialWallView, context .door), never a usable
    /// screen. `message` is old-client-safe display text for the rare straggler.
    case wallRequired(message: String)
    /// Render dispatch returned a structured failure shape: error_code +
    /// user_message + the three behavioural flags (retryable,
    /// requires_new_video, requires_vibe_change). Callers branch on the
    /// flags to decide which failure screen to show. Carries the
    /// underlying error_code string so analytics can group failures.
    case structuredFailure(
        errorCode: String?,
        userMessage: String,
        retryable: Bool,
        requiresNewVideo: Bool,
        requiresVibeChange: Bool
    )
    /// Layer 2 of pick-validate-upload flow: Modal /validate said the
    /// sample isn't a talking-head video. userMessage is the backend's
    /// human-readable reason; faceRatio + confidence are debug info.
    case validationRejected(userMessage: String, faceRatio: Double?, confidence: Double?)

    var errorDescription: String? {
        switch self {
        case .notAuthenticated: return "Please sign in"
        case .jobCreationFailed(let msg): return msg
        case .uploadFailed: return "Upload failed"
        case .deleteFailed: return "Delete failed"
        case .paymentRequired(_, _, let msg): return msg
        case .wallRequired(let message): return message
        case .structuredFailure(_, let userMessage, _, _, _): return userMessage
        case .validationRejected(let userMessage, _, _): return userMessage
        case .exportNotAvailable: return "This video can't be exported yet"
        }
    }
}
