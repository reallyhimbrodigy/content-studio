import Foundation
import Photos

/// Materialize an iCloud-only `PHAssetResource` to a durable local file.
///
/// The reliability fix for UPLOAD_NEVER_STARTED on iCloud clips: the old path
/// STREAMED the iCloud asset straight to S3 on a FOREGROUND `URLSession`, which
/// iOS suspends the instant the app is backgrounded mid-transfer — so a slow
/// iCloud clip (download + upload, minutes on a weak network) never lands and the
/// worker times out waiting for a source that never arrives.
///
/// Instead we download the resource to an app-owned durable file first (iCloud
/// download is resumable and can run in the foreground), then hand that file to
/// the SAME background uploader the local-file path already uses — which survives
/// suspension AND app-kill. Trades the parallel-stream speedup for landing the
/// bytes at all, which for a multi-minute transfer is the right trade.
enum PHAssetResourceIO {
    /// Download `resource` (from iCloud if needed) into `url`, reporting 0→1
    /// progress. `url` is truncated first — writeData APPENDS, so a leftover
    /// partial from a previous attempt would corrupt the file otherwise.
    static func write(
        resource: PHAssetResource,
        to url: URL,
        onProgress: @escaping (Double) -> Void
    ) async throws {
        try? FileManager.default.removeItem(at: url)

        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true // allow the iCloud download
        options.progressHandler = { p in onProgress(p) }

        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().writeData(for: resource, toFile: url, options: options) { error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume()
                }
            }
        }
    }
}
