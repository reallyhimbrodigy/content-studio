import Foundation

/// WORDS KEPT THROUGH A PAYWALL, SENT ONCE.
///
/// A free user asks for a change, the server answers 402 pro_required, and the
/// paywall opens. If they subscribe, the change they already described must run
/// — making someone retype what they just typed, immediately after paying, is
/// the worst possible first moment of being a subscriber.
///
/// THREE THINGS THIS HAS TO GET RIGHT, and each has a way of going wrong that
/// costs real money:
///
///   1. ONLY ON A CONFIRMED ENTITLEMENT. Not on the purchase sheet being
///      dismissed — that fires on cancel too — and not on a restore that found
///      nothing. The only acceptable trigger is the entitlement actually going
///      active.
///   2. EXACTLY ONCE. `isPro` can flip true more than once in a session
///      (purchase, then a customerInfo refresh, then a delegate renewal), and
///      each is a chance to send the same words again.
///   3. ACROSS A RELAUNCH. A purchase can complete while the app is being
///      killed and restored. The record therefore persists, and carries the key
///      minted when the words were QUEUED — so a send from the new process is
///      the same intent to the server, not a second one.
@MainActor
final class PendingProReedit {
    static let shared = PendingProReedit()
    private static let storeKey = "pending_pro_reedit_v1"

    struct Record: Codable, Equatable {
        let request: String
        let originalJobId: String
        /// Minted at QUEUE time. The whole point: every attempt at this intent,
        /// in any process, presents the same key.
        let idempotencyKey: String
        let createdAt: Date
        /// Set the moment a send is STARTED, before it can succeed, so a crash
        /// mid-flight cannot produce a second attempt that looks like a first.
        var dispatched: Bool = false
    }

    private(set) var record: Record? { didSet { persist() } }

    private init() { record = Self.load() }

    /// Keep the words. Idempotent per intent: re-queueing the same request for
    /// the same job keeps the ORIGINAL key, or a user who taps twice before
    /// subscribing would end up with two keys for one intent.
    func keep(request: String, originalJobId: String) {
        if let r = record, r.request == request, r.originalJobId == originalJobId, !r.dispatched {
            return
        }
        record = Record(request: request,
                        originalJobId: originalJobId,
                        idempotencyKey: UUID().uuidString,
                        createdAt: Date())
    }

    /// Claim the pending record for sending. Returns nil when there is nothing
    /// to send OR when it has already been claimed — so two callers racing on
    /// one entitlement change produce one send.
    func claim() -> Record? {
        guard var r = record, !r.dispatched else { return nil }
        r.dispatched = true
        record = r
        return r
    }

    /// Done with it, whatever the outcome. A failed send does NOT return the
    /// record to the queue: the user is a subscriber now and can ask again in
    /// one tap, which is better than a retry loop charging them in the dark.
    func clear() { record = nil }

    private func persist() {
        guard let record, let data = try? JSONEncoder().encode(record) else {
            UserDefaults.standard.removeObject(forKey: Self.storeKey); return
        }
        UserDefaults.standard.set(data, forKey: Self.storeKey)
    }

    private static func load() -> Record? {
        guard let d = UserDefaults.standard.data(forKey: storeKey) else { return nil }
        return try? JSONDecoder().decode(Record.self, from: d)
    }
}
