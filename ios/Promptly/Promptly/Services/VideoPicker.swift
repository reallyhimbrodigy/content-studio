import SwiftUI
import PhotosUI
import Photos
import AVFoundation

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
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            guard !results.isEmpty else { onPick([]); return }

            var pickedVideos: [PickedVideo] = []
            for result in results {
                guard let assetId = result.assetIdentifier else { continue }
                let assets = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil)
                guard let asset = assets.firstObject else { continue }
                pickedVideos.append(PickedVideo(asset: asset, duration: asset.duration))
            }
            onPick(pickedVideos)
        }
    }
}

struct PickedVideo {
    let asset: PHAsset
    let duration: TimeInterval
    var id: String { asset.localIdentifier }
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
                    guard let exportSession = AVAssetExportSession(
                        asset: composition,
                        presetName: AVAssetExportPresetHighestQuality
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
    static func thumbnail(for asset: PHAsset, size: CGSize = CGSize(width: 200, height: 200)) async -> UIImage? {
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
