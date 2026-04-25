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

/// Resolves a PHAsset to a local file URL. Downloads from iCloud if needed
/// (progress is not surfaced — UI should already be in "uploading" state by
/// the time this runs). For slow-mo / edited AVComposition assets, exports
/// to a temp mp4 losslessly before returning.
enum PHAssetResolver {
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
    static func thumbnail(for asset: PHAsset, size: CGSize = CGSize(width: 480, height: 480)) async -> UIImage? {
        await withCheckedContinuation { continuation in
            var hasResumed = false
            let options = PHImageRequestOptions()
            options.deliveryMode = .highQualityFormat
            options.isNetworkAccessAllowed = false
            options.resizeMode = .exact
            PHImageManager.default().requestImage(
                for: asset,
                targetSize: size,
                contentMode: .aspectFill,
                options: options
            ) { image, info in
                guard !hasResumed else { return }
                hasResumed = true
                continuation.resume(returning: image)
            }
        }
    }
}
