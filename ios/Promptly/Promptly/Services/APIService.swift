import Foundation
import Photos

class APIService {
    static let shared = APIService()
    private let baseUrl = "https://usepromptly.app"

    private init() {}

    /// Single long-lived URLSession shared across ALL S3 uploads — single
    /// PUT and every multipart part. One warm connection pool, no per-request
    /// TLS handshake, no per-request TCP slow-start. HTTP/2 multiplexing +
    /// connection reuse here beats spraying ephemeral sessions across parts
    /// (which was build 62's regression — each fresh session paid its own
    /// handshake + slow-start tax, tanking aggregate throughput).
    lazy var s3UploadSession: URLSession = {
        let config = URLSessionConfiguration.default
        // timeoutIntervalForRequest is the STALL timeout (no bytes flowing
        // for X seconds → fail). 30s is plenty for any healthy connection
        // — bytes flow continuously even on slow 3G. Was 120s, which made
        // a stalled chunk take 240s+ to fail (2 retries × 120s).
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 600
        config.waitsForConnectivity = true
        config.allowsCellularAccess = true
        config.allowsExpensiveNetworkAccess = true
        config.httpMaximumConnectionsPerHost = 6  // iOS default; lets parallel parts open new TCPs when beneficial
        return URLSession(configuration: config)
    }()

    /// Dedicated session for our own API server (everything not S3).
    /// `waitsForConnectivity = true` means a request fired during a
    /// momentary blip queues until the network is back instead of
    /// failing fast — which is what URLSession.shared would do.
    /// Combined with `requestData()` retry-on-transient, server calls
    /// survive connection drops, brief Wi-Fi-to-cellular handoffs,
    /// and stale HTTP/2 connections that the server has already closed.
    lazy var apiSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        config.waitsForConnectivity = true
        config.allowsCellularAccess = true
        config.allowsExpensiveNetworkAccess = true
        return URLSession(configuration: config)
    }()

    /// Send a request with retry on transient network errors. Retries
    /// up to twice with backoff (1s, 3s) on:
    ///   -1001 NSURLErrorTimedOut         — request didn't complete in time
    ///   -1005 NSURLErrorNetworkConnectionLost — established TCP dropped
    ///   -1009 NSURLErrorNotConnectedToInternet — momentary offline
    /// All three are recoverable: -1005 most often happens because the
    /// server closed an idle HTTP/2 connection that URLSession was about
    /// to reuse — the next attempt opens a fresh connection and works.
    /// Non-transient errors (4xx response, malformed URL) throw immediately.
    func requestData(_ request: URLRequest, retries: Int = 2) async throws -> (Data, URLResponse) {
        let transientCodes: Set<Int> = [
            NSURLErrorTimedOut,
            NSURLErrorNetworkConnectionLost,
            NSURLErrorNotConnectedToInternet,
        ]
        var attempt = 0
        while true {
            do {
                return try await apiSession.data(for: request)
            } catch let error as URLError where transientCodes.contains(error.code.rawValue) {
                attempt += 1
                if attempt > retries {
                    print("[apiSession] giving up after \(attempt) attempts: \(error.code.rawValue)")
                    throw error
                }
                let delaySec: UInt64 = attempt == 1 ? 1 : 3
                print("[apiSession] transient error \(error.code.rawValue), retrying in \(delaySec)s (attempt \(attempt + 1))")
                try? await Task.sleep(nanoseconds: delaySec * 1_000_000_000)
            }
        }
    }

    /// Get a valid token, auto-refreshing if expired
    private func validToken() async -> String? {
        await AuthService.shared.getValidToken()
    }

    /// Central wall detector: a 403 body of `{error:"wall_required"}` from any
    /// gated door throws `APIError.wallRequired`, so every call site routes the
    /// same way (to the trial wall) without repeating the parse. Inert while
    /// the server knob is off — the server never emits this until the flip.
    static func throwIfWall(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse, http.statusCode == 403 else { return }
        struct WallBody: Decodable { let error: String?; let route: String?; let message: String? }
        guard let body = try? JSONDecoder().decode(WallBody.self, from: data),
              body.error == "wall_required" || body.route == "wall" else { return }
        throw APIError.wallRequired(message: body.message ?? "Upgrade to keep creating.")
    }

    /// Central 402 detector for the UPLOAD doors (upload-url / multipart-init).
    /// A free user's 2nd concurrent upload is denied ACCOUNT-GLOBALLY by the
    /// server with a 402 — parse it into `paymentRequired` so the caller routes
    /// to the upgrade paywall instead of a generic "upload failed". Without this
    /// the 402 body would fail to decode as the success type and surface as a
    /// bare uploadFailed — a silent block, which is exactly what we must avoid.
    static func throwIfPaymentRequired(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse, http.statusCode == 402 else { return }
        struct LimitBody: Decodable { let kind: String?; let limit: Int?; let message: String?; let error: String? }
        let body = try? JSONDecoder().decode(LimitBody.self, from: data)
        throw APIError.paymentRequired(
            kind: body?.kind ?? "concurrency_free",
            limit: body?.limit,
            message: body?.message ?? "Free accounts can process 1 video at a time. Upgrade to Pro for 10 in parallel."
        )
    }

    private func authorizedRequest(_ path: String, method: String = "GET") async -> URLRequest {
        var request = URLRequest(url: URL(string: "\(baseUrl)\(path)")!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        WallCapability.stamp(&request)
        // Build stamp on EVERY authed request (job creation included), so the
        // server can bucket outcomes by build — the difference between "the fix
        // works, users haven't updated" and "the fix is broken", which is
        // otherwise unanswerable. Matches Analytics' "v (b)" format so job rows
        // and analytics_events read the same. One header, one choke point.
        request.setValue(Self.appVersionHeader, forHTTPHeaderField: "X-App-Version")
        if let token = await validToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    /// Short version + build, e.g. "1.3.6 (224)". Same shape Analytics uses so a
    /// job's app_version and its events line up. Falls back to "?" so a malformed
    /// Info.plist never crashes request construction.
    static let appVersionHeader: String = {
        let info = Bundle.main.infoDictionary
        let v = info?["CFBundleShortVersionString"] as? String ?? "?"
        let b = info?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }()

    // MARK: - Validation (Layer 2)

    /// POST a S3 sample URL to the Modal /validate endpoint and parse
    /// the talking-head verdict. Used inside the upload Task BEFORE
    /// committing to the full source upload, so an incompatible clip
    /// is caught in 5-9s instead of 30-60s into a doomed render.
    ///
    /// The endpoint is a public Modal URL (no auth header required).
    /// 30s timeout because cold Modal container starts can land in
    /// the 5-10s range and we'd rather wait than blow past the timeout.
    func validateVideo(sampleS3Url: String) async throws -> ValidationResponse {
        // Modal hash-suffixed URL. The "obvious" name
        // promptlyvalidator-validate.modal.run is 64 chars in the subdomain
        // label — one over the RFC 1035 63-octet limit — and fails DNS
        // resolution instantly. Modal auto-truncates to a hash suffix when
        // the natural name would be too long; the displayed URL in the
        // deploy log is the authoritative one. The hash is stable per
        // (app + class + method) so it survives re-deploys. If we ever
        // rename PromptlyValidator.validate or move it to a different
        // app, this URL has to be updated to match the new deploy log.
        guard let url = URL(string: "https://reallyhimbrodigy--promptly-gpu-worker-promptlyvalidator--3ad3a2.modal.run") else {
            throw APIError.uploadFailed
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        request.httpBody = try JSONEncoder().encode(["sample_url": sampleS3Url])

        let (data, response) = try await requestData(request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIError.jobCreationFailed("validate HTTP \(status)")
        }
        return try JSONDecoder().decode(ValidationResponse.self, from: data)
    }

    // MARK: - Video Jobs

    func createVideoJob(videoUrl: String, proxyVideoUrl: String? = nil, vibe: String, premiumPipeline: Bool = false, clientJobId: String? = nil, sourceType: String? = nil, sourceDuration: Double? = nil) async throws -> String {
        var request = await authorizedRequest("/api/video-jobs", method: "POST")
        // Typed body so we can send the boolean `premium_pipeline_enabled`
        // routing flag (Lumen). Synthesized Encodable uses encodeIfPresent for
        // optionals, so a nil field is OMITTED from the JSON — proxy_video_url
        // when absent, and premium_pipeline_enabled when false (backend defaults
        // off). `model` is informational (aids worker [model] logging); the
        // server re-derives the authoritative routing decision from entitlement.
        struct Body: Encodable {
            let video_url: String
            let vibe_input: String
            let proxy_video_url: String?
            let model: String
            let premium_pipeline_enabled: Bool?
            // Idempotency keystone: the client-minted job UUID. The server
            // inserts under this id; a double-submit replays the existing
            // job (one job, one charge) instead of minting a duplicate.
            let client_job_id: String?
            // §5 progressive playback CAPABILITY. This 1.3.3 build can consume a
            // partial HLS preview (start playing mid-render, swap to the final MP4),
            // so it advertises the capability PER DISPATCH. The worker publishes a
            // preview ONLY for jobs that carry this flag — so the 1.3.2 majority (no
            // flag) never pays a preview encode. The global progressive_playback_enabled
            // stays as the kill switch ON TOP (worker + client both gate on it).
            let supports_progressive: Bool?
            // Instrumentation (224): source provenance for measuring the iCloud
            // reliability fix + deconfounding wait-time. Optional → omitted when nil.
            let source_type: String?
            let source_duration: Double?
        }
        let body = Body(
            video_url: videoUrl,
            vibe_input: vibe,
            proxy_video_url: (proxyVideoUrl?.isEmpty == false) ? proxyVideoUrl : nil,
            model: premiumPipeline ? "lumen" : "flare",
            premium_pipeline_enabled: premiumPipeline ? true : nil,
            client_job_id: clientJobId,
            supports_progressive: true,
            source_type: sourceType,
            source_duration: sourceDuration
        )
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await requestData(request)
        try Self.throwIfWall(response, data)
        if let http = response as? HTTPURLResponse, http.statusCode == 402 {
            // Daily render cap hit. Parse the structured payload so the
            // caller can present the right paywall reason copy.
            struct LimitPayload: Decodable {
                let kind: String?
                let limit: Int?
                let message: String?
                let error: String?
            }
            let payload = try? JSONDecoder().decode(LimitPayload.self, from: data)
            throw APIError.paymentRequired(
                kind: payload?.kind ?? "render",
                limit: payload?.limit,
                message: payload?.message ?? "Daily limit reached. Upgrade to Pro for unlimited."
            )
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            // Render-endpoint structured failure: when the backend
            // returns error_code + user_message + the routing flags,
            // surface them as APIError.structuredFailure so the UI
            // can branch (requires_new_video → video picker, etc).
            // Falls through to the legacy jobCreationFailed shape if
            // the structured fields aren't present.
            if let payload = try? JSONDecoder().decode(StructuredErrorPayload.self, from: data),
               payload.errorCode != nil || payload.userMessage != nil {
                throw APIError.structuredFailure(
                    errorCode: payload.errorCode,
                    userMessage: payload.userMessage ?? payload.error ?? "Something went wrong.",
                    retryable: payload.retryable ?? false,
                    requiresNewVideo: payload.requiresNewVideo ?? false,
                    requiresVibeChange: payload.requiresVibeChange ?? false
                )
            }
            let body = try? JSONDecoder().decode(JobCreateResponse.self, from: data)
            throw APIError.jobCreationFailed(body?.error ?? "Unknown error")
        }

        let result = try JSONDecoder().decode(JobCreateResponse.self, from: data)
        guard let jobId = result.resolvedJobId else {
            throw APIError.jobCreationFailed("No job ID returned")
        }
        return jobId
    }

    /// Fire-and-forget: tell the backend a video has been uploaded and ready
    /// for pre-processing. The server forwards to Modal's /prewarm endpoint
    /// which downloads the source into its persistent cache volume — so when
    /// the real render job fires later, the "Loading your footage" step is
    /// a no-op cache hit. Non-blocking: errors are logged and swallowed.
    ///
    /// Retries once after 2s on transient network failure. Cellular upload
    /// paths drop requests silently more often than people realize, and
    /// losing the prewarm silently means the user gets the slow path with
    /// no trace. Server-side idempotency via the in-flight registry handles
    /// duplicate firing if both succeed.
    func prewarmRender(videoUrl: String) async {
        var lastError: Error?
        for attempt in 0..<2 {
            do {
                var request = await authorizedRequest("/api/prewarm", method: "POST")
                request.httpBody = try JSONEncoder().encode(["video_url": videoUrl])
                request.timeoutInterval = 5
                let (_, response) = try await requestData(request)
                if let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) {
                    print("[prewarm] dispatched (attempt \(attempt + 1))")
                    return
                }
                // Non-2xx — treat as failure, retry once
                lastError = NSError(domain: "prewarm", code: (response as? HTTPURLResponse)?.statusCode ?? -1)
            } catch {
                lastError = error
            }
            if attempt == 0 {
                try? await Task.sleep(nanoseconds: 2_000_000_000)  // 2s backoff
            }
        }
        print("[prewarm] dispatch failed after retry (non-fatal): \(lastError?.localizedDescription ?? "unknown")")
    }

    /// Fire-and-forget GPU render-container warmup. Hits Modal's warmup web
    /// endpoint directly (no auth, body `{}`), which spins up the heavy GPU
    /// render container + CUDA init and keeps it warm for ~3 min. Firing this
    /// the moment an upload begins means the container is already hot by the
    /// time we submit the render job, so the pipeline starts with no 15-30s
    /// cold start. This is the GPU-render counterpart to `prewarmRender`,
    /// which warms the CPU pre-processing (S3 download + transcript).
    ///
    /// Best-effort by contract: idempotent (calling again just keeps it warm),
    /// never awaited in a way that blocks the upload/UI, and ALL errors are
    /// swallowed — a failed warmup simply means we fall back to the cold-start
    /// path. Short timeout because we only care about the side effect (starting
    /// the container), never the response.
    func warmupRenderContainer() async {
        guard let url = URL(string: "https://reallyhimbrodigy--promptly-gpu-worker-promptlyworker-warmup.modal.run") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        request.timeoutInterval = 3
        do {
            _ = try await URLSession.shared.data(for: request)
            print("[warmup] GPU render container warmup dispatched")
        } catch {
            print("[warmup] dispatch failed (non-fatal): \(error.localizedDescription)")
        }
    }

    // MARK: - Export gate (225 item 3)

    /// The one correct action for an export attempt. Dark-safe: while the server
    /// export gate is off it returns 501 (or the alias route 404s) → .legacyPublicSaveOK,
    /// so 225 saves behave exactly like 224 today. When the gate flips on: 200 = a
    /// signed, possibly-watermarked private asset; 402 = out of free exports → the
    /// upgrade paywall, NEVER a silent public save; 404 no_private_asset = an old job
    /// with no private asset, the ONLY case a public save is still correct.
    enum ExportOutcome {
        case gated(url: URL, watermarked: Bool)                             // 200
        case legacyPublicSaveOK                                             // 404 (no_private_asset / route-dark) or 501 gate-dark
        case paymentRequired(freeExportsUsed: Int?, freeExportLimit: Int?)  // 402
    }

    /// POST /api/jobs/{id}/export with the Supabase bearer. Throws URLError on a
    /// network failure — the caller shows a retry, NEVER a silent public save —
    /// and APIError on an unexpected status.
    func exportJob(jobId: String) async throws -> ExportOutcome {
        var request = await authorizedRequest("/api/jobs/\(jobId)/export", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        let (data, response) = try await requestData(request)
        guard let http = response as? HTTPURLResponse else { throw APIError.uploadFailed }
        switch http.statusCode {
        case 200:
            struct R: Decodable { let url: String; let watermarked: Bool? }
            let r = try JSONDecoder().decode(R.self, from: data)
            guard let u = URL(string: r.url) else { throw APIError.jobCreationFailed("Bad export URL") }
            return .gated(url: u, watermarked: r.watermarked ?? false)
        case 402:
            struct P: Decodable { let free_exports_used: Int?; let free_export_limit: Int? }
            let p = try? JSONDecoder().decode(P.self, from: data)
            return .paymentRequired(freeExportsUsed: p?.free_exports_used, freeExportLimit: p?.free_export_limit)
        case 404, 501:
            return .legacyPublicSaveOK
        default:
            throw APIError.jobCreationFailed("Export failed (\(http.statusCode))")
        }
    }

    /// POST /api/jobs/{id}/export {"gate_probe": true} — the export gate's DRY RUN.
    /// It is evaluated BEFORE the 501 [SERVER_CONTRACTS_226], so it answers while
    /// `EXPORT_GATE_ENABLED` is still dark — which is what makes the paywall branch
    /// verifiable today, zero flips. Network / any failure → `.indeterminate` so
    /// verification never blocks. This NEVER gates a real export (see ExportGateDecision):
    /// the shipping paywall is driven by the real 402 from `exportJob`, post-flip.
    func gateProbe(jobId: String) async -> ExportGateDecision {
        var request = await authorizedRequest("/api/jobs/\(jobId)/export", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{\"gate_probe\":true}".utf8)
        guard let (data, response) = try? await requestData(request),
              let http = response as? HTTPURLResponse else { return .indeterminate(status: -1) }
        return ExportGateDecision.from(status: http.statusCode, body: data)
    }

    // MARK: - Chat action router (226 item 1)

    /// The server's converse-vs-act decision for one chat turn. `.notFound` is the
    /// dark-flag fallback: while PROMPTLY_CHAT_ACTIONS is off the endpoint 404s and
    /// the caller runs TODAY's client router unchanged.
    enum ChatActionResult {
        case converse                                        // just talk → /api/chat/stream as today
        case status(String)                                  // deterministic status text
        case clarify(String)                                 // ask-back text
        case renderDispatched(jobId: String, message: String?)
        case reeditDispatched(jobId: String, message: String?)
        case refusal(status: Int)                            // 402/429/503 → composer refusal
        case notFound                                        // 404 → today's client router (dark)
    }

    /// POST /api/chat/actions — one server call decides converse vs act. The server
    /// parses intent (never the client) and, for an act_render, self-forwards to
    /// /api/video-jobs verbatim with the SAME `video_url` the composer uses
    /// [SERVER_CONTRACTS_226 Contract 1].
    ///
    /// URL-IMMEDIATE: pass the presigned `videoUrl` the MOMENT it exists — do NOT
    /// wait for the bytes. Both upload endpoints return the URL before a byte moves,
    /// and dispatch waits server-side up to 600s for the object with no Modal
    /// container running [Contract 1(a)]. Network/other errors map to `.notFound` so
    /// the caller safely falls back to today's router.
    ///
    /// The caller MUST enforce: an attachment ⇒ a non-empty `videoUrl` here. A video
    /// intent sent without its URL is misclassified as a re-edit of the user's OLD
    /// job [Contract 1(b) trap] — that guard lives at the send site, not here.
    func chatActions(message: String, videoUrl: String? = nil, proxyVideoUrl: String? = nil) async throws -> ChatActionResult {
        var request = await authorizedRequest("/api/chat/actions", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["message": message]
        if let videoUrl { body["video_url"] = videoUrl }
        if let proxyVideoUrl { body["proxy_video_url"] = proxyVideoUrl }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await requestData(request)
        guard let http = response as? HTTPURLResponse else { return .notFound }
        switch http.statusCode {
        case 404:                return .notFound
        case 402, 429, 503:      return .refusal(status: http.statusCode)
        case 200:
            // The server lifts job_id from `job_id || id || job.id`, but the
            // render_dispatched shape documents `job_id` as `<uuid|null>` with the
            // real id also under `job.job_id` — so fall back to the nested field.
            struct JobEnvelope: Decodable { let job_id: String? }
            struct R: Decodable { let action: String; let message: String?; let job_id: String?; let job: JobEnvelope? }
            guard let r = try? JSONDecoder().decode(R.self, from: data) else { return .converse }
            let jid = (r.job_id?.isEmpty == false ? r.job_id : nil) ?? r.job?.job_id ?? ""
            switch r.action {
            case "converse":          return .converse
            case "status":            return .status(r.message ?? "")
            case "clarify":           return .clarify(r.message ?? "")
            case "render_dispatched": return .renderDispatched(jobId: jid, message: r.message)
            case "reedit_dispatched": return .reeditDispatched(jobId: jid, message: r.message)
            default:                  return .converse   // unknown → safe default
            }
        default:                 throw APIError.jobCreationFailed("chat/actions \(http.statusCode)")
        }
    }

    /// Kick off a re-edit derived from an existing completed job. Server loads
    /// the original job's saved edit_recipe + transcript + analysis + resolved
    /// B-roll and routes through Modal in either tweak or reinterpret mode.
    /// Returns the new job id; progress is watched via SSE just like a fresh edit.
    func reeditFromJob(originalJobId: String, changeRequest: String) async throws -> String {
        var request = await authorizedRequest("/api/video-jobs/re-edit", method: "POST")
        request.httpBody = try JSONEncoder().encode([
            "original_job_id": originalJobId,
            "change_request": changeRequest,
        ])

        let (data, response) = try await requestData(request)
        try Self.throwIfWall(response, data)
        if let http = response as? HTTPURLResponse, http.statusCode == 402 {
            // Pro-only endpoint. Caller catches APIError.paymentRequired
            // and pops the paywall.
            struct LimitPayload: Decodable {
                let kind: String?
                let limit: Int?
                let message: String?
            }
            let payload = try? JSONDecoder().decode(LimitPayload.self, from: data)
            throw APIError.paymentRequired(
                kind: payload?.kind ?? "reedit",
                limit: payload?.limit,
                message: payload?.message ?? "Re-edit is a Pro feature."
            )
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let body = try? JSONDecoder().decode(JobCreateResponse.self, from: data)
            throw APIError.jobCreationFailed(body?.error ?? "Re-edit failed")
        }

        let result = try JSONDecoder().decode(JobCreateResponse.self, from: data)
        guard let jobId = result.resolvedJobId else {
            throw APIError.jobCreationFailed("No job ID returned")
        }
        return jobId
    }

    /// Submit a Phase D ask-back answer on the re-edit rail — resumes the parked
    /// job in place. A 404/409/403 means the job is no longer awaiting THIS input
    /// (already resumed, self-completed on timeout, double-answered, or a stale
    /// ask) — a SAFE no-op the caller absorbs by letting the poll refresh the
    /// bubble to its real state. Only genuine failures (400 validation, 5xx,
    /// network) throw, so the ask card can show an error and stay for a retry.
    enum AnswerAskResult { case resumed, alreadyHandled }
    func answerAsk(originalJobId: String, askId: String, answer: AskAnswer) async throws -> AnswerAskResult {
        var request = await authorizedRequest("/api/video-jobs/re-edit", method: "POST")
        request.httpBody = try JSONEncoder().encode(answer.requestBody(originalJobId: originalJobId, askId: askId))

        let (data, response) = try await requestData(request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.jobCreationFailed("The server did not answer. Check your connection and try again.")
        }
        if http.statusCode == 200 { return .resumed }
        if [403, 404, 409].contains(http.statusCode) { return .alreadyHandled }
        let msg = (try? JSONDecoder().decode(JobCreateResponse.self, from: data))?.error
        throw APIError.jobCreationFailed(msg ?? "Couldn't send your answer")
    }

    /// Ask the server for fresh signed URLs for a job. Used when the
    /// client detects a 403/expired video or thumbnail URL — the server
    /// has the underlying S3 keys and can re-sign for another 7 days.
    /// Returns nil on auth/permission/network failure; the caller is
    /// expected to leave the existing (broken) URL in place and just
    /// show the placeholder.
    struct RefreshUrlsResponse: Codable {
        let videoUrl: String?
        let thumbnailUrl: String?
    }

    func refreshUrls(jobId: String) async -> RefreshUrlsResponse? {
        do {
            let request = await authorizedRequest("/api/video-jobs/\(jobId)/refresh-urls", method: "POST")
            let (data, resp) = try await requestData(request)
            guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                print("[refresh] failed status=\((resp as? HTTPURLResponse)?.statusCode ?? -1)")
                return nil
            }
            return try JSONDecoder().decode(RefreshUrlsResponse.self, from: data)
        } catch {
            print("[refresh] error: \(error.localizedDescription)")
            return nil
        }
    }

    /// Cancel an in-progress render. Owner-only + idempotent on the server; a
    /// finished render is a server-side no-op (no refund). Best-effort — the UI
    /// already removed the bubble optimistically, so failures here are just
    /// logged (the worker's before-render cancel check is the real safeguard).
    func cancelRender(jobId: String) async throws {
        let request = await authorizedRequest("/api/video-jobs/\(jobId)/cancel", method: "POST")
        let (_, resp) = try await requestData(request)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if !(200...299).contains(code) {
            print("[cancel] server cancel non-2xx status=\(code) job=\(jobId)")
        }
    }

    func getUserEdits() async throws -> [VideoJob] {
        guard let userId = AuthService.shared.currentUser?.id,
              let token = await validToken() else {
            print("[library] getUserEdits skipped — no userId or token (userId=\(AuthService.shared.currentUser?.id ?? "nil"))")
            throw APIError.notAuthenticated
        }
        print("[library] getUserEdits fetching for user_id=\(userId)")

        let supabaseUrl = "https://ejxkzsfruykvgeouymfy.supabase.co"
        let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE"

        // Canonical vocab (post-migration): completed / processing / queued /
        // failed / needs_input. 'canceled' is omitted on purpose — a canceled
        // render shouldn't appear in the library.
        let urlStr = "\(supabaseUrl)/rest/v1/video_jobs?user_id=eq.\(userId)&status=in.(completed,processing,queued,failed,needs_input)&order=created_at.desc&select=id,status,vibe_input,rendered_video_url,hls_manifest_url,thumbnail_url,created_at,error_message"
        var request = URLRequest(url: URL(string: urlStr)!)
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await requestData(request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            let body = String(data: data, encoding: .utf8)?.prefix(300) ?? ""
            print("[library] getUserEdits HTTP \(http.statusCode) for user_id=\(userId) — body=\(body)")
            throw APIError.jobCreationFailed("library HTTP \(http.statusCode)")
        }
        let result = try JSONDecoder().decode([VideoJob].self, from: data)
        if result.isEmpty {
            // Either the user genuinely has no edits OR a server-side RLS
            // policy is filtering them out. Dump the raw body so the user
            // can confirm the empty array isn't from a misdecoded shape.
            let body = String(data: data, encoding: .utf8)?.prefix(120) ?? ""
            print("[library] getUserEdits 0 rows for user_id=\(userId) — body=\(body)")
        } else {
            print("[library] getUserEdits returned \(result.count) rows for user_id=\(userId)")
        }
        return result
    }

    // `deleteEdit(id:)` was removed with the Library — it was the Library's
    // bulk-delete call and had no other caller. A chat is the permanent home of its
    // video now; there is no "delete this video from a grid" affordance.

    // MARK: - Account

    /// Permanent account deletion. Apple Guideline 5.1.1(v) requires this
    /// be available in-app for any account-creating app. Server deletes
    /// every video_job + chat + usage_event + profile row owned by this
    /// user, removes the auth.users record, and best-effort-purges every
    /// S3 object referenced by the deleted jobs. Once this returns 200 the
    /// caller MUST sign out — the access token is now revoked.
    func deleteAccount() async throws {
        let request = await authorizedRequest("/api/account/delete", method: "POST")
        let (_, response) = try await requestData(request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIError.deleteFailed
        }
    }

    // MARK: - Upload

    func getUploadUrl(fileName: String) async throws -> UploadUrlResponse {
        var request = await authorizedRequest("/api/upload-url", method: "POST")
        request.httpBody = try JSONEncoder().encode(["fileName": fileName])

        let (data, response) = try await requestData(request)
        try Self.throwIfWall(response, data)
        try Self.throwIfPaymentRequired(response, data) // 2nd concurrent upload → paywall
        return try JSONDecoder().decode(UploadUrlResponse.self, from: data)
    }

    func uploadToS3(url: String, data videoData: Data, mimeType: String) async throws {
        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = "PUT"
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        request.httpBody = videoData

        let (_, response) = try await requestData(request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIError.uploadFailed
        }
    }

    /// Upload directly from a file URL with progress tracking.
    ///
    /// Routes through `BackgroundUploadManager` — a real background
    /// URLSession that survives app suspension AND app kill. iOS
    /// relaunches the process in the background to deliver the final
    /// callback when the upload completes (`handleEventsForBackground-
    /// URLSession` wired in PromptlyApp.swift).
    ///
    /// The previous build-94 attempt failed because the file URL passed
    /// in was a Photos-library URL that `nsurlsessiond` couldn't read.
    /// This path now requires the caller to materialize the file inside
    /// `NSTemporaryDirectory()` first (VideoCompressor + VideoProxy-
    /// Extractor both already do this; the no-compression branch of
    /// handlePickedVideos copies the source there before calling us).
    func uploadFileToS3(
        url: String,
        fileUrl: URL,
        mimeType: String,
        messageId: String? = nil,
        chatId: String? = nil,
        publicUrl: String? = nil,
        onProgress: ((Double) -> Void)? = nil
    ) async throws {
        let size = (try? FileManager.default.attributesOfItem(atPath: fileUrl.path)[.size] as? Int64) ?? 0
        let host = URL(string: url)?.host ?? "unknown"
        print("[perf] upload path=bg-single fileSize=\(size) endpoint=\(host)")

        await MainActor.run { VideoCache.shared.setUserUploadActive(true) }
        defer {
            Task { @MainActor in VideoCache.shared.setUserUploadActive(false) }
        }

        guard let remoteUrl = URL(string: url) else { throw APIError.uploadFailed }
        let pub = publicUrl ?? remoteUrl.absoluteString.components(separatedBy: "?").first ?? remoteUrl.absoluteString
        let msgId = messageId ?? UUID().uuidString

        // 225 item 7: emit upload_attempt at the START of the transfer — before it
        // can die — so the failing (never-settled) population has a SIZE to band by.
        // The event is allowlisted server-side and has had ZERO emitters, so nobody
        // can currently answer "big files or slow networks?". size_mb + path + a
        // join key (the source object key, which the job row also carries).
        Analytics.track("upload_attempt", props: [
            "size_mb": (Double(size) / 1_048_576.0 * 10).rounded() / 10,
            "path": "bg-single",
            "src_key": URL(string: pub)?.lastPathComponent ?? "",
        ])

        let uploadStart = Date()
        _ = try await BackgroundUploadManager.shared.upload(
            fileUrl: fileUrl,
            toRemote: remoteUrl,
            mimeType: mimeType,
            messageId: msgId,
            chatId: chatId,
            publicUrl: pub,
            onProgress: { p in onProgress?(p) }
        )
        let elapsed = Date().timeIntervalSince(uploadStart)
        let mbps = (Double(size) / 1_048_576.0) / max(elapsed, 0.001) * 8
        print(String(format: "[perf] upload bg-single success elapsed=%.2fs throughput=%.1fMbps", elapsed, mbps))
    }

    /// Source-leg upload with the NEVER-WORSE guarantee (226 item 7b). Tries the
    /// resumable multipart transfer on a background URLSession; ANY init failure
    /// (404 / 5xx / network / timeout, the kill switch, or a sub-threshold file) falls
    /// to the single-PUT path — byte-for-byte the 225 upload. Multipart is only ever
    /// ATTEMPTED behind a successful `multipartInit`, so it can only match or beat 225.
    ///
    /// `onPublicUrlResolved` fires the MOMENT the url is known — the multipart publicUrl
    /// (from init, before a byte moves) or the single-PUT one — so the URL-immediate
    /// chat/render dispatch never waits for the bytes. The single-PUT branch emits its
    /// own `upload_attempt` (path="bg-single"); the multipart branch emits path="multipart".
    @discardableResult
    func uploadSourceNeverWorse(
        fileUrl: URL,
        fileName: String,
        singlePutUrl: String,
        singlePutPublicUrl: String,
        messageId: String,
        chatId: String?,
        onPublicUrlResolved: @escaping (String) -> Void,
        onProgress: @escaping (Double) -> Void
    ) async throws -> String {
        let size = (try? FileManager.default.attributesOfItem(atPath: fileUrl.path)[.size] as? Int64) ?? 0

        // Resumable multipart — only above the threshold and only if init succeeds.
        // `multipartInit` throwing is the never-worse hinge → single-PUT below.
        if MultipartConfig.enabled, size >= MultipartConfig.threshold {
            // Law 3: sweep-and-abort stale uploads before every new init.
            await ResumableMultipartUploader.shared.resumeAndSweepOnForeground()
            let partSize = MultipartChunker.chosenPartSize(fileSize: size)
            let partCount = MultipartChunker.partCount(fileSize: size, partSize: partSize)
            if let initResp = try? await multipartInit(fileName: fileName, partCount: partCount) {
                onPublicUrlResolved(initResp.publicUrl)   // URL-immediate: the multipart publicUrl
                Analytics.track("upload_attempt", props: [
                    "size_mb": (Double(size) / 1_048_576.0 * 10).rounded() / 10,
                    "path": "multipart",
                    "src_key": URL(string: initResp.publicUrl)?.lastPathComponent ?? "",
                    "parts": partCount,
                ])
                if (try? await ResumableMultipartUploader.shared.transfer(
                    fileUrl: fileUrl, size: size, initResponse: initResp,
                    messageId: messageId, chatId: chatId, onProgress: onProgress)) != nil {
                    onProgress(1.0)
                    return initResp.publicUrl   // multipart landed the object
                }
                // transfer threw (parts/complete gave up; abort already fired) → single-PUT.
            }
        }

        // Single-PUT fallback — the 225 path, unchanged (emits its own upload_attempt).
        onPublicUrlResolved(singlePutPublicUrl)
        try await uploadFileToS3(
            url: singlePutUrl, fileUrl: fileUrl, mimeType: "video/mp4",
            messageId: messageId, chatId: chatId, publicUrl: singlePutPublicUrl,
            onProgress: onProgress)
        return singlePutPublicUrl
    }

    /// Foreground single-PUT for SMALL files (proxy uploads). The
    /// background path's lifecycle overhead isn't worth it for files
    /// that finish in 5-10s before the user even types their vibe.
    /// File must still be readable by URLSession (use a temp file).
    func uploadFileToS3Foreground(
        url: String,
        fileUrl: URL,
        mimeType: String,
        onProgress: ((Double) -> Void)? = nil
    ) async throws {
        guard let remoteUrl = URL(string: url) else { throw APIError.uploadFailed }
        var request = URLRequest(url: remoteUrl)
        request.httpMethod = "PUT"
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")

        let delegate = UploadProgressDelegate(onProgress: onProgress)
        var lastError: Error?
        for attempt in 1...2 {
            do {
                let (_, response) = try await s3UploadSession.upload(for: request, fromFile: fileUrl, delegate: delegate)
                guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                    throw APIError.uploadFailed
                }
                return
            } catch {
                lastError = error
                if attempt < 2 {
                    try? await Task.sleep(for: .seconds(2))
                    onProgress?(0)
                }
            }
        }
        throw lastError ?? APIError.uploadFailed
    }

    // MARK: - Multipart Upload (parallel chunks, lossless)
    //
    // Splits the file into 8MB chunks and uploads them in parallel against
    // presigned URLs served by the server. 2-3× throughput of single-stream
    // PUT on any multi-path network. Bytes are byte-identical — multipart
    // is a TRANSPORT optimization, pixels are not touched.
    //
    // Flow:
    //   1. POST /api/upload-multipart-init { fileName, partCount } →
    //      { uploadId, partUrls[], key, publicUrl }
    //   2. Upload each part to its presigned URL in parallel (max 4 at once)
    //   3. POST /api/upload-multipart-complete { key, uploadId, parts[] } →
    //      { publicUrl }
    // On any unrecoverable error, POST /api/upload-multipart-abort so the
    // S3-side in-progress parts don't sit around billing.

    private static let multipartChunkSize: Int64 = 16 * 1024 * 1024   // 16MB chunks — bigger chunks amortize per-part overhead
    private static let multipartConcurrency = 6                        // matches httpMaximumConnectionsPerHost — saturates the connection pool
    // Lower threshold (30MB) so typical 1080p iPhone clips (40-90MB) get
    // the parallel-upload speedup. Multipart adds ~700ms of init+complete
    // roundtrips, which is paid back as soon as parallel-stream throughput
    // beats single-stream. On a 20Mbps wifi a 60MB video goes from 24s
    // (single PUT) to ~7s (6-way multipart). Threshold below 30MB isn't
    // worth the roundtrip overhead.
    private static let multipartThreshold: Int64 = 30 * 1024 * 1024

    struct MultipartInitResponse: Codable {
        let uploadId: String
        let partUrls: [String]
        let key: String
        let publicUrl: String
    }

    struct MultipartCompleteResponse: Codable {
        let publicUrl: String
        let key: String
    }

    struct MultipartPart: Codable {
        let PartNumber: Int
        let ETag: String
    }

    // MARK: - Multipart networking (226 item 7b — SERVER_CONTRACTS_226 Contract 2)

    /// POST /api/upload-multipart-init {fileName, partCount} → {uploadId, partUrls[],
    /// key, publicUrl}. `partUrls[i]` is presigned for PartNumber i+1 (the number is
    /// baked into the signature); the key is server-generated. Throws on ANY non-2xx
    /// or malformed body — this is the NEVER-WORSE hinge: the caller treats every
    /// throw as "fall back to the single-PUT path", so multipart can only match or
    /// beat 225, never make an upload worse.
    func multipartInit(fileName: String, partCount: Int) async throws -> MultipartInitResponse {
        var request = await authorizedRequest("/api/upload-multipart-init", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["fileName": fileName, "partCount": partCount])
        let (data, response) = try await requestData(request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIError.uploadFailed
        }
        let r = try JSONDecoder().decode(MultipartInitResponse.self, from: data)
        guard r.partUrls.count == partCount, !r.uploadId.isEmpty, !r.key.isEmpty else { throw APIError.uploadFailed }
        return r
    }

    /// POST /api/upload-multipart-complete {key, uploadId, parts:[{PartNumber, ETag}]}
    /// → publicUrl. ETags are sent VERBATIM (quotes included); the server sorts by
    /// PartNumber but we send them sorted anyway. The returned publicUrl is the SAME
    /// value single-PUT returns and is the `video_url` for the job / chat act.
    func multipartComplete(key: String, uploadId: String, parts: [MultipartPart]) async throws -> String {
        var request = await authorizedRequest("/api/upload-multipart-complete", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "key": key,
            "uploadId": uploadId,
            "parts": parts.sorted { $0.PartNumber < $1.PartNumber }
                .map { ["PartNumber": $0.PartNumber, "ETag": $0.ETag] },
        ])
        let (data, response) = try await requestData(request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIError.uploadFailed
        }
        return try JSONDecoder().decode(MultipartCompleteResponse.self, from: data).publicUrl
    }

    /// POST /api/upload-multipart-abort {key, uploadId} → {ok:true}. A safe no-op if
    /// already completed / never initialised. Best-effort: abandoned parts bill
    /// forever, so we always TRY on cancel / give-up / expiry, but a failed abort
    /// never blocks the caller. Returns whether the server acked.
    @discardableResult
    func multipartAbort(key: String, uploadId: String) async -> Bool {
        guard !key.isEmpty, !uploadId.isEmpty else { return false }
        var request = await authorizedRequest("/api/upload-multipart-abort", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["key": key, "uploadId": uploadId])
        guard let (_, response) = try? await requestData(request),
              let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { return false }
        return true
    }

    /// Upload a file using S3 multipart + Transfer Acceleration. Returns the
    /// public URL on success. Falls back internally to nothing — caller is
    /// responsible for falling back to `uploadFileToS3` on thrown errors.
    ///
    /// `onPublicUrlKnown` fires as soon as multipart-init returns (well
    /// before the actual byte transfer finishes) so the caller can kick
    /// off downstream work like prewarm in parallel with the upload.
    func uploadFileToS3Multipart(
        fileName: String,
        fileUrl: URL,
        onPublicUrlKnown: ((String) -> Void)? = nil,
        onProgress: ((Double) -> Void)? = nil
    ) async throws -> String {
        let attrs = try FileManager.default.attributesOfItem(atPath: fileUrl.path)
        let fileSize = (attrs[.size] as? Int64) ?? 0
        guard fileSize > 0 else { throw APIError.uploadFailed }

        // Pause prefetches for the duration — multipart uploads run 4
        // parallel parts already, and prefetch contention here is even
        // more painful than for single PUT.
        await MainActor.run { VideoCache.shared.setUserUploadActive(true) }
        defer {
            Task { @MainActor in VideoCache.shared.setUserUploadActive(false) }
        }

        let chunkSize = Self.multipartChunkSize
        let partCount = Int((fileSize + chunkSize - 1) / chunkSize)
        let uploadStart = Date()
        print("[perf] upload path=multipart fileSize=\(fileSize) parts=\(partCount) chunkSize=\(chunkSize)")

        // 1. Init: get presigned part URLs
        let initStart = Date()
        var initRequest = await authorizedRequest("/api/upload-multipart-init", method: "POST")
        initRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        initRequest.httpBody = try JSONSerialization.data(withJSONObject: [
            "fileName": fileName,
            "partCount": partCount,
        ])
        let (initData, initResp) = try await requestData(initRequest)
        try Self.throwIfWall(initResp, initData)
        try Self.throwIfPaymentRequired(initResp, initData) // 2nd concurrent upload → paywall
        guard let initHttp = initResp as? HTTPURLResponse, (200...299).contains(initHttp.statusCode) else {
            throw APIError.uploadFailed
        }
        let initResponse = try JSONDecoder().decode(MultipartInitResponse.self, from: initData)
        guard initResponse.partUrls.count == partCount else {
            throw APIError.uploadFailed
        }
        print(String(format: "[perf] multipart init %.2fs", Date().timeIntervalSince(initStart)))
        // Eagerly share the public URL with the caller so prewarm can fire
        // in parallel with the actual byte transfer. The S3 object doesn't
        // exist until multipart-complete lands, but the prewarm handler on
        // Modal polls for it.
        onPublicUrlKnown?(initResponse.publicUrl)
        if let host = URL(string: initResponse.partUrls.first ?? "")?.host {
            print("[perf] endpoint=\(host)")
        }

        let uploadedBytes = MultipartProgressTracker()
        let totalBytes = fileSize
        let netStart = Date()

        do {
            let parts: [MultipartPart] = try await withThrowingTaskGroup(of: MultipartPart.self) { group in
                var next = 0
                var collected: [MultipartPart] = []
                collected.reserveCapacity(partCount)

                func scheduleNext() {
                    guard next < partCount else { return }
                    let partIndex = next
                    next += 1
                    let start = Int64(partIndex) * chunkSize
                    let end = min(start + chunkSize, fileSize)
                    let partSize = end - start
                    let partUrlStr = initResponse.partUrls[partIndex]
                    group.addTask {
                        // All parts share the process-wide s3UploadSession.
                        // HTTP/2 multiplexes concurrent part PUTs over a warm
                        // connection pool — handshake cost amortized once,
                        // slow-start paid once, and iOS's connection manager
                        // opens additional TCPs when it detects bandwidth
                        // benefits. Build 62's per-part ephemeral sessions
                        // forced 8 cold handshakes + 8 slow-starts, which
                        // tanked throughput.
                        return try await Self.uploadOnePart(
                            fileUrl: fileUrl,
                            offset: start,
                            length: partSize,
                            partNumber: partIndex + 1,
                            url: partUrlStr,
                            session: APIService.shared.s3UploadSession,
                            tracker: uploadedBytes,
                            totalBytes: totalBytes,
                            onProgress: onProgress
                        )
                    }
                }

                // Seed with concurrency slots
                for _ in 0..<min(Self.multipartConcurrency, partCount) {
                    scheduleNext()
                }
                // Drain + schedule replacements
                for try await part in group {
                    collected.append(part)
                    scheduleNext()
                }
                return collected
            }

            let netElapsed = Date().timeIntervalSince(netStart)
            let netMbps = (Double(fileSize) / 1_048_576.0) / max(netElapsed, 0.001) * 8
            print(String(format: "[perf] multipart parts-only elapsed=%.2fs throughput=%.1fMbps", netElapsed, netMbps))

            // 3. Complete
            let completeStart = Date()
            var completeRequest = await authorizedRequest("/api/upload-multipart-complete", method: "POST")
            completeRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            completeRequest.httpBody = try JSONSerialization.data(withJSONObject: [
                "key": initResponse.key,
                "uploadId": initResponse.uploadId,
                "parts": parts.map { ["PartNumber": $0.PartNumber, "ETag": $0.ETag] },
            ])
            let (completeData, completeResp) = try await requestData(completeRequest)
            guard let http = completeResp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                throw APIError.uploadFailed
            }
            let completeResponse = try JSONDecoder().decode(MultipartCompleteResponse.self, from: completeData)
            print(String(format: "[perf] multipart complete %.2fs", Date().timeIntervalSince(completeStart)))
            let elapsed = Date().timeIntervalSince(uploadStart)
            let mbps = (Double(fileSize) / 1_048_576.0) / max(elapsed, 0.001) * 8
            print(String(format: "[perf] upload multipart TOTAL elapsed=%.2fs throughput=%.1fMbps", elapsed, mbps))
            return completeResponse.publicUrl
        } catch {
            // Abort the in-progress multipart so parts don't orphan-bill.
            Task.detached(priority: .utility) { [initResponse] in
                var abortRequest = await APIService.shared.authorizedRequest("/api/upload-multipart-abort", method: "POST")
                abortRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
                abortRequest.httpBody = try? JSONSerialization.data(withJSONObject: [
                    "key": initResponse.key,
                    "uploadId": initResponse.uploadId,
                ])
                _ = try? await URLSession.shared.data(for: abortRequest)
            }
            throw error
        }
    }

    private static func uploadOnePart(
        fileUrl: URL,
        offset: Int64,
        length: Int64,
        partNumber: Int,
        url: String,
        session: URLSession,
        tracker: MultipartProgressTracker,
        totalBytes: Int64,
        onProgress: ((Double) -> Void)?
    ) async throws -> MultipartPart {
        // Read just this chunk off disk into Data. For 16MB chunks this is
        // 16MB of RAM transient per in-flight part (64MB total at 4 parallel)
        // — trivial on modern iPhones. The previous temp-file-per-chunk
        // approach cost 60MB+ of extra sequential disk write per upload for
        // no measurable network-throughput gain.
        let handle = try FileHandle(forReadingFrom: fileUrl)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        guard let data = try handle.read(upToCount: Int(length)), data.count == Int(length) else {
            throw APIError.uploadFailed
        }
        return try await uploadOnePartData(
            data: data,
            partNumber: partNumber,
            url: url,
            session: session,
            tracker: tracker,
            totalBytes: totalBytes,
            onProgress: onProgress
        )
    }

    /// Upload a single pre-prepared chunk of Data to its presigned URL.
    /// Shared between the file-based multipart path (reads a byte range off
    /// disk) and the iCloud-streaming path (chunks arrive directly from
    /// PHAssetResourceManager). Signed URLs don't take a Content-Type, so
    /// the request omits it.
    static func uploadOnePartData(
        data: Data,
        partNumber: Int,
        url: String,
        session: URLSession,
        tracker: MultipartProgressTracker,
        totalBytes: Int64,
        onProgress: ((Double) -> Void)?
    ) async throws -> MultipartPart {
        guard let u = URL(string: url) else { throw APIError.uploadFailed }
        let partStart = Date()
        let length = Int64(data.count)

        var request = URLRequest(url: u)
        request.httpMethod = "PUT"
        // No Content-Type header — presigned URL was signed without it.

        var attemptsRemaining = 2
        var lastError: Error?
        while attemptsRemaining > 0 {
            do {
                let (_, resp) = try await session.upload(for: request, from: data)
                guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                    throw APIError.uploadFailed
                }
                guard let etag = http.value(forHTTPHeaderField: "ETag") ?? http.value(forHTTPHeaderField: "Etag") else {
                    throw APIError.uploadFailed
                }
                await tracker.add(length)
                let progress = min(1.0, Double(await tracker.total()) / Double(totalBytes))
                await MainActor.run { onProgress?(progress) }
                let partElapsed = Date().timeIntervalSince(partStart)
                let partMbps = (Double(length) / 1_048_576.0) / max(partElapsed, 0.001) * 8
                print(String(format: "[perf] part %d done elapsed=%.2fs throughput=%.1fMbps", partNumber, partElapsed, partMbps))
                return MultipartPart(PartNumber: partNumber, ETag: etag.replacingOccurrences(of: "\"", with: ""))
            } catch {
                lastError = error
                attemptsRemaining -= 1
                if attemptsRemaining > 0 {
                    try? await Task.sleep(for: .seconds(1))
                }
            }
        }
        throw lastError ?? APIError.uploadFailed
    }

    /// Decide whether a file should use multipart based on size. Caller uses
    /// single PUT for tiny files where multipart overhead isn't worth it.
    static func shouldUseMultipart(fileUrl: URL) -> Bool {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: fileUrl.path)[.size] as? Int64) else {
            return false
        }
        return size >= multipartThreshold
    }

    // MARK: - iCloud Streaming Upload (pipeline iCloud download → S3 PUT)
    //
    // For iCloud-only assets the "download then upload" serial path burns
    // the download time entirely before any byte hits S3. Streaming lets
    // the two transfers overlap: as PhotoKit delivers each chunk from
    // iCloud, we fire a part-upload to S3. Total wall-clock time collapses
    // from (dl + ul) to ~max(dl, ul) + small tail, often cutting user-
    // visible latency in half.
    //
    // Implementation:
    //   1. Read the original-bytes file size off the PHAssetResource via
    //      KVC — needed upfront to compute part count and request the
    //      presigned part URLs.
    //   2. Init multipart on the server like the file-based path.
    //   3. PHAssetResourceManager.requestData streams the asset bytes. Its
    //      `dataReceivedHandler` is called on a serial queue with chunks
    //      as they arrive. Accumulate into a buffer; every time the
    //      buffer reaches 16MB, slice a part and fire a detached task
    //      that uploads it to its presigned URL.
    //   4. When iCloud delivery finishes, upload whatever remains as the
    //      final (possibly short) part. S3 allows the last part to be
    //      smaller than the 5MB minimum.
    //   5. Await all part tasks, then POST /api/upload-multipart-complete.

    /// Stream an iCloud video directly into an S3 multipart upload.
    /// Returns the public URL of the finalized object.
    ///
    /// `onPublicUrlKnown` fires as soon as multipart-init returns so the
    /// caller can kick off prewarm in parallel with the iCloud → S3 pipe.
    func streamUploadFromICloud(
        resource: PHAssetResource,
        fileSize: Int64,
        fileName: String,
        onPublicUrlKnown: ((String) -> Void)? = nil,
        onProgress: ((Double) -> Void)? = nil
    ) async throws -> String {
        await MainActor.run { VideoCache.shared.setUserUploadActive(true) }
        defer {
            Task { @MainActor in VideoCache.shared.setUserUploadActive(false) }
        }
        let t0 = Date()
        // 5MB parts — S3's non-final minimum. Smaller parts = first part
        // ships after just 5MB of iCloud bytes have arrived (vs 16MB),
        // starting the pipeline overlap 3× sooner. Tradeoff: more server
        // roundtrips on init, more part-complete overhead. Worth it for
        // the faster pipeline warmup on iCloud-sourced uploads.
        let partSize: Int64 = 5 * 1024 * 1024
        let partCount = Int((fileSize + partSize - 1) / partSize)
        print("[perf] stream upload fileSize=\(fileSize) parts=\(partCount) chunkSize=\(partSize)")

        // 1. Init: request presigned URLs for every part upfront. Fired
        //    as a background task so the first PhotoKit bytes don't wait
        //    on this HTTPS roundtrip.
        let initStart = Date()
        let initTask = Task { () -> MultipartInitResponse in
            var initRequest = await self.authorizedRequest("/api/upload-multipart-init", method: "POST")
            initRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            initRequest.httpBody = try JSONSerialization.data(withJSONObject: [
                "fileName": fileName,
                "partCount": partCount,
            ])
            let (initData, initResp) = try await requestData(initRequest)
            guard let initHttp = initResp as? HTTPURLResponse, (200...299).contains(initHttp.statusCode) else {
                throw APIError.uploadFailed
            }
            let r = try JSONDecoder().decode(MultipartInitResponse.self, from: initData)
            guard r.partUrls.count == partCount else { throw APIError.uploadFailed }
            print(String(format: "[perf] stream init %.2fs", Date().timeIntervalSince(initStart)))
            // Hand the public URL back immediately — caller can fire
            // prewarm now instead of after every part has landed.
            onPublicUrlKnown?(r.publicUrl)
            return r
        }

        let tracker = MultipartProgressTracker()
        let netStart = Date()

        do {
            // 2. Drive PhotoKit streaming. Keep incoming chunks as a list
            //    of Data refs (NOT a concatenated buffer with removeFirst,
            //    which is O(N) per chunk and blocks the serial PhotoKit
            //    delivery queue). When we have >= partSize bytes queued,
            //    slice out the next part's chunks and detach a Task that
            //    assembles + uploads them. The assembly happens OFF the
            //    PhotoKit queue so delivery never stalls.
            var partTasks: [Task<MultipartPart, Error>] = []
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                let options = PHAssetResourceRequestOptions()
                options.isNetworkAccessAllowed = true
                var queue: [Data] = []
                var queuedBytes: Int64 = 0
                var nextPartIndex = 0
                var resumed = false

                options.progressHandler = { progress in
                    if progress > 0 && progress < 1 {
                        print(String(format: "[perf] stream iCloud dl=%.0f%%", progress * 100))
                    }
                }

                /// Pull `size` bytes off the head of the chunk queue as a
                /// list of Data slices. Splits the head chunk if needed.
                /// Keeps O(1) work on the PhotoKit queue — no large
                /// memcpy, no buffer reallocation.
                func sliceFront(size: Int64) -> [Data] {
                    var remaining = size
                    var out: [Data] = []
                    while remaining > 0 && !queue.isEmpty {
                        let head = queue[0]
                        if Int64(head.count) <= remaining {
                            out.append(head)
                            remaining -= Int64(head.count)
                            queue.removeFirst()
                        } else {
                            let take = Int(remaining)
                            out.append(head.prefix(take))
                            queue[0] = head.suffix(head.count - take)
                            remaining = 0
                        }
                    }
                    queuedBytes -= size
                    return out
                }

                PHAssetResourceManager.default().requestData(
                    for: resource,
                    options: options,
                    dataReceivedHandler: { chunk in
                        queue.append(chunk)
                        queuedBytes += Int64(chunk.count)
                        // Ship every complete 5MB boundary. Leave the
                        // final part for completionHandler since S3
                        // allows the last part to be any size but non-
                        // final parts must be >= 5MB.
                        while queuedBytes >= partSize && nextPartIndex < partCount - 1 {
                            let partChunks = sliceFront(size: partSize)
                            let partNumber = nextPartIndex + 1
                            nextPartIndex += 1
                            let task = Task.detached(priority: .userInitiated) {
                                // Assemble the part Data HERE, off the
                                // PhotoKit delivery queue.
                                var partData = Data(capacity: Int(partSize))
                                for c in partChunks { partData.append(c) }
                                let partUrl = try await initTask.value.partUrls[partNumber - 1]
                                return try await APIService.uploadOnePartData(
                                    data: partData,
                                    partNumber: partNumber,
                                    url: partUrl,
                                    session: APIService.shared.s3UploadSession,
                                    tracker: tracker,
                                    totalBytes: fileSize,
                                    onProgress: onProgress
                                )
                            }
                            partTasks.append(task)
                        }
                    },
                    completionHandler: { error in
                        if let error = error {
                            if !resumed { resumed = true; cont.resume(throwing: error) }
                            return
                        }
                        // Flush anything left as the final part.
                        if queuedBytes > 0 && nextPartIndex < partCount {
                            let partChunks = sliceFront(size: queuedBytes)
                            let partNumber = nextPartIndex + 1
                            nextPartIndex += 1
                            let task = Task.detached(priority: .userInitiated) {
                                var partData = Data()
                                for c in partChunks { partData.append(c) }
                                let partUrl = try await initTask.value.partUrls[partNumber - 1]
                                return try await APIService.uploadOnePartData(
                                    data: partData,
                                    partNumber: partNumber,
                                    url: partUrl,
                                    session: APIService.shared.s3UploadSession,
                                    tracker: tracker,
                                    totalBytes: fileSize,
                                    onProgress: onProgress
                                )
                            }
                            partTasks.append(task)
                        }
                        if !resumed { resumed = true; cont.resume() }
                    }
                )
            }

            let initResponse = try await initTask.value

            // 3. Wait for every part upload to finish.
            var parts: [MultipartPart] = []
            for task in partTasks {
                parts.append(try await task.value)
            }
            let netElapsed = Date().timeIntervalSince(netStart)
            let netMbps = (Double(fileSize) / 1_048_576.0) / max(netElapsed, 0.001) * 8
            print(String(format: "[perf] stream parts-done elapsed=%.2fs throughput=%.1fMbps", netElapsed, netMbps))

            // 4. Complete the multipart upload.
            let completeStart = Date()
            var completeRequest = await authorizedRequest("/api/upload-multipart-complete", method: "POST")
            completeRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            completeRequest.httpBody = try JSONSerialization.data(withJSONObject: [
                "key": initResponse.key,
                "uploadId": initResponse.uploadId,
                "parts": parts
                    .sorted { $0.PartNumber < $1.PartNumber }
                    .map { ["PartNumber": $0.PartNumber, "ETag": $0.ETag] },
            ])
            let (completeData, completeResp) = try await requestData(completeRequest)
            guard let http = completeResp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                throw APIError.uploadFailed
            }
            let completeResponse = try JSONDecoder().decode(MultipartCompleteResponse.self, from: completeData)
            print(String(format: "[perf] stream complete %.2fs", Date().timeIntervalSince(completeStart)))
            let total = Date().timeIntervalSince(t0)
            let totalMbps = (Double(fileSize) / 1_048_576.0) / max(total, 0.001) * 8
            print(String(format: "[perf] stream TOTAL elapsed=%.2fs throughput=%.1fMbps", total, totalMbps))
            return completeResponse.publicUrl
        } catch {
            // Abort so S3 doesn't orphan-bill the in-progress parts. Need
            // to recover the init response — it may have succeeded even
            // if a part failed later.
            Task.detached(priority: .utility) {
                guard let init_ = try? await initTask.value else { return }
                var abortRequest = await APIService.shared.authorizedRequest("/api/upload-multipart-abort", method: "POST")
                abortRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
                abortRequest.httpBody = try? JSONSerialization.data(withJSONObject: [
                    "key": init_.key,
                    "uploadId": init_.uploadId,
                ])
                _ = try? await URLSession.shared.data(for: abortRequest)
            }
            throw error
        }
    }

    func uploadVideo(data: Data, fileName: String) async throws -> String {
        var request = await authorizedRequest("/api/upload", method: "POST")

        let boundary = UUID().uuidString
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"video\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: video/mp4\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"userId\"\r\n\r\n".data(using: .utf8)!)
        body.append((AuthService.shared.currentUser?.id ?? "").data(using: .utf8)!)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        let (responseData, _) = try await requestData(request)
        let result = try JSONDecoder().decode(UploadResponse.self, from: responseData)
        guard let videoUrl = result.videoUrl else {
            throw APIError.uploadFailed
        }
        return videoUrl
    }

    // MARK: - Fresh Video URL

    /// Get a fresh signed URL for a video that might have an expired S3 URL
    func getFreshVideoUrl(originalUrl: String) -> String {
        // S3 presigned URLs contain X-Amz-Expires — if the URL has query params, it's presigned
        // For now, return the original URL — the server generates 30-day URLs
        // If URLs start expiring, add a /api/refresh-url endpoint server-side
        return originalUrl
    }

    // MARK: - Chat

    func chat(message: String, history: [[String: String]]) async throws -> String {
        var request = await authorizedRequest("/api/chat", method: "POST")
        let payload: [String: Any] = ["message": message, "history": history]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, response) = try await requestData(request)
        if let http = response as? HTTPURLResponse, http.statusCode == 402 {
            struct LimitPayload: Decodable {
                let kind: String?
                let limit: Int?
                let message: String?
            }
            let payload = try? JSONDecoder().decode(LimitPayload.self, from: data)
            throw APIError.paymentRequired(
                kind: payload?.kind ?? "chat",
                limit: payload?.limit,
                message: payload?.message ?? "Daily chat limit reached."
            )
        }
        // Decode gate (stuck-jobs directive): status-code check FIRST — a
        // 5xx error body must THROW (so the caller's retry handler fires),
        // never decode into a nil-reply "success". Then the success decode
        // requires a real reply: an empty one is an error, not a message.
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw APIError.jobCreationFailed("Chat failed (HTTP \(http.statusCode))")
        }
        struct StrictChatResponse: Decodable { let reply: String }
        let result = try JSONDecoder().decode(StrictChatResponse.self, from: data)
        guard !result.reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw APIError.jobCreationFailed("Empty chat reply")
        }
        return result.reply
    }

    /// Streaming chat. Each yielded String is a token chunk (could be
    /// one character, a word, or a few words depending on Gemini's
    /// SSE batching). Consumer concatenates as they arrive to get the
    /// real-time "typing" feel iOS chat apps have.
    ///
    /// The stream terminates normally on `[DONE]` from the server, or
    /// throws on transport error / server error frame.
    func chatStream(message: String, history: [[String: String]]) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let work = Task {
                do {
                    var request = await authorizedRequest("/api/chat/stream", method: "POST")
                    let payload: [String: Any] = ["message": message, "history": history]
                    request.httpBody = try JSONSerialization.data(withJSONObject: payload)
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    request.timeoutInterval = 60

                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    if let http = response as? HTTPURLResponse, http.statusCode == 402 {
                        // Daily chat cap hit. Drain the (JSON) response body
                        // to parse the structured payload and rethrow as
                        // paymentRequired so the caller pops the paywall
                        // directly — instead of falling back to /api/chat
                        // which would just 402 again and waste a request.
                        var bodyData = Data()
                        for try await byte in bytes { bodyData.append(byte) }
                        struct LimitPayload: Decodable {
                            let kind: String?
                            let limit: Int?
                            let message: String?
                        }
                        let payload = try? JSONDecoder().decode(LimitPayload.self, from: bodyData)
                        throw APIError.paymentRequired(
                            kind: payload?.kind ?? "chat",
                            limit: payload?.limit,
                            message: payload?.message ?? "Daily chat limit reached."
                        )
                    }
                    if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                        throw APIError.jobCreationFailed("chat stream HTTP \(http.statusCode)")
                    }

                    for try await line in bytes.lines {
                        guard line.hasPrefix("data: ") else { continue }
                        let payload = String(line.dropFirst(6))
                        if payload == "[DONE]" {
                            continuation.finish()
                            return
                        }
                        if let data = payload.data(using: .utf8) {
                            // Expect {"token":"..."} or {"error":"..."}.
                            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
                                if let err = obj["error"] {
                                    continuation.finish(throwing: APIError.jobCreationFailed(err))
                                    return
                                }
                                if let token = obj["token"] {
                                    continuation.yield(token)
                                }
                            }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            // Cancel the background Task if the consumer abandons the stream.
            continuation.onTermination = { _ in work.cancel() }
        }
    }
}

enum APIError: LocalizedError {
    case notAuthenticated
    case jobCreationFailed(String)
    case uploadFailed
    case deleteFailed
    /// Server returned 402 — daily quota hit or a Pro-only feature was
    /// called by a free user. `kind` is "render", "chat", or "reedit" so
    /// the caller can present the right paywall reason.
    case paymentRequired(kind: String, limit: Int?, message: String)
    /// Server returned 403 `wall_required` — an enforced `.none` account hit a
    /// gated door (post-flip; inert while the wall knob is off). The client
    /// routes to the trial wall (TrialWallView, context .door), never a usable
    /// screen. `message` is old-client-safe display text for the rare straggler.
    case wallRequired(message: String)
    /// Render dispatch returned a structured failure shape: error_code +
    /// user_message + the three behavioural flags (retryable,
    /// requires_new_video, requires_vibe_change). Callers branch on the
    /// flags to decide which failure screen to show. Carries the
    /// underlying error_code string so analytics can group failures.
    case structuredFailure(
        errorCode: String?,
        userMessage: String,
        retryable: Bool,
        requiresNewVideo: Bool,
        requiresVibeChange: Bool
    )
    /// Layer 2 of pick-validate-upload flow: Modal /validate said the
    /// sample isn't a talking-head video. userMessage is the backend's
    /// human-readable reason; faceRatio + confidence are debug info.
    case validationRejected(userMessage: String, faceRatio: Double?, confidence: Double?)

    var errorDescription: String? {
        switch self {
        case .notAuthenticated: return "Please sign in"
        case .jobCreationFailed(let msg): return msg
        case .uploadFailed: return "Upload failed"
        case .deleteFailed: return "Delete failed"
        case .paymentRequired(_, _, let msg): return msg
        case .wallRequired(let message): return message
        case .structuredFailure(_, let userMessage, _, _, _): return userMessage
        case .validationRejected(let userMessage, _, _): return userMessage
        }
    }
}

/// Modal /validate response shape. is_talking_head is the only field
/// the iOS app branches on; the rest are surfaced for logging and
/// future analytics.
struct ValidationResponse: Codable {
    let isTalkingHead: Bool
    let confidence: Double?
    let faceRatio: Double?
    let faceSamples: Int?
    let reason: String?
    let userMessage: String?

    enum CodingKeys: String, CodingKey {
        case isTalkingHead = "is_talking_head"
        case confidence
        case faceRatio = "face_ratio"
        case faceSamples = "face_samples"
        case reason
        case userMessage = "user_message"
    }
}

/// Render-endpoint structured error envelope. Parsed when createVideoJob
/// receives a non-2xx response that includes the structured fields.
private struct StructuredErrorPayload: Codable {
    let error: String?
    let errorCode: String?
    let userMessage: String?
    let retryable: Bool?
    let requiresNewVideo: Bool?
    let requiresVibeChange: Bool?
    let errorDetail: String?

    enum CodingKeys: String, CodingKey {
        case error
        case errorCode = "error_code"
        case userMessage = "user_message"
        case retryable
        case requiresNewVideo = "requires_new_video"
        case requiresVibeChange = "requires_vibe_change"
        case errorDetail = "error_detail"
    }
}

// Thread-safe counter for multipart upload progress aggregation across
// parallel part uploads. Swift actors give us race-free increment + read.
actor MultipartProgressTracker {
    private var bytesUploaded: Int64 = 0
    func add(_ delta: Int64) { bytesUploaded += delta }
    func total() -> Int64 { bytesUploaded }
}

class UploadProgressDelegate: NSObject, URLSessionTaskDelegate {
    let onProgress: ((Double) -> Void)?

    init(onProgress: ((Double) -> Void)?) {
        self.onProgress = onProgress
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        let progress = Double(totalBytesSent) / Double(totalBytesExpectedToSend)
        DispatchQueue.main.async { [self] in
            onProgress?(progress)
        }
    }
}
