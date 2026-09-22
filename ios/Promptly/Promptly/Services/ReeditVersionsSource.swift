import Foundation

// WHERE THE VERSION DATA COMES FROM, AND WHY THE STUB CANNOT SHIP.
//
// The server contract is agreed and committed; the endpoints are not written
// yet. Rather than leave the UI idle on a signal, it is built against a stub
// that returns exactly the posted shape and flips to live when the endpoints
// land.
//
// THE STUB IS #if DEBUG ONLY. Not a flag, not a constant someone remembers to
// flip — it does not COMPILE into a Release build. A stub that ships is a
// screen showing invented versions of a user's video, and "we'll remember to
// turn it off" is the same promise that leaves a feature dark for thirteen days
// or a table measured and unread. Making it impossible costs one #if.
//
// So in Release there is exactly one implementation and it is the live one.

protocol ReeditVersionsProviding {
    func versions(forJobId jobId: String) async throws -> ReeditVersionsResponse
}

/// The real thing. In Release this is the ONLY conformer that exists.
struct LiveReeditVersions: ReeditVersionsProviding {
    func versions(forJobId jobId: String) async throws -> ReeditVersionsResponse {
        try await APIService.shared.jobVersions(jobId: jobId)
    }
}

enum ReeditVersionsSource {
    /// The single place the UI resolves its provider.
    static var current: ReeditVersionsProviding {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-reeditStub") { return StubReeditVersions() }
        #endif
        return LiveReeditVersions()
    }
}

#if DEBUG
/// Returns the POSTED SHAPE verbatim — ascending, latest last, completed rows
/// only, so `versions.count == version_count` holds exactly as the server
/// guarantees. Deliberately includes a change_request on the later versions and
/// none on v1, because v1 is the original upload and has no change request; a
/// stub that gives every row the same fields hides the empty-state.
struct StubReeditVersions: ReeditVersionsProviding {
    func versions(forJobId jobId: String) async throws -> ReeditVersionsResponse {
        try? await Task.sleep(for: .milliseconds(350))   // a real call is not instant
        let root = "00000000-0000-0000-0000-0000000000aa"
        func v(_ n: Int, _ req: String?) -> ReeditVersion {
            ReeditVersion(
                job_id: String(format: "00000000-0000-0000-0000-0000000000%02d", n),
                version: n,
                status: "completed",
                created_at: ISO8601DateFormatter().string(from: Date().addingTimeInterval(Double(-3600 * (4 - n)))),
                change_request: req,
                rendered_video_url: "https://cdn.usepromptly.app/demo.mp4",
                thumbnail_url: nil
            )
        }
        return ReeditVersionsResponse(
            root_job_id: root,
            version_count: 3,
            versions: [v(1, nil), v(2, "make the intro punchier"), v(3, "cut the pause at 0:04")]
        )
    }
}
#endif
