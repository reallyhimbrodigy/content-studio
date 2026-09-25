import Foundation

/// HOW LONG UNTIL THE EDIT ACTUALLY STARTS.
///
/// WHAT COULD NOT BE ANSWERED BEFORE THIS. `upload_timing` ends at dispatch and
/// the job row carries no client-side clock, so the question "how long from
/// dispatch to the first `editing` step" had no answer anywhere — the number
/// was simply not recorded, on any build, by anything. A demo that needs to
/// know whether the wait before the words start moving is two seconds or forty
/// cannot be answered by re-reading the code.
///
/// So every step token's FIRST arrival is timed from the dispatch of its job.
/// Not just `editing`: the same record would have shown the render freeze
/// directly, because it puts a number on the gap between one step and the next
/// rather than leaving it to be inferred from how the screen felt.
///
/// ONCE PER (JOB, STEP). Steps arrive on two rails — SSE and the reconcile
/// poll — and both call into the same place. Without the guard a single step
/// would emit on every poll tick for as long as it was current, which turns
/// "time to first editing" into "how often we polled during editing".
@MainActor
enum RenderStepTiming {

    private struct Record {
        let dispatchedAt: Date
        var seen: Set<String> = []
    }

    private static var records: [String: Record] = [:]
    /// Bounded so a long session cannot grow this without limit. Renders are
    /// minutes long, so a handful of concurrent jobs is the real ceiling.
    private static let maxTracked = 24

    /// Called when a job id is known and the render is under way.
    static func begin(jobId: String, dispatchedAt: Date) {
        guard records[jobId] == nil else { return }
        if records.count >= maxTracked, let oldest = records.min(by: { $0.value.dispatchedAt < $1.value.dispatchedAt })?.key {
            records.removeValue(forKey: oldest)
        }
        records[jobId] = Record(dispatchedAt: dispatchedAt)
    }

    /// Record a step's first arrival for this job. Silent on every later one.
    static func step(jobId: String, token: String) {
        guard var r = records[jobId], !r.seen.contains(token) else { return }
        r.seen.insert(token)
        records[jobId] = r
        let ms = Int(Date().timeIntervalSince(r.dispatchedAt) * 1000)
        Analytics.track("render_step_first", props: [
            "step": token,
            "ms_since_dispatch": ms,
        ], durable: true)
        print("[stepTiming] \(jobId) \(token) +\(ms)ms")
    }

    static func finish(jobId: String) { records.removeValue(forKey: jobId) }
}
