import AVFoundation
import UIKit

/// SEND LESS — a 1080p HEVC export for sources that are bigger than the render
/// needs.
///
/// WHY THIS EXISTS. Nothing shrinks today. `shouldSkipCompression` returns true
/// for any mp4/mov/m4v under 300 MB, and the compressor it guards only ever ran
/// `AVAssetExportPresetPassthrough` — a copy. So the camera original goes up
/// untouched, which is why the measured source is p50 80 MB and p90 172 MB. On
/// a 0.37 MB/s uplink an untouched 4K clip is minutes of transfer for pixels
/// the render throws away.
///
/// WHAT IT WILL NOT DO, because each of these is a way to ruin someone's video:
///   - NEVER CROP. The export scales to fit; the source's shape is preserved
///     exactly, portrait or landscape or anything else.
///   - NEVER CHANGE FRAME RATE. A 60fps clip stays 60fps. Decimating is a
///     visible change to motion and is not ours to make for upload speed.
///   - NEVER ROTATE. Orientation rides the preferred transform, which the
///     export preserves. Getting this wrong is the sideways-video bug.
///
/// HDR IS TONE-MAPPED IN THE SAME PASS, not a second one. An HDR source encoded
/// straight to SDR without tone-mapping comes out grey and washed; doing it as
/// a separate step would mean decoding and re-encoding twice.
///
/// DARK BY DEFAULT. This changes the bytes of every upload, so it ships behind
/// a server flag and turns on for one account, then a percentage, measured
/// against control on the upload_timing spans.
enum SourceShrinker {

    /// Short side above this is more than the render uses.
    static let targetShortSide: CGFloat = 1080
    /// Above this, even a 1080p source is worth re-encoding.
    static let bitrateCeiling: Double = 10_000_000   // ~10 Mbps

    struct Decision {
        let shouldShrink: Bool
        let reason: String
        let shortSide: Int
        let bitrate: Int
    }

    /// Decide from the asset's own tracks. Separated from the export so the
    /// decision can be logged (and tested) without encoding anything.
    static func decide(for asset: AVURLAsset) async -> Decision {
        guard let track = try? await asset.loadTracks(withMediaType: .video).first,
              let size = try? await track.load(.naturalSize),
              let transform = try? await track.load(.preferredTransform),
              let bitrate = try? await track.load(.estimatedDataRate)
        else { return Decision(shouldShrink: false, reason: "unreadable", shortSide: 0, bitrate: 0) }

        // DISPLAYED size, not natural size: a portrait clip is stored landscape
        // plus a rotation. Deciding on naturalSize would read every portrait
        // phone video as landscape and pick the wrong short side.
        let displayed = size.applying(transform)
        let w = abs(displayed.width), h = abs(displayed.height)
        let shortSide = min(w, h)
        let rate = Double(bitrate)

        if shortSide > targetShortSide {
            return Decision(shouldShrink: true, reason: "short_side_\(Int(shortSide))",
                            shortSide: Int(shortSide), bitrate: Int(rate))
        }
        if rate > bitrateCeiling {
            return Decision(shouldShrink: true, reason: "bitrate_\(Int(rate / 1_000_000))mbps",
                            shortSide: Int(shortSide), bitrate: Int(rate))
        }
        // Already small enough. Pass it through with NO re-encode — re-encoding
        // a modest clip costs battery and quality to save nothing.
        return Decision(shouldShrink: false, reason: "already_small",
                        shortSide: Int(shortSide), bitrate: Int(rate))
    }

    enum ShrinkError: Error { case noExportSession, exportFailed(String) }

    /// Export to 1080p-short-side HEVC. Returns the new file, or throws.
    ///
    /// The caller must treat a throw as NON-FATAL and upload the original: a
    /// failed optimisation must never cost the user their upload.
    static func shrink(_ sourceUrl: URL) async throws -> URL {
        let asset = AVURLAsset(url: sourceUrl)
        // HEVC, confirmed by B1 to import (1080x1920, ready in 6.0s) and export
        // from ChatCut with the picture intact, against an H.264 control on the
        // same timeline. The preset scales to FIT its box, preserving aspect
        // and orientation, and leaves frame rate alone.
        let preset = AVAssetExportPresetHEVC1920x1080
        guard await AVAssetExportSession.compatibility(ofExportPreset: preset,
                                                       with: asset, outputFileType: .mp4),
              let session = AVAssetExportSession(asset: asset, presetName: preset)
        else { throw ShrinkError.noExportSession }

        let out = FileManager.default.temporaryDirectory
            .appendingPathComponent("shrunk-\(UUID().uuidString).mp4")
        session.outputURL = out
        session.outputFileType = .mp4
        // Front-load the moov atom so the worker can start reading before the
        // whole file has arrived — the same reason the proxy does it.
        session.shouldOptimizeForNetworkUse = true

        // TONE-MAP HDR -> SDR IN THIS PASS. Assigning Rec.709 primaries,
        // transfer function and matrix to the composition makes the export
        // convert rather than truncate; without it an HDR source lands grey.
        if let comp = try? await AVMutableVideoComposition.videoComposition(withPropertiesOf: asset) {
            comp.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
            comp.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
            comp.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
            session.videoComposition = comp
        }

        await session.export()
        guard session.status == .completed else {
            throw ShrinkError.exportFailed(session.error?.localizedDescription ?? "status \(session.status.rawValue)")
        }
        return out
    }
}
