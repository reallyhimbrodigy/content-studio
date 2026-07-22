import Foundation

/// The client → server capability handshake, stamped on every request to a
/// gated door (render / chat / upload / prewarm) from ONE helper so a new call
/// site can't silently omit it.
///
/// Two headers, two eras:
///   - `X-Promptly-Wall-Capable: 1` — sent since 1.2.0. The server's legacy
///     rollout (`shouldEnforceWall`) uses it only when the WALL_ENFORCEMENT knob
///     is on. Kept for back-compat; inert while the knob is off.
///   - `X-Promptly-Freemium: 1` — NEW in 1.3.0. It tells the server "freemium is
///     my UNCONDITIONAL behavior": enforce the permanent free tier (2/day, 1
///     upload, Flare-only, no re-edit) + the upgrade wall for me regardless of
///     the knob (`resolveEnforce` returns true without reading it). The live
///     1.2.0 build shipped before this header existed and never sends it, so its
///     trial-wall path is provably untouched — no trial wall can activate for it.
enum WallCapability {
    static let headerName = "X-Promptly-Wall-Capable"
    static let headerValue = "1"
    static let freemiumHeaderName = "X-Promptly-Freemium"
    static let freemiumHeaderValue = "1"

    static func stamp(_ request: inout URLRequest) {
        request.setValue(headerValue, forHTTPHeaderField: headerName)
        // 1.3.0: freemium is unconditional. This header is what makes it so.
        request.setValue(freemiumHeaderValue, forHTTPHeaderField: freemiumHeaderName)
    }
}
