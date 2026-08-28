import Foundation

/// Gives UPLOAD_NEVER_STARTED a reporting path.
///
/// THE MEASURED PROBLEM (2026-08-28): 593 distinct users tapped upload and never
/// produced a `video_jobs` row. Only 120 of them ever emitted `upload_failed` or
/// `upload_http_error`. **473 — 80% — emitted nothing at all.** The dominant
/// failure class in the product is silent by construction, so it is
/// simultaneously the largest class by users and the one nobody can
/// characterise.
///
/// WHY IT IS STRUCTURALLY SILENT, not merely under-logged. A `video_jobs` row is
/// created at SEND time (JobDispatchCoordinator → createVideoJob). Anything that
/// dies before that point leaves no server-side trace whatsoever — no job, no
/// row, no worker involvement. The worker's error chokepoint cannot name this
/// class no matter how many signatures it learns, because the worker never sees
/// it. Only the client can report it. (Worker-side counterpart: `no_subcode` in
/// handler.py — a class that never routes through `_e()` at all.)
///
/// THE SPLIT IS THE POINT. `upload_started` fires at PICK time, before a single
/// byte moves, while the job row appears at SEND time. So "no job row" spans two
/// completely different failures wearing one face:
///
///   • the upload DIED            — a transport defect, ours to fix
///   • the upload SUCCEEDED and the user never sent — a UX/intent problem,
///     a different fix entirely, in a different part of the app
///
/// A count that does not separate those answers no question. This reporter's
/// whole job is to emit the discriminating field. Reporting "473 users failed to
/// upload" when some large share of them uploaded fine and simply walked away
/// would send the next week of work to the wrong subsystem.
///
/// TERMINALITY WITHOUT A TIMEOUT. Records carry the session that created them.
/// On launch, any record from a PREVIOUS session that never dispatched is
/// terminal by definition — that session is over and will never dispatch it.
/// This avoids inventing an arbitrary "an upload taking longer than N minutes is
/// dead" threshold, which would misclassify slow cellular transfers as failures
/// and, worse, would vary with the network of whoever happened to be measured.
///
/// The emit shape mirrors the worker's terminal contract
/// (`error_code` / `error_subcode` / `error_cause = "CODE:subcode"`) so a
/// two-codebase census can union client and worker rows on one key.
@MainActor
final class UploadOutcomeReporter {
    static let shared = UploadOutcomeReporter()

    static let code = "UPLOAD_NEVER_STARTED"
    private static let storeKey = "upload_outcome_ledger_v1"
    /// A runaway ledger must never grow without bound; oldest are dropped first.
    private static let maxRecords = 200

    /// Identifies THIS process. Any record carrying a different value was
    /// created by a session that has since ended.
    private let sessionID = UUID().uuidString

    private struct PickRecord: Codable {
        let pickID: String
        let sessionID: String
        let startedAt: Date
        var sizeMB: Double?
        var srcKey: String?
        /// Set when the source bytes actually landed in the bucket.
        var uploadSettledAt: Date?
        /// Last phase the pipeline reported, for records that never settled.
        var lastPhase: String?
        let appVersion: String
    }

    private var records: [PickRecord] = []

    private init() { records = Self.load() }

    // MARK: - Seams

    /// A user picked a clip and the pipeline started. Called where
    /// `upload_started` is emitted, so the ledger and that event always agree.
    func recordPick(id: UUID, sizeMB: Double?) {
        var r = PickRecord(pickID: id.uuidString,
                           sessionID: sessionID,
                           startedAt: Date(),
                           sizeMB: sizeMB,
                           srcKey: nil,
                           uploadSettledAt: nil,
                           lastPhase: "picked",
                           appVersion: Self.appVersion)
        r.lastPhase = "picked"
        records.append(r)
        if records.count > Self.maxRecords { records.removeFirst(records.count - Self.maxRecords) }
        persist()
    }

    /// The source bytes are in the bucket. From here on, a missing job row is a
    /// SEND problem, not a transport one — which is the distinction the whole
    /// class was missing.
    func recordUploadSettled(id: UUID, srcKey: String?) {
        guard let i = index(of: id) else { return }
        records[i].uploadSettledAt = Date()
        records[i].srcKey = srcKey
        records[i].lastPhase = "uploaded"
        persist()
    }

    /// Optional breadcrumb for records that never settle.
    func recordPhase(id: UUID, _ phase: String) {
        guard let i = index(of: id) else { return }
        records[i].lastPhase = phase
        persist()
    }

    /// A job row exists. This pick reached the goal; drop it — the ledger holds
    /// only outcomes that are still unresolved.
    func recordDispatched(id: UUID) {
        guard let i = index(of: id) else { return }
        records.remove(at: i)
        persist()
    }

    // MARK: - The sweep

    /// Call once per launch. Emits one terminal per pick that a previous session
    /// left unresolved, then forgets it so it can never be double-counted.
    func sweepOnLaunch() {
        let stale = records.filter { $0.sessionID != sessionID }
        guard !stale.isEmpty else { return }
        for r in stale {
            let sub = Self.subcode(for: r)
            #if DEBUG
            print("[unsProof] emit \(Self.code):\(sub) settled=\(r.uploadSettledAt != nil) phase=\(r.lastPhase ?? "-")")
            #endif
            Analytics.track("upload_never_started", props: [
                // Worker-contract shape, so a census can union both codebases.
                "error_code": Self.code,
                "error_subcode": sub,
                "error_cause": "\(Self.code):\(sub)",
                // The discriminating fields.
                "settled": r.uploadSettledAt != nil,
                "last_phase": r.lastPhase ?? "unknown",
                "age_s": Int(Date().timeIntervalSince(r.startedAt)),
                "size_mb": r.sizeMB ?? -1,
                "src_key": r.srcKey ?? "",
                "app_version_at_pick": r.appVersion,
            ])
        }
        records.removeAll { $0.sessionID != sessionID }
        persist()
    }

    /// The mechanism under the label.
    ///
    /// `unclassified` is deliberate and mirrors the worker's convention: a
    /// rising count of it means a shape we have never named is now firing, which
    /// is precisely the signal a label-only count cannot produce. It must never
    /// be folded into either real class.
    private static func subcode(for r: PickRecord) -> String {
        if r.uploadSettledAt != nil {
            // Bytes landed; no job row. The user did not send.
            return "uploaded_never_sent"
        }
        switch r.lastPhase {
        case "picked":     return "died_before_transfer"
        case "resolving":  return "asset_unresolved"
        case "exporting":  return "export_failed"
        case "uploading":  return "died_in_transfer"
        case nil:          return "unclassified"
        default:           return "unclassified"
        }
    }

    // MARK: - Plumbing

    private func index(of id: UUID) -> Int? {
        records.firstIndex { $0.pickID == id.uuidString }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(records) else { return }
        UserDefaults.standard.set(data, forKey: Self.storeKey)
    }

    private static func load() -> [PickRecord] {
        guard let data = UserDefaults.standard.data(forKey: storeKey),
              let decoded = try? JSONDecoder().decode([PickRecord].self, from: data) else { return [] }
        return decoded
    }

    private static var appVersion: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        return "\(v) (\(b))"
    }

    #if DEBUG
    /// Test seam: drive the sweep without an app restart by ageing every record
    /// into a foreign session.
    func _debugMarkAllRecordsStale() {
        records = records.map {
            PickRecord(pickID: $0.pickID, sessionID: "previous-session",
                       startedAt: $0.startedAt, sizeMB: $0.sizeMB, srcKey: $0.srcKey,
                       uploadSettledAt: $0.uploadSettledAt, lastPhase: $0.lastPhase,
                       appVersion: $0.appVersion)
        }
        persist()
    }
    var _debugRecordCount: Int { records.count }
    #endif
}
