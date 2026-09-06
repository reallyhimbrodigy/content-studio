import Foundation

/// HAS THE SERVER EVER SEEN THIS DEVICE?
///
/// The third signal in the first-install definition (ruled 2026-09-06): a
/// first-time user has no session, no FirstRun marker, and no device_id the
/// server has ever seen. The first two live on the device and are wiped by a
/// delete-and-reinstall; this one is not, so it catches the returning user whose
/// local state is gone.
///
/// FAILS OPEN. If the endpoint is absent, slow, or errors, the answer is "not
/// known", which leaves the funnel exactly as it behaves today. A read failure
/// must never be able to suppress onboarding for a genuinely new user — that
/// would be a silent, permanent hole in the top of the funnel.
@MainActor
enum InstallHistory {

    /// True only once the server has positively confirmed prior use.
    private(set) static var deviceKnownToServer = false

    /// Whether the lookup has finished (either way). The funnel waits on this
    /// the same bounded way it waits on RevenueCat, so the decision is never
    /// made on an unread answer.
    private(set) static var hasResolved = false

    private static var inFlight = false

    static func refresh() {
        guard !inFlight, !hasResolved else { return }
        inFlight = true
        Task { @MainActor in
            defer { inFlight = false; hasResolved = true }
            let device = Analytics.deviceIdForJoin
            guard !device.isEmpty,
                  var comps = URLComponents(string: "https://usepromptly.app/api/install/seen")
            else { return }
            comps.queryItems = [URLQueryItem(name: "device_id", value: device)]
            guard let url = comps.url else { return }

            var req = URLRequest(url: url)
            req.httpMethod = "GET"
            req.timeoutInterval = 4
            guard let (data, resp) = try? await URLSession.shared.data(for: req),
                  let http = resp as? HTTPURLResponse, http.statusCode == 200,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }

            if obj["seen"] as? Bool == true {
                deviceKnownToServer = true
                // Write the modern marker forward, so the next launch answers
                // from the Keychain without a network round trip.
                FirstRun.markSeen()
                Analytics.track("first_run_recovered_from_device_id", props: [:], durable: true)
            }
        }
    }

    #if DEBUG
    /// Test seam for the three proofs. Poses the server's answer without a
    /// network call, so a simulator can stand in for a device the server knows.
    static func debugPose(seen: Bool) {
        deviceKnownToServer = seen
        hasResolved = true
    }
    static func debugReset() {
        deviceKnownToServer = false
        hasResolved = false
        inFlight = false
    }
    #endif
}
