import Foundation

// RE-EDIT VERSIONS — the wire shape, and the invariants that come with it.
//
// A video's history is a FLAT LIST under a root, not a tree. Re-edits branch in
// the data (parent_job_id records provenance, and 114 real re-edits already
// include chains four deep and parents with four children), but the user sees
// creation order under the root: v1, v2, v3, latest last. That is why the
// ordinal is root-anchored and NOT depth — two siblings at the same depth would
// otherwise both be "version 2", and there are already parents with four of them.
//
// ORDINALS ARE COMPUTED, NOT STORED, and they count COMPLETED rows only. A
// persisted integer cannot be both stable and gapless: number every attempt and
// a failure burns v3 forever; number only successes and a failure renumbers what
// the user opened yesterday. Computed over completed rows, ordered created_at
// with id as tie-break, it is both — and the tie-break is load-bearing, because
// two rows have already been written in the same millisecond in production.
//
// A FAILED JOB IS NOT A VERSION. It produced nothing to open. It belongs in the
// job's chat as a failed attempt and never in the switcher, which is why
// `version` is null for it and why version_count counts completions.

/// One entry in a video's version list. Completed rows only.
struct ReeditVersion: Decodable, Identifiable, Equatable {
    let job_id: String
    let version: Int
    let status: String
    let created_at: String
    let change_request: String?
    /// Signed on read by the server, never stored signed. Do not cache these —
    /// caching the signature is what re-creates history rot at a shorter
    /// interval. Cache the job_id and ask again.
    let rendered_video_url: String?
    let thumbnail_url: String?

    var id: String { job_id }
}

/// GET /api/video-jobs/:id/versions — accepts ANY job in the tree, not just the root.
struct ReeditVersionsResponse: Decodable, Equatable {
    let root_job_id: String
    let version_count: Int
    let versions: [ReeditVersion]

    /// The server states this as a guarantee: `versions.length === version_count`
    /// always, because both count completed rows. If they ever disagree it is a
    /// server bug and worth shouting about rather than papering over — a
    /// switcher that silently renders fewer entries than it claims is the kind
    /// of wrong that looks like a UI glitch and is not.
    var isConsistent: Bool { versions.count == version_count }

    /// Latest LAST, matching the wire order. The default selection is the last
    /// element, not the first.
    var latest: ReeditVersion? { versions.last }
}

/// WHAT A /versions OUTCOME MEANS FOR THE SHEET (ruled 2026-09-22).
///
/// THE STRIP IS AN ENHANCEMENT, NEVER A PRECONDITION. The re-edit sheet's job is
/// the composer: the pill, the Pro wall, reedit_tap and a POST that has existed
/// and worked for builds. Version history is additive on top of that. So a
/// /versions that 404s — which is every build until the server half merges — or
/// that fails on a flaky network HIDES the strip and changes nothing else.
///
/// It must never become an error state. A user who taps re-edit and gets
/// "Couldn't load this video's versions" has been told their video is broken,
/// when nothing is broken and the thing they came to do still works. That is a
/// worse outcome than the feature simply not being there yet.
///
/// Pure and Foundation-only on purpose: this is the decision the ruling is
/// about, so it is the thing that gets tested, rather than being inferred from
/// a screenshot of a view.
enum VersionsOutcome: Equatable {
    /// Show the strip.
    case strip(ReeditVersionsResponse)
    /// No strip. The composer stays live regardless of why.
    case hidden

    /// ANY failure hides. Deliberately not a 404-only rule: a 401, a timeout, a
    /// malformed body and an endpoint that does not exist are all "no history to
    /// show", and enumerating the tolerable ones is how the untolerated one
    /// becomes a dead end for the user.
    static func forFailure(_ error: Error) -> VersionsOutcome { .hidden }

    /// An EMPTY list hides too. A strip with no chips is furniture that explains
    /// nothing, and the server returns an empty list for a video with no
    /// completed versions yet.
    static func forSuccess(_ response: ReeditVersionsResponse) -> VersionsOutcome {
        response.versions.isEmpty ? .hidden : .strip(response)
    }

    /// The response to render, or nil when there is nothing to show.
    var response: ReeditVersionsResponse? {
        if case .strip(let r) = self { return r }
        return nil
    }
}

/// The 409 from POST /api/video-jobs/re-edit. Carries `status` so the composer
/// reads its state rather than inferring it: parked-on-a-question and
/// actively-rendering look identical from a bare 409 and need different copy.
struct ReeditInFlight: Decodable, Equatable {
    let error: String
    let status: String              // "queued" | "processing" | "needs_input"
    /// The live job holding the root. The server spells this `job_id`; this
    /// model spelled it `in_flight_job_id` and the two never met.
    let jobId: String?
    let rootJobId: String?
    /// The ordinal the live job will take if it completes.
    let version: Int?

    /// EVERY FIELD BUT `status` IS OPTIONAL, ON PURPOSE.
    ///
    /// This decoded behind `try?` in APIService — so a shape mismatch did not
    /// throw, it produced nil, the `if let` fell through, and the caller got a
    /// generic "Re-edit failed". The typed 409 that the composer's parked and
    /// rendering states are built on would simply never have been produced, and
    /// nothing would have said so. Verified against the real body before fixing:
    ///   keyNotFound "in_flight_job_id" — the server sends `job_id`.
    ///
    /// `status` is the only field that changes what the user is told, so losing
    /// an informational id must never cost the typed error again.
    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        error  = ((try? c?.decodeIfPresent(String.self, forKey: .error)) ?? nil) ?? "reedit_in_flight"
        status = ((try? c?.decodeIfPresent(String.self, forKey: .status)) ?? nil) ?? ""
        // Accept the server's spelling first, then this model's old one, so a
        // client and a server that disagree still produce a typed error.
        let id = ((try? c?.decodeIfPresent(String.self, forKey: .job_id)) ?? nil)
            ?? ((try? c?.decodeIfPresent(String.self, forKey: .in_flight_job_id)) ?? nil)
        jobId = id
        rootJobId = ((try? c?.decodeIfPresent(String.self, forKey: .root_job_id)) ?? nil)
        version = ((try? c?.decodeIfPresent(Int.self, forKey: .version)) ?? nil)
    }

    enum CodingKeys: String, CodingKey {
        case error, status, job_id, in_flight_job_id, root_job_id, version
    }

    /// needs_input is IN the in-flight set deliberately — 19 rows in production,
    /// every one a re-edit, 17% of all re-edits. A user sitting on an unanswered
    /// question could otherwise start a second render of the same video. The
    /// escape is answering the question or cancelling it, not a second re-edit.
    var isParkedOnAQuestion: Bool { status == "needs_input" }
    var isRendering: Bool { status == "queued" || status == "processing" }
}

/// The additive fields on GET /api/video-jobs/:id. All optional: a shipped
/// client that predates them keeps decoding, and this one must not assume a
/// server that has them.
struct ReeditJobFields: Decodable, Equatable {
    let root_job_id: String?
    /// null when the job is not completed — a failure has no ordinal.
    let version: Int?
    let version_count: Int?
    /// true => `version` is the number this IN-FLIGHT job will take if it
    /// completes. Exact only because one-in-flight-per-root means nothing else
    /// can complete and take the number first; if that rule is ever relaxed the
    /// server returns null here instead.
    let version_provisional: Bool?
    /// The worker's clarification question. NOT the Phase D `ask` envelope,
    /// which stays reserved — two mechanisms sharing one status is what produced
    /// the bug where 19 videos parked for up to 62 days with a question nobody
    /// could see.
    let clarification_question: String?
    /// POST the clarified reply to /api/video-jobs/re-edit against THIS id.
    /// Answering cancels the parked row and creates the reply's job in ONE
    /// transaction, so the user cannot answer and then get a 409 for it.
    let clarification_retry_job_id: String?

    var isParkedOnAQuestion: Bool {
        (clarification_question?.isEmpty == false) && clarification_retry_job_id != nil
    }
}
