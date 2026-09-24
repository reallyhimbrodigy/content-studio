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


/// AN OFFER OF REFINEMENT, POSTED AFTER THE VIDEO IS DELIVERED.
///
/// NOT a ParkedClarification, and the difference is the whole design. A parked
/// clarification is a job STOPPED at `needs_input`, waiting to be unblocked —
/// the question gates the work. This is its opposite: B1's capture shows the
/// agent asking at the END of its turn (blocks 16/26 and 24/38), after the work
/// is done, as an offer — "Captions are now live… Would you like any emphasis
/// added to specific words?" The video is already delivered and keeps its
/// delivered state whatever the user does.
///
/// Because they are opposites, they cannot share a render path: the existing
/// ClarificationCard draws only when `jobStatus == "needs_input"`, which a
/// delivered job never is. Reusing it would have shown nothing at all.
struct RefinementOffer: Codable, Equatable, Hashable {
    /// The question, verbatim from the agent. Rendered as ordinary assistant
    /// prose, not as a card with a Send button — it is a message, not a form.
    let question: String
    /// The job row this is about. PAIRED BY ROW, never by text or position, so
    /// a superseding re-edit can retract exactly this one.
    let jobId: String
    /// The version delivered when the question was asked. A question about v2
    /// must never appear under v3.
    let versionId: String?

    enum CodingKeys: String, CodingKey {
        case question, jobId = "job_id", versionId = "version_id"
    }

    init(question: String, jobId: String, versionId: String? = nil) {
        self.question = question
        self.jobId = jobId
        self.versionId = versionId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = try c.decode(String.self, forKey: .question)
        jobId = try c.decode(String.self, forKey: .jobId)
        versionId = (try? c.decodeIfPresent(String.self, forKey: .versionId)) ?? nil
    }
}
