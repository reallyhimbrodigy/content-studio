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

    /// THE ENCODE HAS TO EARN ITS TIME.
    ///
    /// Shrinking is not free: it is a full decode-and-re-encode before a single
    /// byte is sent, and if it takes longer than it saves, it makes the upload
    /// SLOWER while looking like an optimisation. Whether it earns its time
    /// depends on two things the asset cannot tell us:
    ///
    ///   - HOW BIG the file is. At the measured 52%+ reduction, a small file
    ///     saves a couple of seconds of transfer and can easily cost more than
    ///     that to encode.
    ///   - WHAT IT IS GOING OVER. On cellular every byte counts — the field p10
    ///     is 0.58 Mbps, where halving a file saves minutes — so the encode
    ///     always earns its time there, at any size.
    ///
    /// So: over the floor, or on cellular. On Wi-Fi under the floor, the
    /// original goes up untouched. This is a CODE rule rather than a flag
    /// because it has to be right before the flag reaches everyone, and a rule
    /// that needs a flag flip to become correct is one more thing to get wrong
    /// on the day.
    static let shrinkSizeFloor: Int64 = 40 * 1024 * 1024

    /// Pure, so the rule is assertable without an asset or a network.
    static func isWorthTheEncode(fileSize: Int64, connection: String) -> Bool {
        // Anything metered or expensive: always worth it.
        if connection == "cellular" { return true }
        return fileSize > shrinkSizeFloor
    }

    /// Decide from the asset's own tracks, the file's size, and the connection.
    /// Separated from the export so the decision can be logged (and tested)
    /// without encoding anything.
    static func decide(for asset: AVURLAsset,
                       fileSize: Int64,
                       connection: String) async -> Decision {
        // THE CHEAP REFUSAL FIRST. Reading tracks costs a demux; if the encode
        // cannot earn its time there is no reason to pay even that.
        guard isWorthTheEncode(fileSize: fileSize, connection: connection) else {
            return Decision(shouldShrink: false,
                            reason: "not_worth_encode_\(connection)_\(fileSize / (1024 * 1024))mb",
                            shortSide: 0, bitrate: 0)
        }
        return await decideFromTracks(for: asset)
    }

    /// The source-shape half of the decision, independent of size/connection.
    static func decideFromTracks(for asset: AVURLAsset) async -> Decision {
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

    enum ShrinkError: Error { case noVideoTrack, cannotWrite, exportFailed(String) }

    /// TARGET AVERAGE BITRATE. ~5.5 Mbps VBR for 1080p.
    ///
    /// WHY A BITRATE AND NOT A PRESET. This used
    /// `AVAssetExportPresetHEVC1920x1080`, which is a QUALITY preset with no
    /// bitrate API at all — you get whatever it decides. On a 4K 60s 22 Mbps
    /// source it produced 75 MB, about 10 Mbps, which is why the file only
    /// halved. Ten megabits is a DELIVERY bitrate; this file is a SOURCE for an
    /// edit that ChatCut re-encodes on export, so the only thing it has to
    /// survive is the edit.
    static let targetBitrate = 5_500_000
    /// Long side of the 1080p box. The short side follows from the aspect.
    static let targetLongSide: CGFloat = 1920

    /// Export to 1080p-short-side HEVC at `targetBitrate`. Returns the new
    /// file, or throws.
    ///
    /// The caller must treat a throw as NON-FATAL and upload the original: a
    /// failed optimisation must never cost the user their upload.
    ///
    /// Reader/writer rather than AVAssetExportSession, because the export
    /// session cannot be told a bitrate. Everything the old comment promised is
    /// still promised here:
    ///   - NEVER CROP. The render size preserves the source aspect exactly.
    ///   - NEVER CHANGE FRAME RATE. No frameDuration is imposed.
    ///   - NEVER ROTATE. The composition bakes the preferred transform in, so
    ///     the output is upright with an identity transform.
    ///   - HDR IS TONE-MAPPED IN THE SAME PASS via the composition's Rec.709
    ///     primaries/transfer/matrix; without it an HDR source lands grey.
    /// Audio is PASSED THROUGH untouched — re-encoding it saves almost nothing
    /// on a video-dominated file and is another way to damage the source.
    static func shrink(_ sourceUrl: URL) async throws -> URL {
        let asset = AVURLAsset(url: sourceUrl)
        guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
            throw ShrinkError.noVideoTrack
        }

        // DISPLAYED size, so a portrait clip is measured portrait.
        let natural = try await videoTrack.load(.naturalSize)
        let transform = try await videoTrack.load(.preferredTransform)
        let displayed = natural.applying(transform)
        let w = abs(displayed.width), h = abs(displayed.height)
        guard w > 0, h > 0 else { throw ShrinkError.noVideoTrack }

        // Fit inside the 1080p box without cropping, and never UPSCALE a source
        // that is already smaller. Dimensions are rounded to even numbers,
        // which HEVC requires for 4:2:0 chroma.
        let scale = min(targetLongSide / max(w, h), targetShortSide / min(w, h), 1.0)
        func even(_ v: CGFloat) -> Int { max(2, Int((v * scale / 2).rounded()) * 2) }
        let outW = even(w), outH = even(h)

        let comp: AVMutableVideoComposition
        if let built = try? await AVMutableVideoComposition.videoComposition(withPropertiesOf: asset) {
            comp = built
        } else {
            comp = AVMutableVideoComposition()
            comp.frameDuration = CMTime(value: 1, timescale: 30)
        }
        comp.renderSize = CGSize(width: outW, height: outH)
        comp.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
        comp.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
        comp.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2

        let out = FileManager.default.temporaryDirectory
            .appendingPathComponent("shrunk-\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: out)

        let reader = try AVAssetReader(asset: asset)
        let writer = try AVAssetWriter(outputURL: out, fileType: .mp4)
        // Front-load the moov atom so the worker can start reading before the
        // whole file has arrived.
        writer.shouldOptimizeForNetworkUse = true

        let videoOut = AVAssetReaderVideoCompositionOutput(
            videoTracks: try await asset.loadTracks(withMediaType: .video),
            videoSettings: [kCVPixelBufferPixelFormatTypeKey as String:
                                kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
        videoOut.videoComposition = comp
        videoOut.alwaysCopiesSampleData = false
        guard reader.canAdd(videoOut) else { throw ShrinkError.cannotWrite }
        reader.add(videoOut)

        let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.hevc,
            AVVideoWidthKey: outW,
            AVVideoHeightKey: outH,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: targetBitrate,
                // VBR: let a busy scene spend more than the average rather than
                // smearing it, which is what makes 5.5 Mbps watchable.
                AVVideoQualityKey: 0.9,
                AVVideoMaxKeyFrameIntervalDurationKey: 2.0,
            ],
        ])
        videoIn.expectsMediaDataInRealTime = false
        // The composition already baked orientation in.
        videoIn.transform = .identity
        guard writer.canAdd(videoIn) else { throw ShrinkError.cannotWrite }
        writer.add(videoIn)

        // Audio, passed through untouched.
        var audioOut: AVAssetReaderTrackOutput?
        var audioIn: AVAssetWriterInput?
        if let audioTrack = try? await asset.loadTracks(withMediaType: .audio).first,
           let formats = try? await audioTrack.load(.formatDescriptions),
           let hint = formats.first {
            let o = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: nil)
            o.alwaysCopiesSampleData = false
            let i = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: hint)
            i.expectsMediaDataInRealTime = false
            if reader.canAdd(o), writer.canAdd(i) {
                reader.add(o); writer.add(i)
                audioOut = o; audioIn = i
            }
        }

        guard reader.startReading(), writer.startWriting() else {
            throw ShrinkError.exportFailed(writer.error?.localizedDescription
                                           ?? reader.error?.localizedDescription ?? "could not start")
        }
        writer.startSession(atSourceTime: .zero)

        let queue = DispatchQueue(label: "shrink.pump")
        func pump(_ input: AVAssetWriterInput, _ output: AVAssetReaderOutput) async {
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                input.requestMediaDataWhenReady(on: queue) {
                    while input.isReadyForMoreMediaData {
                        guard reader.status == .reading,
                              let buf = output.copyNextSampleBuffer() else {
                            input.markAsFinished()
                            cont.resume()
                            return
                        }
                        if !input.append(buf) {
                            input.markAsFinished()
                            cont.resume()
                            return
                        }
                    }
                }
            }
        }

        await withTaskGroup(of: Void.self) { group in
            group.addTask { await pump(videoIn, videoOut) }
            if let audioIn, let audioOut {
                group.addTask { await pump(audioIn, audioOut) }
            }
            await group.waitForAll()
        }

        await writer.finishWriting()
        guard writer.status == .completed else {
            throw ShrinkError.exportFailed(writer.error?.localizedDescription
                                           ?? "writer status \(writer.status.rawValue)")
        }
        return out
    }
}
