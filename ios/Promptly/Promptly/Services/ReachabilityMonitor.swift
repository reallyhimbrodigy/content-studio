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

    /// Best-effort snapshot of the current interface type, for SYNCHRONOUS reads at
    /// telemetry-emit time from any actor/queue (upload_failed fires off the main
    /// actor, so it can't await the @MainActor store). Written on the monitor queue
    /// in the path handler; a slightly-stale read is acceptable for a tag. Values:
    /// "wifi" | "cellular" | "wired" | "other" | "offline". Lets UNS band failures by
    /// connection type — the "is the big-file loss cellular?" question.
    nonisolated(unsafe) private(set) static var currentConnectionType: String = "unknown"
    /// NWPath.isExpensive at last update (cellular / personal hotspot). Same
    /// best-effort snapshot semantics as currentConnectionType.
    nonisolated(unsafe) private(set) static var currentIsExpensive: Bool = false

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "promptly.reachability", qos: .utility)

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            let type: String = !online ? "offline"
                : path.usesInterfaceType(.wifi) ? "wifi"
                : path.usesInterfaceType(.cellular) ? "cellular"
                : path.usesInterfaceType(.wiredEthernet) ? "wired"
                : "other"
            // Written on the monitor queue (single writer); read racily at emit time.
            ReachabilityMonitor.currentConnectionType = type
            ReachabilityMonitor.currentIsExpensive = path.isExpensive
            Task { @MainActor in
                guard let self else { return }
                if self.isOnline != online {
                    print("[reachability] \(online ? "online" : "offline") type=\(type)")
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
