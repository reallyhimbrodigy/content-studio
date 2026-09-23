import Foundation

/// THE GENERATION AND BATCH CONTRACT — the client's only door to it.
///
/// ONE RULE ABOVE ALL: money is decided on the server. Nothing in this file
/// computes a price, a shortfall, an affordable count or an ETA. It posts, it
/// decodes, it hands typed outcomes to the UI. Every number the user reads came
/// down the wire, which is what makes "the client is wrong about money"
/// impossible rather than unlikely.
///
/// WHY OUTCOMES ARE AN ENUM. A 402 is not an error here — it is a card. So is a
/// 410. Modelling them as thrown errors would push callers into `catch` blocks
/// where the honest answer is a different view, and the contract's "never an
/// error" requirement would depend on every call site remembering. An enum
/// makes the compiler ask the question instead.
@MainActor
final class GenerationService {
    static let shared = GenerationService()
    private init() {}

    private let base = "https://usepromptly.app"

    // MARK: - Outcomes

    enum ConfirmOutcome: Equatable {
        case confirmed(QuoteConfirmed)
        /// The card swaps in place and shows the fresh price. Never an error.
        case requoted(GenerationQuote)
        /// `reason` alone decides which card. Never parsed from prose.
        case paymentRequired(PaymentRequired)
        /// Transport or an unreadable body. The ONLY case that may show a retry.
        case failed(String)
    }

    enum BatchQuoteOutcome: Equatable {
        case quoted(BatchQuote)
        case paymentRequired(PaymentRequired)
        case failed(String)
    }

    enum BatchConfirmOutcome: Equatable {
        /// The jobs the server ACTUALLY started, each paired to its clip_id,
        /// plus the balance after the reservation. This may be SHORTER than the
        /// count confirmed — see the note in `confirmBatch`.
        case dispatched(BatchDispatched)
        /// A 402: fresh numbers, and NOTHING was dispatched.
        case paymentRequired(PaymentRequired)
        case failed(String)
    }

    // MARK: - Quote confirm

    /// Tap → confirm. The body is EMPTY: the client never sends a price, so a
    /// tampered or merely stale client cannot influence what is charged.
    ///
    /// `Idempotency-Key: {quote_id}` makes a double-tap a no-op at the server
    /// rather than a second charge — which matters because the button is large,
    /// the network is slow, and the first thing a user does when nothing
    /// happens is tap again.
    func confirmQuote(_ quoteId: String) async -> ConfirmOutcome {
        #if DEBUG
        if let stub = DebugStubs.confirm(quoteId) { return stub }
        #endif
        guard let url = URL(string: "\(base)/api/quotes/\(quoteId)/confirm"),
              let token = await AuthService.shared.getValidToken()
        else { return .failed("not signed in") }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(quoteId, forHTTPHeaderField: "Idempotency-Key")
        req.timeoutInterval = 30

        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse
        else { return .failed("network") }

        switch http.statusCode {
        case 200:
            guard let ok = try? JSONDecoder().decode(QuoteConfirmed.self, from: data)
            else { return .failed("unreadable confirm") }
            Analytics.track("quote_confirmed", props: ["status": ok.status], durable: true)
            return .confirmed(ok)
        case 402:
            guard let pr = try? JSONDecoder().decode(PaymentRequired.self, from: data)
            else { return .failed("unreadable 402") }
            Analytics.track("quote_payment_required", props: ["reason": pr.rawReason], durable: true)
            return .paymentRequired(pr)
        case 410:
            // EXPIRY IS NOT AN ERROR. A fresh quote comes back in the body and
            // the card swaps in place. If the requote is missing we still must
            // not show an error — the caller re-quotes from scratch.
            let expired = try? JSONDecoder().decode(QuoteExpired.self, from: data)
            Analytics.track("quote_expired", props: ["requoted": expired?.requote != nil], durable: true)
            if let fresh = expired?.requote { return .requoted(fresh) }
            return .failed("quote_expired_no_requote")
        default:
            return .failed("http \(http.statusCode)")
        }
    }

    // MARK: - Batch

    func quoteBatch(clipIds: [String]) async -> BatchQuoteOutcome {
        #if DEBUG
        if let stub = DebugStubs.batchQuote(clipIds) { return stub }
        #endif
        guard let url = URL(string: "\(base)/api/batches/quote"),
              let token = await AuthService.shared.getValidToken()
        else { return .failed("not signed in") }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["clip_ids": clipIds])
        req.timeoutInterval = 30

        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse
        else { return .failed("network") }

        if http.statusCode == 402, let pr = try? JSONDecoder().decode(PaymentRequired.self, from: data) {
            return .paymentRequired(pr)
        }
        guard http.statusCode == 200,
              let q = try? JSONDecoder().decode(BatchQuote.self, from: data)
        else { return .failed("http \(http.statusCode)") }
        return .quoted(q)
    }

    /// Confirm exactly `count`. The server reserves count × credits_each
    /// atomically and dispatches exactly that many, or dispatches NOTHING and
    /// returns fresh numbers. There are no partial sends, so this method has no
    /// notion of "some succeeded".
    func confirmBatch(_ batchQuoteId: String, count: Int) async -> BatchConfirmOutcome {
        #if DEBUG
        if let stub = DebugStubs.batchConfirm(batchQuoteId, count) { return stub }
        #endif
        guard let url = URL(string: "\(base)/api/batches/\(batchQuoteId)/confirm"),
              let token = await AuthService.shared.getValidToken()
        else { return .failed("not signed in") }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(batchQuoteId, forHTTPHeaderField: "Idempotency-Key")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["count": count])
        req.timeoutInterval = 45

        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse
        else { return .failed("network") }

        if http.statusCode == 402, let pr = try? JSONDecoder().decode(PaymentRequired.self, from: data) {
            Analytics.track("batch_payment_required",
                            props: ["reason": pr.rawReason, "requested": count], durable: true)
            return .paymentRequired(pr)
        }
        guard http.statusCode == 200,
              let result = try? JSONDecoder().decode(BatchDispatched.self, from: data)
        else { return .failed("http \(http.statusCode)") }

        // A SHORT ARRAY IS A RESULT, NOT A FAILURE — and this is the case worth
        // being careful about. Every job in `jobs` is RUNNING and has already
        // been CHARGED. Refusing the whole response because the count surprised
        // us would show an error over work the user is paying for, and would
        // orphan jobs that still complete. So: render exactly what the server
        // started, pair it by clip_id, and say the mismatch out loud instead.
        //
        // Clips absent from `jobs` were never started and never charged, which
        // is what the card tells the user about them — rather than leaving them
        // looking stalled.
        if result.jobs.count != count {
            Analytics.track("batch_count_mismatch",
                            props: ["requested": count, "returned": result.jobs.count], durable: true)
        }
        Analytics.track("batch_dispatched", props: ["count": result.jobs.count], durable: true)
        return .dispatched(result)
    }

    // MARK: - Clip picked (the speed rule)

    /// Told the instant a clip is selected AND uploaded, so the backend starts
    /// importing into ChatCut while the user is still typing. Fire-and-forget
    /// by design: the send path works without a clip_id, so a failure here
    /// costs parallelism, never the render.
    ///
    /// The server discards unused picks after 30 minutes, so an abandoned pick
    /// needs no client cleanup.
    @discardableResult
    func clipPicked(uploadKey: String, durationSeconds: Double) async -> String? {
        #if DEBUG
        if let stub = DebugStubs.clipPicked(uploadKey) { return stub }
        #endif
        guard let url = URL(string: "\(base)/api/clips/picked"),
              let token = await AuthService.shared.getValidToken()
        else { return nil }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // The upload key is the natural idempotency key: re-pick, retry and
        // restage all re-send the same clip, and none of them should start a
        // second ChatCut import.
        req.setValue(uploadKey, forHTTPHeaderField: "Idempotency-Key")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "upload_key": uploadKey, "duration_s": durationSeconds,
        ])
        req.timeoutInterval = 15

        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
              let picked = try? JSONDecoder().decode(ClipPicked.self, from: data)
        else { return nil }
        Analytics.track("clip_picked_ack", props: ["duration_s": Int(durationSeconds)])
        return picked.clipId
    }
}

#if DEBUG
/// STUBS SO THE CLIENT IS EXERCISABLE BEFORE B2 DEPLOYS — and so every branch
/// the contract names (402 by reason, 410 requote, batch shortfall, null ETA)
/// can be SEEN, not just reasoned about. Off unless explicitly armed, because a
/// stub that answers by default is how a dead endpoint looks healthy.
enum DebugStubs {
    /// Armed with `-genStub <scenario>` or PROMPTLY_GEN_STUB.
    static var scenario: String? {
        if let i = ProcessInfo.processInfo.arguments.firstIndex(of: "-genStub"),
           i + 1 < ProcessInfo.processInfo.arguments.count {
            return ProcessInfo.processInfo.arguments[i + 1]
        }
        return ProcessInfo.processInfo.environment["PROMPTLY_GEN_STUB"]
    }

    private static func decode<T: Decodable>(_ json: String) -> T? {
        Data(json.utf8).withUnsafeBytes { _ in try? JSONDecoder().decode(T.self, from: Data(json.utf8)) }
    }

    static func confirm(_ quoteId: String) -> GenerationService.ConfirmOutcome? {
        switch scenario {
        case "ok":
            return decode("{\"job_id\":\"stub-job\",\"status\":\"queued\",\"balance\":75}")
                .map { GenerationService.ConfirmOutcome.confirmed($0) }
        case "insufficient":
            return decode("{\"error\":\"payment_required\",\"reason\":\"insufficient_credits\",\"needed\":45,\"balance\":20,\"shortfall\":25,\"actions\":[\"topup\",\"upgrade\"]}")
                .map { GenerationService.ConfirmOutcome.paymentRequired($0) }
        case "pro_required":
            return decode("{\"error\":\"payment_required\",\"reason\":\"pro_required\",\"needed\":45,\"balance\":0,\"shortfall\":45,\"actions\":[\"upgrade\"]}")
                .map { GenerationService.ConfirmOutcome.paymentRequired($0) }
        case "daily_cap":
            return decode("{\"error\":\"payment_required\",\"reason\":\"daily_cap\",\"needed\":45,\"balance\":500,\"shortfall\":0,\"actions\":[\"upgrade\"]}")
                .map { GenerationService.ConfirmOutcome.paymentRequired($0) }
        case "expired":
            return decode("{\"quote_id\":\"stub-requote\",\"kind\":\"ai_video\",\"label\":\"AI video · 5s\",\"credits\":50,\"balance\":120,\"affordable\":true,\"expires_at\":\"2030-01-01T00:00:00Z\"}")
                .map { GenerationService.ConfirmOutcome.requoted($0) }
        default: return nil
        }
    }

    static func batchQuote(_ clipIds: [String]) -> GenerationService.BatchQuoteOutcome? {
        guard scenario == "batch_short" || scenario == "batch_ok" else { return nil }
        let affordable = scenario == "batch_ok" ? clipIds.count : 4
        let json = "{\"batch_quote_id\":\"stub-batch\",\"count\":\(clipIds.count),\"credits_each\":10,\"credits_total\":\(clipIds.count * 10),\"balance\":45,\"affordable_count\":\(affordable),\"shortfall\":55,\"expires_at\":\"2030-01-01T00:00:00Z\"}"
        return (decode(json) as BatchQuote?).map { .quoted($0) }
    }

    static func batchConfirm(_ id: String, _ count: Int) -> GenerationService.BatchConfirmOutcome? {
        guard scenario?.hasPrefix("batch") == true else { return nil }
        let jobs = (0..<count).map { "{\"job_id\":\"stub-job-\($0)\",\"clip_id\":\"clip-\($0)\"}" }
        let json = "{\"jobs\":[\(jobs.joined(separator: ","))],\"balance\":\(45 - count * 10)}"
        return (decode(json) as BatchDispatched?).map { .dispatched($0) }
    }

    static func clipPicked(_ uploadKey: String) -> String? {
        scenario == nil ? nil : "stub-clip-\(abs(uploadKey.hashValue))"
    }
}
#endif
