import UIKit
import AVFoundation

enum ThumbnailGenerator {
    /// Generate a thumbnail from video data using AVAssetImageGenerator
    static func generate(from data: Data) async -> UIImage? {
        // Write to temp file so AVAsset can read it
        let tempUrl = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
        do {
            try data.write(to: tempUrl)
        } catch {
            return nil
        }
        defer { try? FileManager.default.removeItem(at: tempUrl) }

        return await generate(from: tempUrl)
    }

    /// Generate a thumbnail from a video URL
    static func generate(from url: URL) async -> UIImage? {
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 400, height: 400)

        let time = CMTime(seconds: 0.5, preferredTimescale: 600)

        do {
            let (cgImage, _) = try await generator.image(at: time)
            return UIImage(cgImage: cgImage)
        } catch {
            // Try at time 0
            do {
                let (cgImage, _) = try await generator.image(at: .zero)
                return UIImage(cgImage: cgImage)
            } catch {
                return nil
            }
        }
    }
}
