import SwiftUI
import PhotosUI
import Photos
import AVFoundation
import UIKit
import UniformTypeIdentifiers

struct NativeVideoPicker: UIViewControllerRepresentable {
    let maxSelection: Int
    let onPick: ([PickedVideo]) -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.filter = .videos
        config.selectionLimit = maxSelection
        config.preferredAssetRepresentationMode = .current

        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onPick: onPick)
    }

    class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let onPick: ([PickedVideo]) -> Void

        init(onPick: @escaping ([PickedVideo]) -> Void) {
            self.onPick = onPick
        }

        // Return PickedVideos immediately from PHAsset identifiers — no
        // iCloud download on this path. Previously we called
        // PHImageManager.requestAVAsset(forVideo:) with
        // isNetworkAccessAllowed=true right here, which BLOCKED onPick
        // until the full video was streamed from iCloud. For iCloud-only
        // footage that's a multi-second wait before the UI even knows
        // something was picked. Caller now handles iCloud fetch in the
        // background while the thumbnail appears immediately.
        /// The read-authorization state, as a stable string for analytics.
        ///
        /// Instrumented because the whole diagnosis turned on it and it appeared
        /// NOWHERE in the app: the picker never inspected authorization, so
        /// "never asked" / "denied" / "limited-with-asset-outside-the-grant"
        /// were indistinguishable in the data and all three need different
        /// fixes. Reading the status does NOT prompt.
        static var readAuthStatus: String {
            switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
            case .notDetermined: return "not_determined"
            case .restricted:    return "restricted"
            case .denied:        return "denied"
            case .authorized:    return "authorized"
            case .limited:       return "limited"
            @unknown default:    return "unknown"
            }
        }

        /// Copy the video out of the picker's item provider into our temp dir.
        ///
        /// `loadFileRepresentation` hands back a URL that is deleted the moment
        /// the completion returns, so the file MUST be copied inside the
        /// closure — returning the provider's URL would give a path that no
        /// longer exists by the time the upload reads it.
        static func copyOutOfProvider(_ provider: NSItemProvider) async -> URL? {
            let type = UTType.movie.identifier
            guard provider.hasItemConformingToTypeIdentifier(type) else { return nil }
            return await withCheckedContinuation { cont in
                provider.loadFileRepresentation(forTypeIdentifier: type) { tmp, _ in
                    guard let tmp else { cont.resume(returning: nil); return }
                    let dest = FileManager.default.temporaryDirectory
                        .appendingPathComponent("picked-\(UUID().uuidString).\(tmp.pathExtension.isEmpty ? "mov" : tmp.pathExtension)")
                    do {
                        try FileManager.default.copyItem(at: tmp, to: dest)
                        cont.resume(returning: dest)
                    } catch {
                        cont.resume(returning: nil)
                    }
                }
            }
        }

        /// Set when a pick could not be recovered by either path, so the UI can
        /// say so instead of returning the user to an unchanged screen.
        @MainActor static var lastUnrecoverableCount: Int = 0

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            // CANCEL / empty dismissal: PHPicker calls back with zero results when
            // the user backs out without choosing. Emitted so the first-run funnel
            // can tell "opened the picker and left" apart from "never opened it"
            // (picker_opened without a picker_result) and from "picked but the
            // asset didn't resolve" (the dropped case below).
            guard !results.isEmpty else {
                Analytics.track("picker_result", props: ["raw": 0, "resolved": 0, "dropped": 0])
                onPick([])
                return
            }

            var pickedVideos: [PickedVideo] = []
            var droppedNoIdentifier = 0
            var droppedNoAsset = 0
            // Results whose PHAsset lookup failed, kept for the item-provider
            // recovery below instead of being discarded.
            var needsRecovery: [(String, NSItemProvider)] = []
            for result in results {
                guard let assetId = result.assetIdentifier else { droppedNoIdentifier += 1; continue }
                let assets = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil)
                guard let asset = assets.firstObject else {
                    droppedNoAsset += 1
                    needsRecovery.append((assetId, result.itemProvider))
                    continue
                }
                pickedVideos.append(PickedVideo(identifier: assetId, asset: asset,
                                                localFile: nil, duration: asset.duration))
            }
            // A picked result that resolves to NO PHAsset used to vanish here with
            // ZERO signal — indistinguishable in the data from "never picked." That
            // is a real, silent activation loss (UX-4). Emit the raw→resolved split
            // always, and when anything dropped, a durable diagnostic naming which
            // guard failed (missing assetIdentifier vs. fetch returning nothing).
            let dropped = droppedNoIdentifier + droppedNoAsset

            // ── RECOVERY: load the video from the picker's own item provider ──
            //
            // WHY THIS PATH EXISTS. `PHAsset.fetchAssets(withLocalIdentifiers:)`
            // needs photo-library READ authorization. This app never requests
            // it — the only requestAuthorization in the tree is `.addOnly`, for
            // SAVING a finished video — so for a user who has not granted read
            // access the fetch returns an EMPTY SET with no error, and the video
            // the user explicitly chose was silently discarded. Measured across
            // 675 installs: every single loss was this guard (no_identifier was
            // 0 in 100% of cases), and 14% of them never recovered at all.
            //
            // PHPicker itself runs OUT OF PROCESS and needs no permission — the
            // result already carries the media. So instead of asking for a
            // permission we do not otherwise need, load the file the picker
            // already handed us. No prompt, works under `.limited` even when the
            // asset sits outside the user's granted subset, and it is the path
            // Apple intends for PHPicker.
            //
            // The PHAsset path stays PRIMARY where it works, because it is what
            // enables the iCloud-streaming upload strategy (stream from iCloud
            // straight into the S3 multipart upload) that a flat file copy
            // cannot do.
            //
            // NON-BLOCKING when nothing drops, which is the normal case: the
            // recovery task is only entered if `needsRecovery` is non-empty, so
            // the immediate-return behaviour that removed the old multi-second
            // iCloud stall is preserved exactly.
            if needsRecovery.isEmpty {
                Analytics.track("picker_result",
                                props: ["raw": results.count, "resolved": pickedVideos.count,
                                        "dropped": dropped, "recovered": 0,
                                        "read_auth": Self.readAuthStatus],
                                durable: dropped > 0)
                onPick(pickedVideos)
                return
            }

            Task {
                var recovered: [PickedVideo] = []
                for (assetId, provider) in needsRecovery {
                    if let url = await Self.copyOutOfProvider(provider) {
                        let dur = (try? await AVURLAsset(url: url).load(.duration).seconds) ?? 0
                        recovered.append(PickedVideo(identifier: assetId, asset: nil,
                                                     localFile: url, duration: dur))
                    }
                }
                let all = pickedVideos + recovered
                let stillLost = needsRecovery.count - recovered.count
                Analytics.track("picker_result",
                                props: ["raw": results.count, "resolved": all.count,
                                        "dropped": stillLost, "recovered": recovered.count,
                                        "read_auth": Self.readAuthStatus],
                                durable: stillLost > 0)
                if stillLost > 0 {
                    // NEVER SILENT AGAIN. Before this, a pick that resolved to
                    // nothing returned the user to an unchanged screen with no
                    // error, no spinner and no explanation — indistinguishable
                    // from never having picked. If we cannot recover it, say so.
                    Analytics.track("picker_asset_unrecoverable",
                                    props: ["count": stillLost, "raw": results.count,
                                            "read_auth": Self.readAuthStatus], durable: true)
                }
                await MainActor.run {
                    Self.lastUnrecoverableCount = stillLost
                    onPick(all)
                }
            }
            if dropped > 0 {
                Analytics.track("picker_asset_unresolved",
                                props: ["raw": results.count,
                                        "no_identifier": droppedNoIdentifier,
                                        "no_asset": droppedNoAsset],
                                durable: true)
            }
            onPick(pickedVideos)
        }
    }
}

struct PickedVideo {
    /// PHPicker's `assetIdentifier`. ALWAYS present — it is the second guard
    /// (the PHAsset lookup) that fails, never this one, so it is the stable id
    /// whether or not the library lookup succeeded.
    let identifier: String
    /// nil when the photo-library lookup returned nothing (no read permission,
    /// or a `.limited` grant that excludes this asset). The recovery path fills
    /// `localFile` instead.
    let asset: PHAsset?
    /// A copy of the video taken from the picker's item provider, used when
    /// `asset` is nil. Owned by us, in the temp directory.
    let localFile: URL?
    let duration: TimeInterval
    var id: String { identifier }
}

/// Two possible resolution strategies for a picked video:
///   - `.local`: asset is already on disk, we have a file URL, upload it directly
///   - `.stream`: asset is iCloud-only, we have a PHAssetResource + file size,
///     stream bytes directly from iCloud into the S3 multipart upload so the
///     two transfers happen in parallel (total time = max(dl, ul) instead of
///     dl + ul)
enum VideoResolution {
    case local(URL)
    case stream(resource: PHAssetResource, fileSize: Int64)
}

/// Resolves a PHAsset to a local file URL. Downloads from iCloud if needed
/// (progress is not surfaced — UI should already be in "uploading" state by
/// the time this runs). For slow-mo / edited AVComposition assets, exports
/// to a temp mp4 losslessly before returning.
enum PHAssetResolver {
    /// Determine the fastest upload strategy for this asset.
    /// Tries local-only first (no iCloud fetch); if that fails and we have
    /// a video resource with a known file size, returns .stream so the
    /// caller can pipeline iCloud download + S3 upload. Falls back to
    /// downloading via resolveFileUrl only if streaming isn't viable.
    // ── PickedVideo-aware overloads ─────────────────────────────────────────
    //
    // A video recovered from the picker's item provider has NO PHAsset — it is
    // already a file on disk. These keep the five call sites from each having
    // to branch on that, and make the recovered pick behave like any other
    // local clip. A recovered pick is necessarily `.local`, never `.stream`:
    // iCloud streaming needs PHAssetResource, which needs the asset. That is
    // the accepted cost, and it is strictly better than today, where the pick
    // is lost outright.
    static func resolveStrategy(video: PickedVideo) async -> VideoResolution? {
        if let asset = video.asset { return await resolveStrategy(asset: asset) }
        guard let url = video.localFile else { return nil }
        return .local(url)
    }

    static func localFileURLIfAvailable(video: PickedVideo) async -> URL? {
        if let asset = video.asset { return await localFileURLIfAvailable(asset: asset) }
        return video.localFile
    }

    static func thumbnail(for video: PickedVideo) async -> UIImage? {
        if let asset = video.asset { return await thumbnail(for: asset) }
        guard let url = video.localFile else { return nil }
        let gen = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 400, height: 400)
        return await withCheckedContinuation { cont in
            gen.generateCGImageAsynchronously(for: .zero) { cg, _, _ in
                cont.resume(returning: cg.map { UIImage(cgImage: $0) })
            }
        }
    }

    static func resolveStrategy(asset: PHAsset) async -> VideoResolution? {
        // 1. Can we get the file locally, without any iCloud round trip?
        if let localUrl = await tryResolveLocalOnly(asset: asset) {
            return .local(localUrl)
        }
        // 2. iCloud-only. Find the best resource to stream.
        let resources = PHAssetResource.assetResources(for: asset)
        let preferredTypes: [PHAssetResourceType] = [.fullSizeVideo, .video, .pairedVideo]
        let resource = preferredTypes.compactMap { t in
            resources.first(where: { $0.type == t })
        }.first
        guard let resource = resource else { return nil }
        // PhotoKit exposes the underlying byte size via KVC. Several shipping
        // apps rely on this key; it has been stable across iOS versions.
        let fileSize: Int64 = {
            if let n = resource.value(forKey: "fileSize") as? Int64 { return n }
            if let n = resource.value(forKey: "fileSize") as? NSNumber { return n.int64Value }
            return 0
        }()
        guard fileSize > 0 else { return nil }
        return .stream(resource: resource, fileSize: fileSize)
    }

    /// Public wrapper around tryResolveLocalOnly so other services can
    /// check "do I have file URL access without paying an iCloud
    /// download?" — used by TalkingHeadPrecheck to decide whether the
    /// on-device Vision precheck is fast enough to run.
    static func localFileURLIfAvailable(asset: PHAsset) async -> URL? {
        await tryResolveLocalOnly(asset: asset)
    }

    /// Try to get the file URL WITHOUT touching iCloud. Returns nil for
    /// iCloud-only assets or edited/composition assets that need rendering.
    private static func tryResolveLocalOnly(asset: PHAsset) async -> URL? {
        await withCheckedContinuation { continuation in
            var hasResumed = false
            let options = PHVideoRequestOptions()
            options.version = .current
            options.isNetworkAccessAllowed = false
            options.deliveryMode = .automatic
            PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { avAsset, _, _ in
                guard !hasResumed else { return }
                hasResumed = true
                if let urlAsset = avAsset as? AVURLAsset {
                    continuation.resume(returning: urlAsset.url)
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    static func resolveFileUrl(asset: PHAsset) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            var hasResumed = false
            let start = Date()
            let resume: (Result<URL, Error>) -> Void = { result in
                guard !hasResumed else { return }
                hasResumed = true
                continuation.resume(with: result)
            }

            let options = PHVideoRequestOptions()
            options.version = .current
            options.isNetworkAccessAllowed = true
            // `.automatic` returns the original asset file URL without
            // transcoding for on-device assets (free), and downloads the
            // original bytes from iCloud when needed. `.highQualityFormat`
            // would potentially re-transcode to a "higher quality" format,
            // burning time for zero benefit.
            options.deliveryMode = .automatic
            options.progressHandler = { progress, _, _, _ in
                if progress > 0 && progress < 1 {
                    print(String(format: "[perf] resolve iCloud progress=%.0f%% elapsed=%.2fs", progress * 100, Date().timeIntervalSince(start)))
                }
            }

            PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { avAsset, _, info in
                if let error = info?[PHImageErrorKey] as? Error {
                    resume(.failure(error))
                    return
                }
                if let urlAsset = avAsset as? AVURLAsset {
                    resume(.success(urlAsset.url))
                    return
                }
                if let composition = avAsset as? AVComposition {
                    let outputUrl = FileManager.default.temporaryDirectory
                        .appendingPathComponent(UUID().uuidString + ".mp4")
                    // Edited/slo-mo clips resolve to a composition. Prefer LOSSLESS
                    // passthrough when the composition supports it (a simple trim
                    // usually does) — it avoids the extra lossy generation that
                    // HighestQuality's re-encode adds. Fall back to HighestQuality only
                    // when passthrough can't apply (time-remapped slo-mo, filters, mixed
                    // formats). Resolution is preserved either way. determineCompatibility
                    // is DEFINITIVE, so we never pick passthrough for a clip it would
                    // fail on (which would fail the upload).
                    AVAssetExportSession.determineCompatibility(
                        ofExportPreset: AVAssetExportPresetPassthrough,
                        with: composition,
                        outputFileType: .mp4
                    ) { canPassthrough in
                        let preset = canPassthrough
                            ? AVAssetExportPresetPassthrough
                            : AVAssetExportPresetHighestQuality
                        guard let exportSession = AVAssetExportSession(
                            asset: composition,
                            presetName: preset
                        ) else {
                            resume(.failure(NSError(domain: "PHAssetResolver", code: -1)))
                            return
                        }
                        exportSession.outputURL = outputUrl
                        exportSession.outputFileType = .mp4
                        exportSession.exportAsynchronously {
                            if exportSession.status == .completed {
                                resume(.success(outputUrl))
                            } else {
                                resume(.failure(exportSession.error ?? NSError(domain: "PHAssetResolver", code: -2)))
                            }
                        }
                    }
                    return
                }
                resume(.failure(NSError(domain: "PHAssetResolver", code: -3)))
            }
        }
    }

    /// Fast LOCAL-ONLY thumbnail via PHImageManager. Critical:
    /// `isNetworkAccessAllowed = false`. With network allowed, PhotoKit
    /// can decide to download the full source from iCloud just to generate
    /// a sharper thumbnail — for a 100MB video that's 1-2 minutes of
    /// spinning UI. Photos always keeps a local thumbnail cached even for
    /// iCloud-only assets, so local-only is correct here. For sharp final
    /// thumbnails we regenerate from the actual video file via
    /// AVAssetImageGenerator once it's resolved.
    static func thumbnail(for asset: PHAsset, size: CGSize = CGSize(width: 112, height: 112)) async -> UIImage? {
        await withCheckedContinuation { continuation in
            var hasResumed = false
            let options = PHImageRequestOptions()
            // `.opportunistic` + `.fast` resize + `.isNetworkAccessAllowed = false`
            // is the fastest possible local path: delivers whichever cached
            // thumbnail Photos has on disk (every video always has at least
            // one), never triggers an iCloud download just to sharpen the
            // tile. Tile gets a thumbnail within a single frame of the
            // picker dismissing. Sharper regen happens later via
            // AVAssetImageGenerator once the full video bytes are local.
            options.deliveryMode = .opportunistic
            options.isNetworkAccessAllowed = false
            options.resizeMode = .fast
            PHImageManager.default().requestImage(
                for: asset,
                targetSize: size,
                contentMode: .aspectFill,
                options: options
            ) { image, info in
                // Opportunistic delivery can fire the handler multiple
                // times (first degraded, then final). Resume on the first
                // callback that carries an image so the tile shows up
                // instantly; if that very first callback has no image,
                // wait for the next one instead of returning nil.
                guard !hasResumed else { return }
                if image != nil {
                    hasResumed = true
                    continuation.resume(returning: image)
                    return
                }
                let isFinal = (info?[PHImageResultIsDegradedKey] as? Bool) == false
                if isFinal {
                    hasResumed = true
                    continuation.resume(returning: nil)
                }
            }
        }
    }
}
