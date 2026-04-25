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
            let resume: (Result<URL, Error>) -> Void = { result in
                guard !hasResumed else { return }
                hasResumed = true
                continuation.resume(with: result)
            }

            let options = PHVideoRequestOptions()
            options.version = .current
            options.isNetworkAccessAllowed = true
            options.deliveryMode = .highQualityFormat

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

    /// Fast local thumbnail via PHImageManager — serves from the Photos cache
    /// without touching the video bytes. No iCloud download required.
    static func thumbnail(for asset: PHAsset, size: CGSize = CGSize(width: 400, height: 400)) async -> UIImage? {
        await withCheckedContinuation { continuation in
            var hasResumed = false
            let options = PHImageRequestOptions()
            options.deliveryMode = .opportunistic
            options.isNetworkAccessAllowed = true
            options.resizeMode = .fast
            PHImageManager.default().requestImage(
                for: asset,
                targetSize: size,
                contentMode: .aspectFill,
                options: options
            ) { image, info in
                // opportunistic delivery fires the handler twice (degraded +
                // final). Resume on whichever comes first that has an image.
                guard !hasResumed else { return }
                if let image = image {
                    hasResumed = true
                    continuation.resume(returning: image)
                }
                let isFinal = (info?[PHImageResultIsDegradedKey] as? Bool) == false
                if isFinal && !hasResumed {
                    hasResumed = true
                    continuation.resume(returning: nil)
                }
            }
        }
    }
}
