import AVFoundation
import Foundation
import CoreMedia

/// Encodes a low-resolution proxy of a source video for the cloud
/// Gemini editorial analysis on the Modal worker.
///
/// **Why this exists:** without a client proxy, the worker must encode
/// its own 480p@10fps proxy before Gemini can start watching the video.
/// That on-server encode sits on the render-time critical path for
/// ~7-10 seconds. When the client uploads a matching proxy, the worker
/// skips that step entirely — Gemini analysis starts the instant the
/// upload completes. The "Writing your edit recipe" stage appears
/// ~7-10s sooner from the user's perspective.
///
/// **Spec match (Modal worker reads this exact shape):**
///   - Video: H.264, 480-pixel displayed height (width auto, rounded
///     to multiple of 2), 10 fps CFR, ~800 kbps target bitrate
///   - Audio: AAC mono, 48 kHz, 48 kbps
///   - Container: MP4 with shouldOptimizeForNetworkUse = true (moov atom
///     at front so the worker can start streaming before download
///     finishes)
///
/// **Why AVAssetReader/Writer instead of AVAssetExportSession:**
/// the closest export preset (AVAssetExportPreset640x480) doesn't
/// control frame rate at all and over-spends on audio bitrate. With
/// AVAssetReader + AVAssetWriter we can set every parameter to match
/// the spec exactly, so the worker's "is this client proxy spec-
/// compatible" check passes and the on-server encode is skipped.
///
/// **Why a video composition for the resize:** AVAssetReader can
/// resize raw pixel buffers, but won't apply the source's preferred
/// transform — meaning portrait-shot videos would be sideways. An
/// AVMutableVideoComposition handles orientation + scaling + frame-
/// rate decimation in one pass, producing already-correctly-oriented
/// 10fps frames to feed into the writer.
@MainActor
enum VideoProxyExtractor {

    enum ExtractError: Error, LocalizedError {
        case noVideoTrack
        case readerSetupFailed(String)
        case writerSetupFailed(String)
        case encodeFailed(String)
        case cancelled

        var errorDescription: String? {
            switch self {
            case .noVideoTrack: return "Source has no video track"
            case .readerSetupFailed(let s): return "Reader setup failed: \(s)"
            case .writerSetupFailed(let s): return "Writer setup failed: \(s)"
            case .encodeFailed(let s): return "Proxy encode failed: \(s)"
            case .cancelled: return "Proxy encode cancelled"
            }
        }
    }

    /// Encode a spec-compliant proxy MP4 to the app's temp directory.
    ///
    /// - Parameter sourceUrl: file URL of the original video. Must be
    ///   readable from the current process (iCloud assets must be
    ///   materialized locally before calling). Typical inputs are the
    ///   compressed source produced by VideoCompressor.
    /// - Returns: file URL of the proxy MP4. Caller is responsible for
    ///   cleanup after upload completes.
    /// - Throws: ExtractError if any stage fails. Callers should treat
    ///   failure as non-fatal — the worker has a fallback encoding path.
    static func extract(from sourceUrl: URL) async throws -> URL {
        let asset = AVURLAsset(url: sourceUrl)

        // Load video track + its metadata.
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        guard let videoTrack = videoTracks.first else {
            throw ExtractError.noVideoTrack
        }
        let (naturalSize, preferredTransform, duration) = try await (
            videoTrack.load(.naturalSize),
            videoTrack.load(.preferredTransform),
            asset.load(.duration)
        )

        // Compute target dimensions. "Height" in the spec means the
        // DISPLAYED height (post-orientation), so we apply the source's
        // preferred transform to figure out what the displayed bounding
        // box looks like, then scale to 480 height preserving aspect.
        let displayedRect = CGRect(origin: .zero, size: naturalSize).applying(preferredTransform)
        let displayedSize = CGSize(width: abs(displayedRect.width), height: abs(displayedRect.height))
        let targetHeight: CGFloat = 480
        let aspectScaled = displayedSize.width * (targetHeight / displayedSize.height)
        // Round to multiple of 2 — H.264 encoders require even dimensions.
        let targetWidth: CGFloat = max(2, floor(aspectScaled / 2) * 2)
        let renderSize = CGSize(width: targetWidth, height: targetHeight)

        // Output destination. UUID-named so concurrent extracts can't
        // collide; temp dir so iOS can purge under storage pressure.
        let outUrl = FileManager.default.temporaryDirectory
            .appendingPathComponent("proxy-\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: outUrl)

        // Build the video composition. This does THREE things in one
        // pass: apply preferredTransform (orient the source correctly),
        // scale to the target render size, and decimate frame timing
        // to 10 fps (CFR). The composition's frameDuration is what
        // tells the composition output to emit one frame per 100ms,
        // dropping/duplicating from the source as needed — no manual
        // frame-stride logic required.
        let composition = AVMutableVideoComposition()
        composition.renderSize = renderSize
        composition.frameDuration = CMTime(value: 1, timescale: 10)
        composition.renderScale = 1.0

        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: .zero, duration: duration)

        let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
        layerInstruction.setTransform(
            transformFitting(naturalSize: naturalSize,
                             preferredTransform: preferredTransform,
                             target: renderSize),
            at: .zero
        )
        instruction.layerInstructions = [layerInstruction]
        composition.instructions = [instruction]

        // Reader: pulls source samples, runs them through the
        // composition (transform + scale + 10fps), hands us BGRA
        // pixel buffers at the target render size.
        let reader: AVAssetReader
        do {
            reader = try AVAssetReader(asset: asset)
        } catch {
            throw ExtractError.readerSetupFailed(error.localizedDescription)
        }

        let videoReaderOutput = AVAssetReaderVideoCompositionOutput(
            videoTracks: videoTracks,
            videoSettings: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
            ]
        )
        videoReaderOutput.videoComposition = composition
        videoReaderOutput.alwaysCopiesSampleData = false
        guard reader.canAdd(videoReaderOutput) else {
            throw ExtractError.readerSetupFailed("Cannot add video composition output")
        }
        reader.add(videoReaderOutput)

        // Audio reader (optional — source may be silent).
        var audioReaderOutput: AVAssetReaderTrackOutput?
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        if let audioTrack = audioTracks.first {
            let output = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsNonInterleaved: false,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 1,
            ])
            output.alwaysCopiesSampleData = false
            if reader.canAdd(output) {
                reader.add(output)
                audioReaderOutput = output
            }
        }

        // Writer: encodes the composition output as spec-shaped MP4.
        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: outUrl, fileType: .mp4)
        } catch {
            throw ExtractError.writerSetupFailed(error.localizedDescription)
        }
        // moov atom at front so the worker can start streaming/parsing
        // before the file finishes downloading. Saves ~1-2 seconds on
        // the worker side for typical 3-10 MB proxies.
        writer.shouldOptimizeForNetworkUse = true

        let videoWriterInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: renderSize.width,
            AVVideoHeightKey: renderSize.height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 800_000,
                AVVideoExpectedSourceFrameRateKey: 10,
                AVVideoMaxKeyFrameIntervalKey: 30,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264MainAutoLevel,
                AVVideoAllowFrameReorderingKey: false,
            ]
        ])
        videoWriterInput.expectsMediaDataInRealTime = false
        guard writer.canAdd(videoWriterInput) else {
            throw ExtractError.writerSetupFailed("Cannot add H.264 writer input")
        }
        writer.add(videoWriterInput)

        var audioWriterInput: AVAssetWriterInput?
        if audioReaderOutput != nil {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVNumberOfChannelsKey: 1,
                AVSampleRateKey: 48000,
                AVEncoderBitRateKey: 48_000,
            ])
            input.expectsMediaDataInRealTime = false
            if writer.canAdd(input) {
                writer.add(input)
                audioWriterInput = input
            }
        }

        // Start the pipeline.
        guard reader.startReading() else {
            throw ExtractError.encodeFailed("reader.startReading failed: \(reader.error?.localizedDescription ?? "unknown")")
        }
        guard writer.startWriting() else {
            throw ExtractError.encodeFailed("writer.startWriting failed: \(writer.error?.localizedDescription ?? "unknown")")
        }
        writer.startSession(atSourceTime: .zero)

        let t0 = Date()

        // Drive video and audio encode loops in parallel. Each writer
        // input gets media data appended on its own dispatch queue;
        // the encoder backpressures via isReadyForMoreMediaData, so we
        // just keep feeding samples until the corresponding reader
        // returns nil (= end of stream).
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                await pump(
                    writerInput: videoWriterInput,
                    readerOutput: videoReaderOutput,
                    label: "proxy.video"
                )
            }
            if let audioInput = audioWriterInput, let audioOutput = audioReaderOutput {
                group.addTask {
                    await pump(
                        writerInput: audioInput,
                        readerOutput: audioOutput,
                        label: "proxy.audio"
                    )
                }
            }
        }

        // Finalize. Both writer inputs are markAsFinished'd inside pump()
        // when their reader EOFs, so finishWriting() now flushes whatever
        // remains in the encoder pipelines and closes the file.
        await writer.finishWriting()

        if writer.status != .completed {
            let detail = writer.error?.localizedDescription ?? "status=\(writer.status.rawValue)"
            throw ExtractError.encodeFailed(detail)
        }

        let elapsed = Date().timeIntervalSince(t0)
        let size = (try? FileManager.default.attributesOfItem(atPath: outUrl.path)[.size] as? Int64) ?? 0
        let mb = Double(size) / 1_048_576.0
        print(String(format: "[proxy] encoded %.1fMB %.0fx%.0f@10fps in %.2fs → %@",
                     mb, renderSize.width, renderSize.height, elapsed, outUrl.lastPathComponent))

        return outUrl
    }

    /// Combined CGAffineTransform that orients the source track and
    /// scales it into the target render rectangle. The source's
    /// preferredTransform may rotate the natural rect off-origin (e.g.
    /// 90° CW rotation maps (0,0)-(w,h) to (0,-w)-(h,0)). We add the
    /// required translation to bring the result back to (0,0), then
    /// scale uniformly to fit the target.
    private static func transformFitting(
        naturalSize: CGSize,
        preferredTransform: CGAffineTransform,
        target: CGSize
    ) -> CGAffineTransform {
        let rotated = CGRect(origin: .zero, size: naturalSize).applying(preferredTransform)
        // First step: undo any negative offset introduced by the rotation.
        let translateToOrigin = CGAffineTransform(
            translationX: -rotated.minX,
            y: -rotated.minY
        )
        // displayedSize is rotated dimensions, used for scale fitting.
        let displayed = CGSize(width: abs(rotated.width), height: abs(rotated.height))
        let scaleX = target.width / displayed.width
        let scaleY = target.height / displayed.height
        // Use uniform scale (min) — target was already computed to match
        // aspect, so scaleX ≈ scaleY, but min() guards against rounding
        // (the round-to-multiple-of-2 on targetWidth can produce a
        // sub-pixel mismatch).
        let scale = min(scaleX, scaleY)
        return preferredTransform
            .concatenating(translateToOrigin)
            .concatenating(CGAffineTransform(scaleX: scale, y: scale))
    }

    /// Pump samples from a reader output into a writer input until the
    /// reader runs dry. Uses requestMediaDataWhenReady to honor the
    /// encoder's backpressure; the callback re-fires whenever the
    /// encoder is ready for more. Marked finished on EOF so the writer
    /// can flush.
    nonisolated private static func pump(
        writerInput: AVAssetWriterInput,
        readerOutput: AVAssetReaderOutput,
        label: String
    ) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            let queue = DispatchQueue(label: label)
            // Resume-once guard: requestMediaDataWhenReady's closure can
            // be called many times. We only resume the continuation
            // when we hit EOF; subsequent closure invocations after
            // markAsFinished() are no-ops.
            let resumed = ResumeOnce()
            writerInput.requestMediaDataWhenReady(on: queue) {
                while writerInput.isReadyForMoreMediaData {
                    guard let sample = readerOutput.copyNextSampleBuffer() else {
                        writerInput.markAsFinished()
                        resumed.fire { cont.resume() }
                        return
                    }
                    if !writerInput.append(sample) {
                        // Append failed (writer error or cancelled). Bail.
                        writerInput.markAsFinished()
                        resumed.fire { cont.resume() }
                        return
                    }
                }
            }
        }
    }
}

/// Thread-safe one-shot fire helper for the pump continuation. The
/// requestMediaDataWhenReady callback may be invoked multiple times
/// concurrent with EOF detection; this ensures the continuation is
/// resumed exactly once.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    func fire(_ body: () -> Void) {
        lock.lock()
        let alreadyFired = fired
        fired = true
        lock.unlock()
        if !alreadyFired { body() }
    }
}
