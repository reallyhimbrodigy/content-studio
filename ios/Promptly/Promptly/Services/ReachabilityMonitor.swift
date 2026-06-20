import Foundation
import Network
import Combine

/// Live network reachability. The dispatch coordinator pauses its retry
/// loop when offline so we don't burn battery and rate-limit ourselves
/// retrying against a connection that physically isn't there. When the
/// path comes back we resume immediately — no fixed-interval polling.
///
/// `isOnline` is the source of truth; `waitForOnline()` is the await-
/// based primitive the coordinator uses to block its loop without a
/// busy-wait.
@MainActor
final class ReachabilityMonitor: ObservableObject {
    static let shared = ReachabilityMonitor()

    @Published private(set) var isOnline: Bool = true

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "promptly.reachability", qos: .utility)

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in
                guard let self else { return }
                if self.isOnline != online {
                    print("[reachability] \(online ? "online" : "offline")")
                    self.isOnline = online
                }
            }
        }
        monitor.start(queue: queue)
    }

    /// Suspends until the network is reported as satisfied. Returns
    /// immediately if already online. Safe to call from any actor; the
    /// observation flips on the main actor.
    func waitForOnline() async {
        if isOnline { return }
        // AsyncStream over the @Published lets us wait for the next
        // transition without polling. We drop the stream as soon as we
        // see an online event.
        for await online in $isOnline.values {
            if online { return }
        }
    }
}
