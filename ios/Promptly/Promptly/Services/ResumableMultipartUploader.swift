import Foundation
import UIKit

/// Item 7b — resumable S3 multipart transfer on a BACKGROUND URLSession.
///
/// The source-upload leg's resumable path. It uploads a large clip as ≥5 MiB parts
/// (SERVER_CONTRACTS_226 Contract 2) on a background session that survives suspension
/// AND app-kill, and — unlike the single-PUT path — RESUMES from the durable ledger
/// instead of restarting at byte 0. That non-resumable restart is the product's #1
/// defect by user count (24.1% completion); this fixes it.
///
/// The pure pieces (part planner, ETag ledger, reconcile state machine) live in
/// ResumableUpload.swift and are unit-tested. This file is the impure orchestration —
/// the background session, the delegate, the chunk files, the relaunch/resume loop —
/// modelled exactly on BackgroundUploadManager (stable identifier, delegate hops to
/// @MainActor, `savedCompletionHandler` for the relaunch drain). It is the piece that
/// the device-validation gate proves; it is not behaviour-tested here.
///
/// NEVER-WORSE: this is only ever ATTEMPTED behind a successful `multipartInit`. The
/// caller (uploadSourceNeverWorse) treats any init throw as "single-PUT", so multipart
/// can only match or beat 225. `enabled` is a client-side kill switch: flip it false
/// and every upload takes the single-PUT path, no code change.
/// Config for 7b multipart, in a NONISOLATED namespace so the never-worse caller
/// (`APIService.uploadSourceNeverWorse`, off the main actor) reads `threshold` /
/// `enabled` without an actor hop.
enum MultipartConfig {
    /// Files at/above this benefit from multipart (parallelism + resumability); below
    /// it single-PUT is strictly better (no init/complete roundtrips).
    static let threshold: Int64 = 30 * 1024 * 1024
    /// The presigned part URLs expire at 3600s [Contract 2]; past that, resume is
    /// impossible (the URLs are dead) so the upload is aborted + restarted fresh.
    static let resumeTTL: TimeInterval = 3600
    /// Client-side kill switch — false ⇒ the never-worse caller always uses single-PUT.
    nonisolated(unsafe) static var enabled = true
    /// Max reschedules of a single failing part before the whole transfer gives up.
    static let maxPartAttempts = 6
    /// Retries of the final `complete` call before giving up.
    static let maxCompleteAttempts = 3
}

@MainActor
final class ResumableMultipartUploader: NSObject {
    static let shared = ResumableMultipartUploader()

    let sessionIdentifier = "app.usepromptly.bg-multipart-v1"

    /// Set by PromptlyApp's handleEventsForBackgroundURLSession for THIS session id.
    var savedCompletionHandler: (() -> Void)?

    // MARK: - Persisted state

    /// Everything needed to RESUME an upload after an app-kill: the presigned part
    /// URLs (expire at resumeTTL) and the durable source file to re-chunk from.
    private struct UploadManifest: Codable {
        let uploadId: String
        let key: String
        let publicUrl: String
        let partUrls: [String]
        let sourcePath: String
        let fileSize: Int64
        let partSize: Int64
        let messageId: String
        let chatId: String?
        let createdAt: Date
    }

    /// taskId → which part it is. Persisted so a relaunch maps live session tasks back
    /// to part numbers before scheduling anything (never double-schedule, never orphan).
    private struct PartContext: Codable {
        let uploadId: String
        let partNumber: Int
        let chunkPath: String
    }

    private let ctxStoreKey = "ResumableMultipartUploader.partCtx.v1"
    private var partCtx: [Int: PartContext] = [:]
    private var partAttempts: [String: Int] = [:]     // "uploadId#part" → attempts (in-memory)
    private var taskBytes: [Int: Int64] = [:]         // taskId → bytesSent (for smooth progress)

    /// In-memory per-transfer state for the ALIVE path (lost on app-kill; the killed
    /// path finalizes via the relaunch reconcile instead).
    private struct TransferState {
        var continuation: CheckedContinuation<String, Error>?
        var onProgress: ((Double) -> Void)?
        var totalBytes: Int64
    }
    private var transfers: [String: TransferState] = [:]   // uploadId → state

    // MARK: - Session

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: sessionIdentifier)
        config.allowsCellularAccess = true
        config.allowsExpensiveNetworkAccess = true
        config.isDiscretionary = false             // user-initiated → upload ASAP
        config.sessionSendsLaunchEvents = true
        config.timeoutIntervalForResource = 30 * 60
        config.httpMaximumConnectionsPerHost = 6   // parallel parts
        return URLSession(configuration: config, delegate: MultipartUploadDelegate.shared, delegateQueue: nil)
    }()

    private var ledgerDir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("multipart-uploads", isDirectory: true)
    }

    override init() {
        super.init()
        loadPartContexts()
        _ = session   // reconnect on launch so killed-task callbacks + resume can fire
    }

    // MARK: - Alive path

    /// Transfer `fileUrl` (already init'd) to completion, returning the publicUrl.
    /// The caller awaits this; if the app is killed mid-transfer the await is lost and
    /// the relaunch reconcile finalizes the object instead (the server's 600s
    /// source-wait then finds it). Throws only on a give-up (expiry / exhausted
    /// retries) — the caller treats that as an upload failure, same as single-PUT.
    func transfer(fileUrl: URL,
                  size: Int64,
                  initResponse: APIService.MultipartInitResponse,
                  messageId: String,
                  chatId: String?,
                  onProgress: @escaping (Double) -> Void) async throws -> String {
        let partSize = MultipartChunker.chosenPartSize(fileSize: size)
        let plan = MultipartChunker.partPlan(fileSize: size, partSize: partSize)
        guard plan.count == initResponse.partUrls.count,
              MultipartChunker.partsSatisfyS3SizeRule(plan) else {
            throw APIError.uploadFailed   // shape mismatch → never-worse fallback
        }

        let manifest = UploadManifest(
            uploadId: initResponse.uploadId, key: initResponse.key, publicUrl: initResponse.publicUrl,
            partUrls: initResponse.partUrls, sourcePath: fileUrl.path,
            fileSize: size, partSize: partSize, messageId: messageId, chatId: chatId, createdAt: Date())
        saveManifest(manifest)
        let ledger = MultipartResumeLedger(uploadId: initResponse.uploadId, key: initResponse.key,
                                           publicUrl: initResponse.publicUrl, fileSize: size, partSize: partSize)
        try? ledger.save(in: ledgerDir)

        return try await withCheckedThrowingContinuation { cont in
            transfers[initResponse.uploadId] = TransferState(continuation: cont, onProgress: onProgress, totalBytes: size)
            scheduleRemaining(uploadId: initResponse.uploadId)
        }
    }

    // MARK: - Scheduling / reconcile

    /// Re-derive the remaining parts from the ledger + live tasks and schedule (or
    /// complete). Idempotent: safe to call on start, on part completion, on a part
    /// failure, and on relaunch — it never double-schedules a live or completed part.
    private func scheduleRemaining(uploadId: String) {
        guard let manifest = loadManifest(uploadId),
              let ledger = MultipartResumeLedger.load(uploadId: uploadId, in: ledgerDir) else { return }

        // Expired → the part URLs are dead; abort + give up (fall back happens upstream
        // only at init, but here the alive caller just gets an upload failure).
        if ledger.isExpired(ttl: MultipartConfig.resumeTTL, now: Date()) {
            Task { await self.giveUp(uploadId: uploadId, reason: "resume window expired") }
            return
        }

        let live = Set(partCtx.values.filter { $0.uploadId == uploadId }.map { $0.partNumber })
        let decision = ledger.reconcile(liveTaskParts: live)

        if decision.shouldComplete {
            Task { await self.finalize(uploadId: uploadId) }
            return
        }

        let plan = MultipartChunker.partPlan(fileSize: manifest.fileSize, partSize: manifest.partSize)
        for pn in decision.partsToSchedule {
            guard pn - 1 >= 0, pn - 1 < manifest.partUrls.count,
                  let range = plan.first(where: { $0.partNumber == pn }),
                  let url = URL(string: manifest.partUrls[pn - 1]) else { continue }
            let chunkURL = chunkFileURL(uploadId: uploadId, part: pn)
            do {
                try MultipartChunker.writePart(from: URL(fileURLWithPath: manifest.sourcePath), range: range, to: chunkURL)
            } catch {
                continue   // source unreadable for this part; a later reconcile retries
            }
            var req = URLRequest(url: url)
            req.httpMethod = "PUT"
            let task = session.uploadTask(with: req, fromFile: chunkURL)
            partCtx[task.taskIdentifier] = PartContext(uploadId: uploadId, partNumber: pn, chunkPath: chunkURL.path)
            persistPartContexts()
            task.resume()
        }
    }

    /// Called on app foreground AND before every new init: abort every expired upload
    /// (abandoned parts bill forever), then resume every still-live one by reconciling
    /// against the session's actual in-flight tasks before scheduling anything new.
    func resumeAndSweepOnForeground() {
        // 1) Abort + clear expired uploads.
        for stale in MultipartResumeLedger.expired(in: ledgerDir, ttl: MultipartConfig.resumeTTL, now: Date()) {
            Task { await APIService.shared.multipartAbort(key: stale.key, uploadId: stale.uploadId) }
            cleanupLocalState(uploadId: stale.uploadId)
        }
        // 2) Reconcile live uploads against the session's real tasks, THEN schedule.
        session.getAllTasks { tasks in
            Task { @MainActor in
                // Rebuild taskId→part from persisted contexts for any tasks the OS kept.
                let liveTaskIds = Set(tasks.map { $0.taskIdentifier })
                self.partCtx = self.partCtx.filter { liveTaskIds.contains($0.key) }   // drop dead task rows
                self.persistPartContexts()
                for ledger in MultipartResumeLedger.all(in: self.ledgerDir) {
                    self.scheduleRemaining(uploadId: ledger.uploadId)
                }
            }
        }
    }

    // MARK: - Completion

    private func finalize(uploadId: String) async {
        guard let ledger = MultipartResumeLedger.load(uploadId: uploadId, in: ledgerDir),
              let parts = ledger.orderedParts() else { return }
        let wire = parts.map { APIService.MultipartPart(PartNumber: $0.partNumber, ETag: $0.eTag) }
        var attempt = 0
        while attempt < MultipartConfig.maxCompleteAttempts {
            attempt += 1
            do {
                let pub = try await APIService.shared.multipartComplete(key: ledger.key, uploadId: uploadId, parts: wire)
                Analytics.track("upload_completed", props: ["path": "multipart", "parts": parts.count])
                resolveTransfer(uploadId: uploadId, result: .success(pub))
                cleanupLocalState(uploadId: uploadId)
                return
            } catch {
                if attempt >= MultipartConfig.maxCompleteAttempts {
                    await giveUp(uploadId: uploadId, reason: "complete failed")
                    return
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// Give up on a transfer: abort the S3 multipart (stop the billing), clear local
    /// state, and fail the alive caller (if any) so it surfaces like a failed upload.
    private func giveUp(uploadId: String, reason: String) async {
        let ledger = MultipartResumeLedger.load(uploadId: uploadId, in: ledgerDir)
        if let ledger {
            await APIService.shared.multipartAbort(key: ledger.key, uploadId: uploadId)
        }
        // src_key = the source object's filename, so this multipart failure joins to
        // its upload_attempt (same key → size_mb/path/parts) and to the video_jobs row
        // — the join that lets UNS band failures by size instead of leaving them keyless.
        let srcKey = ledger.map { $0.key.split(separator: "/").last.map(String.init) ?? $0.key } ?? ""
        // @MainActor class → applicationState is directly readable. Discriminates a
        // foreground give-up from a backgrounded-alive one; the terminated-relaunch
        // case surfaces on the orphan path (lifecycle:"relaunched").
        let life: String
        switch UIApplication.shared.applicationState {
        case .active: life = "foreground"
        case .background: life = "background"
        default: life = "inactive"
        }
        Analytics.track("upload_failed", props: [
            "path": "multipart",
            "mechanism": reason,
            "src_key": srcKey,
            "conn": ReachabilityMonitor.currentConnectionType,
            "lifecycle": life,
        ], durable: true)
        resolveTransfer(uploadId: uploadId, result: .failure(APIError.uploadFailed))
        cleanupLocalState(uploadId: uploadId)
    }

    private func resolveTransfer(uploadId: String, result: Result<String, Error>) {
        guard let state = transfers.removeValue(forKey: uploadId), let cont = state.continuation else {
            // No alive caller — app was killed and the relaunch reconcile finalized it.
            // The object has landed (or aborted); the server's source-wait handles the
            // job. Nothing else to do.
            return
        }
        cont.resume(with: result)
    }

    // MARK: - Delegate forwards (from MultipartUploadDelegate, on the session queue)

    fileprivate func didSendBodyData(taskId: Int, totalSent: Int64) {
        guard let ctx = partCtx[taskId] else { return }
        taskBytes[taskId] = totalSent
        guard let state = transfers[ctx.uploadId], state.totalBytes > 0,
              let ledger = MultipartResumeLedger.load(uploadId: ctx.uploadId, in: ledgerDir) else { return }
        // Aggregate = confirmed-part bytes + in-flight bytes across live tasks.
        let plan = MultipartChunker.partPlan(fileSize: ledger.fileSize, partSize: ledger.partSize)
        let doneParts = ledger.completedPartNumbers()
        let doneBytes = plan.filter { doneParts.contains($0.partNumber) }.reduce(Int64(0)) { $0 + $1.length }
        let liveTaskIds = Set(partCtx.filter { $0.value.uploadId == ctx.uploadId }.map { $0.key })
        let inflight = liveTaskIds.reduce(Int64(0)) { $0 + (taskBytes[$1] ?? 0) }
        let progress = min(1.0, Double(doneBytes + inflight) / Double(state.totalBytes))
        state.onProgress?(progress)
    }

    fileprivate func didComplete(taskId: Int, response: URLResponse?, error: Error?) {
        guard let ctx = partCtx.removeValue(forKey: taskId) else { return }
        persistPartContexts()
        taskBytes.removeValue(forKey: taskId)
        let http = response as? HTTPURLResponse
        // ETag header (S3 casing is "ETag"; be tolerant).
        let etag = http?.value(forHTTPHeaderField: "Etag") ?? http?.value(forHTTPHeaderField: "ETag")
        let ok = error == nil && (http.map { (200...299).contains($0.statusCode) } ?? false)
            && !(etag ?? "").isEmpty

        if ok, let etag, var ledger = MultipartResumeLedger.load(uploadId: ctx.uploadId, in: ledgerDir) {
            ledger.record(partNumber: ctx.partNumber, eTag: etag)   // verbatim, quotes included
            try? ledger.save(in: ledgerDir)
            try? FileManager.default.removeItem(atPath: ctx.chunkPath)
            partAttempts["\(ctx.uploadId)#\(ctx.partNumber)"] = nil
            if ledger.isComplete {
                Task { await self.finalize(uploadId: ctx.uploadId) }
            } else {
                scheduleRemaining(uploadId: ctx.uploadId)   // keep the pipeline full
            }
        } else {
            // Part failed — the chunk stays absent (re-chunked on reschedule). Retry the
            // part up to the cap; UploadPart is idempotent so a re-PUT is always safe.
            try? FileManager.default.removeItem(atPath: ctx.chunkPath)
            let k = "\(ctx.uploadId)#\(ctx.partNumber)"
            let n = (partAttempts[k] ?? 0) + 1
            partAttempts[k] = n
            if n >= MultipartConfig.maxPartAttempts {
                Task { await self.giveUp(uploadId: ctx.uploadId, reason: "part \(ctx.partNumber) exhausted") }
            } else {
                scheduleRemaining(uploadId: ctx.uploadId)
            }
        }
    }

    fileprivate func didFinishEvents() {
        let handler = savedCompletionHandler
        savedCompletionHandler = nil
        handler?()
    }

    // MARK: - Local state helpers

    private func chunkFileURL(uploadId: String, part: Int) -> URL {
        let dir = ledgerDir.appendingPathComponent("chunks", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(uploadId)-part-\(part).bin")
    }

    private func manifestURL(_ uploadId: String) -> URL {
        ledgerDir.appendingPathComponent("manifest-\(uploadId).json")
    }
    private func saveManifest(_ m: UploadManifest) {
        try? FileManager.default.createDirectory(at: ledgerDir, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(m) { try? data.write(to: manifestURL(m.uploadId), options: .atomic) }
    }
    private func loadManifest(_ uploadId: String) -> UploadManifest? {
        guard let data = try? Data(contentsOf: manifestURL(uploadId)) else { return nil }
        return try? JSONDecoder().decode(UploadManifest.self, from: data)
    }

    /// Remove every local trace of an upload (ledger, manifest, chunks, task rows).
    private func cleanupLocalState(uploadId: String) {
        MultipartResumeLedger.clear(uploadId: uploadId, in: ledgerDir)
        try? FileManager.default.removeItem(at: manifestURL(uploadId))
        for (tid, c) in partCtx where c.uploadId == uploadId {
            try? FileManager.default.removeItem(atPath: c.chunkPath)
            partCtx.removeValue(forKey: tid)
        }
        persistPartContexts()
        partAttempts = partAttempts.filter { !$0.key.hasPrefix("\(uploadId)#") }
    }

    private func persistPartContexts() {
        if let data = try? JSONEncoder().encode(partCtx) {
            UserDefaults.standard.set(data, forKey: ctxStoreKey)
        }
    }
    private func loadPartContexts() {
        guard let data = UserDefaults.standard.data(forKey: ctxStoreKey),
              let map = try? JSONDecoder().decode([Int: PartContext].self, from: data) else { return }
        partCtx = map
    }
}

/// Plain NSObject delegate — background URLSession requires one. Routes every
/// callback back to the @MainActor uploader so its state stays MainActor-isolated
/// (identical pattern to BackgroundUploadDelegate).
private final class MultipartUploadDelegate: NSObject, URLSessionTaskDelegate {
    static let shared = MultipartUploadDelegate()

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        let taskId = task.taskIdentifier
        Task { @MainActor in ResumableMultipartUploader.shared.didSendBodyData(taskId: taskId, totalSent: totalBytesSent) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let taskId = task.taskIdentifier
        let response = task.response
        Task { @MainActor in ResumableMultipartUploader.shared.didComplete(taskId: taskId, response: response, error: error) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor in ResumableMultipartUploader.shared.didFinishEvents() }
    }
}
