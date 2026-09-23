import Foundation

/// AN ATTEMPT THAT NEVER TERMINATED IS STILL AN OUTCOME.
///
/// `purchase(package:)` is awaited with no timeout, so a process that dies
/// while Apple's sheet is up emits `purchase_started` and then nothing. Over 30
/// days that was 48 of 596 attempts — 8% of every decision to pay — sitting in
/// a bucket named "unaccounted", which is the one bucket nobody can act on. 29
/// of those were the yearly row, the row that completed zero times.
///
/// The marker is written to UserDefaults BEFORE the await and cleared by
/// whichever terminal fires. It therefore survives exactly the failure it is
/// about: a kill. On the next launch, anything still pending is an attempt that
/// ended without a terminal, and is reported with why it is being inferred.
enum PurchaseAbandonment {
    private static let key = "purchase_pending_attempt"

    /// Called immediately before the await. Carries the same props the terminals
    /// carry, so an abandoned attempt is comparable with a completed one rather
    /// than being a bare count.
    static func markPending(_ props: [String: Any]) {
        var payload = props.compactMapValues { $0 as? String ?? String(describing: $0) }
        payload["pending_since"] = ISO8601DateFormatter().string(from: Date())
        UserDefaults.standard.set(payload, forKey: key)
    }

    static func clearPending() {
        UserDefaults.standard.removeObject(forKey: key)
    }

    /// Report-and-clear, once, at launch.
    ///
    /// REASON IS INFERRED AND SAYS SO. The client cannot know whether the user
    /// walked away, the system dismissed the sheet, or the app was killed — it
    /// only knows the attempt started and never finished. `reason` records the
    /// evidence (how long it was pending), not a guess dressed as a fact.
    @MainActor
    static func sweepOnLaunch() {
        guard let payload = UserDefaults.standard.dictionary(forKey: key) as? [String: String]
        else { return }
        clearPending()

        var props: [String: Any] = payload
        let started = (payload["pending_since"]).flatMap { ISO8601DateFormatter().date(from: $0) }
        let pendingSeconds = started.map { Int(Date().timeIntervalSince($0)) }
        props["pending_seconds"] = pendingSeconds ?? -1
        props["reason"] = "no_terminal_before_relaunch"
        props["inferred"] = true
        Analytics.track("purchase_abandoned", props: props, durable: true)
    }
}
