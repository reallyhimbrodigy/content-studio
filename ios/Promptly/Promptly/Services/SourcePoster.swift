import UIKit
import AVFoundation

/// THE SOURCE CLIP'S POSTER FRAME — the thing being edited, shown on the job's
/// card in every state it has.
///
/// WHY THIS EXISTS. The card that draws render progress is the ASSISTANT
/// message; the picked clip's thumbnail was only ever attached to the USER
/// message beside it. So `RenderProgressRing` received nil for both its image
/// and its URL and drew an empty frame — a black rectangle from the moment a
/// clip was picked until the finished video's own poster loaded. The thumbnail
/// pipeline was working the whole time; nothing carried its result to the card.
///
/// Two consequences shape this file:
///   1. the poster is keyed by JOB ID, not by message or by picker session, so
///      the one thing that survives a relaunch is the thing the card looks up;
///   2. it is written to disk at pick time, because a render outlives the
///      process that started it and a UIImage does not.
///
/// ZERO NETWORK. Everything here reads the local asset. A poster that needed a
/// round-trip would be absent exactly when it is most wanted — on a slow
/// connection, mid-upload, which is the longest a user ever looks at this card.
enum SourcePoster {

    // MARK: - Generation

    /// Candidate offsets, in order. A clip that opens on black — a fade-in, a
    /// dark first frame, a slate — must not reproduce the very box this fixes,
    /// so the first frame that clears a luminance floor wins.
    private static let candidateSeconds: [Double] = [0.5, 1.0, 2.0]

    /// Mean luminance below this reads as "black frame" rather than "dark
    /// scene". Deliberately low: the test is for an absent image, not for a
    /// moody one, and rejecting a legitimately dark clip would leave the card
    /// empty for the user whose footage it is.
    private static let luminanceFloor: Double = 0.06

    /// A poster for a local video, or nil when the asset yields nothing.
    static func generate(from url: URL) async -> UIImage? {
        let asset = AVURLAsset(url: url)
        let gen = AVAssetImageGenerator(asset: asset)
        // WITHOUT THIS, PHONE-SHOT VIDEO COMES OUT SIDEWAYS. Portrait capture
        // stores landscape pixels plus a rotation transform; ignoring it yields
        // a correctly-decoded, 90°-wrong poster.
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 720, height: 720)
        // Tolerance, not exactness: asking for an exact instant on an encoding
        // with no frame there returns nothing at all. Half a second either way
        // lands on the nearest keyframe.
        gen.requestedTimeToleranceBefore = CMTime(seconds: 0.5, preferredTimescale: 600)
        gen.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)

        var firstDecoded: UIImage?
        for seconds in candidateSeconds {
            guard let image = await frame(gen, atSeconds: seconds) else { continue }
            if firstDecoded == nil { firstDecoded = image }
            if meanLuminance(of: image) >= luminanceFloor { return image }
        }
        // Every candidate was dark or undecodable. Fall back to 0s, then to
        // whichever frame did decode — a dark poster still shows the clip's
        // shape and colour, which is the whole point over an empty box.
        if let zero = await frame(gen, atSeconds: 0) {
            if meanLuminance(of: zero) >= luminanceFloor { return zero }
            return firstDecoded ?? zero
        }
        return firstDecoded
    }

    private static func frame(_ gen: AVAssetImageGenerator, atSeconds s: Double) async -> UIImage? {
        let time = CMTime(seconds: s, preferredTimescale: 600)
        return await withCheckedContinuation { cont in
            gen.generateCGImageAsynchronously(for: time) { cg, _, _ in
                cont.resume(returning: cg.map { UIImage(cgImage: $0) })
            }
        }
    }

    /// Mean luminance in 0...1, sampled from a small redraw rather than the full
    /// frame — a 720px poster is ~500k pixels and this runs on every pick.
    static func meanLuminance(of image: UIImage) -> Double {
        let side = 16
        let size = CGSize(width: side, height: side)
        var buffer = [UInt8](repeating: 0, count: side * side * 4)
        guard let ctx = CGContext(data: &buffer, width: side, height: side,
                                  bitsPerComponent: 8, bytesPerRow: side * 4,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let cg = image.cgImage else { return 1 }   // unreadable: never reject
        ctx.draw(cg, in: CGRect(origin: .zero, size: size))
        var total = 0.0
        for i in stride(from: 0, to: buffer.count, by: 4) {
            let r = Double(buffer[i]) / 255.0
            let g = Double(buffer[i + 1]) / 255.0
            let b = Double(buffer[i + 2]) / 255.0
            total += 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        return total / Double(side * side)
    }

    // MARK: - Persistence, keyed by job id

    private static var directory: URL? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        else { return nil }
        let dir = caches.appendingPathComponent("SourcePosters", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    /// CACHES, NOT DOCUMENTS. A poster is regenerable from the source clip and
    /// must not consume the user's backup quota; the OS may evict it under
    /// pressure and the card falls back to what it had before.
    private static func fileURL(for jobId: String) -> URL? {
        let safe = jobId.replacingOccurrences(of: "/", with: "_")
        return directory?.appendingPathComponent(safe + ".jpg")
    }

    @discardableResult
    static func save(_ image: UIImage, for jobId: String) -> Bool {
        guard let url = fileURL(for: jobId), let data = image.jpegData(compressionQuality: 0.8)
        else { return false }
        do { try data.write(to: url, options: .atomic); return true } catch { return false }
    }

    /// The poster for a job, if one was written. This is what makes a relaunch
    /// mid-render show the clip instead of an empty frame.
    static func load(for jobId: String) -> UIImage? {
        guard let url = fileURL(for: jobId), let data = try? Data(contentsOf: url) else { return nil }
        return UIImage(data: data)
    }

    /// Generate and persist in one step, returning what the card should show.
    @discardableResult
    static func capture(from url: URL, for jobId: String) async -> UIImage? {
        if let existing = load(for: jobId) { return existing }
        guard let image = await generate(from: url) else { return nil }
        save(image, for: jobId)
        return image
    }

    /// Carry an existing poster onto a new job — a re-edit shows the previous
    /// version's frame, because that is the video being changed.
    @discardableResult
    static func inherit(from oldJobId: String, to newJobId: String) -> UIImage? {
        guard let image = load(for: oldJobId) else { return nil }
        save(image, for: newJobId)
        return image
    }
}
