import Foundation

/// STAGE TIMINGS FOR ONE UPLOAD, from the pick to the dispatched job.
///
/// A total tells you an upload took twenty seconds. It does not tell you
/// whether that was spent writing a copy of the file nobody needed, waiting
/// for the first byte to leave, or transferring — and those have completely
/// different fixes. Every stage is recorded against the same t0 so the
/// breakdown subtracts cleanly, and the whole thing lands as ONE event rather
/// than six, because six events for one upload is a funnel nobody joins.
///
/// Keyed by the message id, because the marks are set from three different
/// places: the pick (EditorView), the transfer (the upload managers) and the
/// dispatch (the coordinator).
enum UploadTiming {
    private struct Run {
        let t0: Date
        var marks: [String: Int] = [:]      // stage -> ms since t0
        var meta: [String: Any] = [:]
    }
    nonisolated(unsafe) private static var runs: [String: Run] = [:]
    nonisolated(unsafe) private static let lock = NSLock()

    /// Start the clock. Called the instant the picker hands back a clip.
    static func begin(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        runs[id] = Run(t0: Date())
    }

    /// Record a stage. First write wins — a retry must not overwrite the
    /// first-byte time of the attempt that actually mattered.
    static func mark(_ id: String, _ stage: String) {
        lock.lock(); defer { lock.unlock() }
        guard var r = runs[id], r.marks[stage] == nil else { return }
        r.marks[stage] = Int(Date().timeIntervalSince(r.t0) * 1000)
        runs[id] = r
    }

    static func meta(_ id: String, _ key: String, _ value: Any) {
        lock.lock(); defer { lock.unlock() }
        guard var r = runs[id] else { return }
        r.meta[key] = value
        runs[id] = r
    }

    /// Emit the breakdown and forget the run.
    static func finish(_ id: String, outcome: String) {
        lock.lock()
        guard let r = runs.removeValue(forKey: id) else { lock.unlock(); return }
        lock.unlock()
        var props: [String: Any] = r.meta
        props["outcome"] = outcome
        props["total_ms"] = Int(Date().timeIntervalSince(r.t0) * 1000)
        for (stage, ms) in r.marks { props["t_" + stage] = ms }
        Analytics.track("upload_timing", props: props, durable: true)
    }
}
