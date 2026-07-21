import Foundation

/// The wall-capable handshake. A ≥1.2.0 client stamps every request to a
/// gated endpoint with `X-Promptly-Wall-Capable: 1`; the server's rollout
/// policy (lib/wall-enforcement.js `shouldEnforceWall`) enforces the wall for
/// a `.none` account when the knob is on AND (the account is post-flip OR the
/// client is wall-capable). Old binaries never send it, so they keep today's
/// capped free tier until the user updates — no mid-session hard break.
///
/// One stamp helper, called by every request builder that can hit a gated
/// door (render / chat / upload / prewarm), so a new call site can't silently
/// omit it and route a `.none` user around the wall.
enum WallCapability {
    static let headerName = "X-Promptly-Wall-Capable"
    static let headerValue = "1"

    static func stamp(_ request: inout URLRequest) {
        request.setValue(headerValue, forHTTPHeaderField: headerName)
    }
}
