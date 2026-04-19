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

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            guard !results.isEmpty else { onPick([]); return }

            var pickedVideos: [PickedVideo] = []
            let group = DispatchGroup()

            for result in results {
                guard let assetId = result.assetIdentifier else { continue }
                let assets = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil)
                guard let asset = assets.firstObject else { continue }

                group.enter()

                let options = PHVideoRequestOptions()
                options.version = .current
                options.isNetworkAccessAllowed = true // Handles iCloud videos
                options.deliveryMode = .highQualityFormat

                // Progress handler for iCloud downloads
                options.progressHandler = { progress, error, stop, info in
                    // Could expose this via a callback if needed
                }

                PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { avAsset, _, _ in
                    if let urlAsset = avAsset as? AVURLAsset {
                        pickedVideos.append(PickedVideo(
                            fileUrl: urlAsset.url,
                            asset: asset,
                            duration: asset.duration
                        ))
                    } else if let composition = avAsset as? AVComposition {
                        // Slow-mo or edited video — export to temp file
                        let outputUrl = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
                        guard let exportSession = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
                            group.leave()
                            return
                        }
                        exportSession.outputURL = outputUrl
                        exportSession.outputFileType = .mp4
                        exportSession.exportAsynchronously {
                            if exportSession.status == .completed {
                                pickedVideos.append(PickedVideo(
                                    fileUrl: outputUrl,
                                    asset: asset,
                                    duration: asset.duration
                                ))
                            }
                            group.leave()
                        }
                        return
                    }
                    group.leave()
                }
            }

            group.notify(queue: .main) { [self] in
                onPick(pickedVideos)
            }
        }
    }
}

struct PickedVideo {
    let fileUrl: URL
    let asset: PHAsset
    let duration: TimeInterval
}
