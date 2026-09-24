import Foundation

// THE GENERATION AND BATCH CONTRACT — the client half, one definition.
//
// Every type here mirrors a shape the server owns. The rule that shapes the
// whole file: MONEY IS DECIDED ONLY ON THE SERVER. Nothing here computes a
// price, a shortfall, an affordability, or an ETA. The client formats numbers
// it was given and does no arithmetic — so a client that is wrong about money
// is impossible rather than merely unlikely.
//
// DECODING IS DEFENSIVE FOR A SPECIFIC REASON. Optionality covers absent and
// null but NOT a type mismatch, and ONE throw anywhere fails the WHOLE parent
// decode. That is exactly what cost the 258 client its `videos_limit` read. So
// every optional field here is read through `try?`, and the required fields are
// the only ones that can refuse a value — in which case the card simply does
// not draw and the message renders as ordinary text. A missing card is a
// visible absence; a failed message decode is a blank thread.

// MARK: - The quote

/// A quote attached to an assistant reply. The server does not dispatch when a
/// user asks for generated media — it quotes, and the user taps once.
struct GenerationQuote: Codable, Equatable, Hashable {
    let quoteId: String
    /// image | ai_video | voiceover | music | sfx. Held as a String on purpose:
    /// an unknown kind from a newer server must not fail the decode, and the
    /// client never branches on it for money — only, at most, for an icon.
    let kind: String
    /// DISPLAY-READY, AND THE CLIENT NEVER BUILDS IT. "AI video · 5s" arrives
    /// spelled. Composing it here would be a second definition of what a thing
    /// is called, which is how the paywall surfaces drifted apart.
    let label: String
    let credits: Int
    let balance: Int?
    /// The server's own affordability verdict. Advisory for rendering only —
    /// the 402 at confirm is the authority, because the balance can move
    /// between the quote and the tap.
    let affordable: Bool?
    let expiresAt: Date?

    enum CodingKeys: String, CodingKey {
        case quoteId = "quote_id", kind, label, credits, balance, affordable
        case expiresAt = "expires_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // REQUIRED. Without these there is no card to draw, and pretending
        // otherwise would render a button that cannot be honoured.
        quoteId = try c.decode(String.self, forKey: .quoteId)
        label = try c.decode(String.self, forKey: .label)
        credits = try c.decode(Int.self, forKey: .credits)
        // TOLERATED. Each is read independently so one bad field cannot take
        // the card down with it.
        kind = ((try? c.decodeIfPresent(String.self, forKey: .kind)) ?? nil) ?? ""
        balance = (try? c.decodeIfPresent(Int.self, forKey: .balance)) ?? nil
        affordable = (try? c.decodeIfPresent(Bool.self, forKey: .affordable)) ?? nil
        expiresAt = ((try? c.decodeIfPresent(String.self, forKey: .expiresAt)) ?? nil)
            .flatMap(GenerationContract.date(fromISO:))
    }

    /// EXPLICIT, AND IT MUST STAY THAT WAY. This type is persisted inside
    /// SerializedMessage, so it round-trips through disk on every chat switch.
    /// The synthesized encoder writes `expiresAt` as a Double; `init(from:)`
    /// above reads it as an ISO STRING and tolerates failure — so the pair
    /// would lose every expiry on reload, silently, and an aged-out card would
    /// look fresh forever. Encode the same spelling we decode.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(quoteId, forKey: .quoteId)
        try c.encode(kind, forKey: .kind)
        try c.encode(label, forKey: .label)
        try c.encode(credits, forKey: .credits)
        try c.encodeIfPresent(balance, forKey: .balance)
        try c.encodeIfPresent(affordable, forKey: .affordable)
        try c.encodeIfPresent(expiresAt.map(GenerationContract.iso(from:)), forKey: .expiresAt)
    }
}

// MARK: - The one 402

/// ONE PAYMENT-REQUIRED SHAPE, EVERYWHERE — quote confirm, video send, batch
/// confirm, re-edit. `reason` alone decides which card is shown. Nothing is
/// ever parsed from prose, which is why `shortfall` is a number here and the
/// human-readable message is not consulted at all.
struct PaymentRequired: Decodable, Equatable, Hashable {
    enum Reason: String, Codable {
        case insufficientCredits = "insufficient_credits"
        case proRequired = "pro_required"
        case dailyCap = "daily_cap"
    }

    /// The raw string, kept beside the parsed case so an unknown reason from a
    /// newer server is still legible in analytics instead of being erased.
    let rawReason: String
    let reason: Reason?
    let needed: Int?
    let balance: Int?
    let shortfall: Int?
    let actions: [String]
    /// WHAT PERIOD THE CAP COVERS, in the server's words ("today", "this
    /// week", "this month"). Rendered verbatim, because only the server knows
    /// what its cap actually resets on — the client saying "today" when the
    /// cap is monthly tells the user to come back tomorrow to the same wall.
    /// Absent means we do not know, and the copy then does not claim a period.
    let scope: String?

    enum CodingKeys: String, CodingKey { case error, reason, needed, balance, shortfall, actions, scope }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rawReason = ((try? c.decodeIfPresent(String.self, forKey: .reason)) ?? nil) ?? ""
        reason = Reason(rawValue: rawReason)
        needed = (try? c.decodeIfPresent(Int.self, forKey: .needed)) ?? nil
        balance = (try? c.decodeIfPresent(Int.self, forKey: .balance)) ?? nil
        shortfall = (try? c.decodeIfPresent(Int.self, forKey: .shortfall)) ?? nil
        actions = ((try? c.decodeIfPresent([String].self, forKey: .actions)) ?? nil) ?? []
        scope = ((try? c.decodeIfPresent(String.self, forKey: .scope)) ?? nil)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .flatMap { $0.isEmpty ? nil : $0 }
    }
}

// MARK: - Confirm

struct QuoteConfirmed: Decodable, Equatable, Hashable {
    let jobId: String
    let status: String          // "queued" | "processing"
    let balance: Int?
    enum CodingKeys: String, CodingKey { case jobId = "job_id", status, balance }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        jobId = try c.decode(String.self, forKey: .jobId)
        status = ((try? c.decodeIfPresent(String.self, forKey: .status)) ?? nil) ?? "queued"
        balance = (try? c.decodeIfPresent(Int.self, forKey: .balance)) ?? nil
    }
}

/// 410: the quote aged out. Carries a FRESH quote, so the card swaps in place
/// and shows the new price. The user never sees an error for this.
struct QuoteExpired: Decodable, Equatable, Hashable {
    let reason: String
    let requote: GenerationQuote?
    enum CodingKeys: String, CodingKey { case reason, requote }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reason = ((try? c.decodeIfPresent(String.self, forKey: .reason)) ?? nil) ?? "quote_expired"
        requote = (try? c.decodeIfPresent(GenerationQuote.self, forKey: .requote)) ?? nil
    }
}

// MARK: - Batch

struct BatchQuote: Decodable, Equatable, Hashable {
    let batchQuoteId: String
    let count: Int
    let creditsEach: Int
    let creditsTotal: Int
    let balance: Int?
    /// How many the server says are affordable RIGHT NOW. The client offers
    /// "Edit the first N now" from this number and never derives it.
    let affordableCount: Int?
    let shortfall: Int?
    let expiresAt: Date?

    enum CodingKeys: String, CodingKey {
        case batchQuoteId = "batch_quote_id", count, balance, shortfall
        case creditsEach = "credits_each", creditsTotal = "credits_total"
        case affordableCount = "affordable_count", expiresAt = "expires_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        batchQuoteId = try c.decode(String.self, forKey: .batchQuoteId)
        count = try c.decode(Int.self, forKey: .count)
        creditsEach = try c.decode(Int.self, forKey: .creditsEach)
        creditsTotal = try c.decode(Int.self, forKey: .creditsTotal)
        balance = (try? c.decodeIfPresent(Int.self, forKey: .balance)) ?? nil
        affordableCount = (try? c.decodeIfPresent(Int.self, forKey: .affordableCount)) ?? nil
        shortfall = (try? c.decodeIfPresent(Int.self, forKey: .shortfall)) ?? nil
        expiresAt = ((try? c.decodeIfPresent(String.self, forKey: .expiresAt)) ?? nil)
            .flatMap(GenerationContract.date(fromISO:))
    }
}

/// One dispatched job, paired to the clip it belongs to.
///
/// PAIRED BY clip_id, NOT BY POSITION. Ordering was the old contract; an
/// explicit pairing survives a server that starts a subset, which is exactly
/// the case that must not put one clip's progress against another's tile.
struct BatchJob: Decodable, Equatable, Hashable {
    let jobId: String
    let clipId: String
    enum CodingKeys: String, CodingKey { case jobId = "job_id", clipId = "clip_id" }
}

/// The batch confirm result. `jobs` may be SHORTER than the count confirmed —
/// see BatchConfirmCard for why that is rendered rather than refused.
struct BatchDispatched: Decodable, Equatable, Hashable {
    let jobs: [BatchJob]
    let balance: Int?

    enum CodingKeys: String, CodingKey { case jobs, balance }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        jobs = try c.decode([BatchJob].self, forKey: .jobs)
        balance = (try? c.decodeIfPresent(Int.self, forKey: .balance)) ?? nil
    }
}

// MARK: - Clip picked

struct ClipPicked: Decodable, Equatable, Hashable {
    let clipId: String
    enum CodingKeys: String, CodingKey { case clipId = "clip_id" }
}

// MARK: - Queue

/// The queue face of a job row. `etaSeconds` is null until the server has 20
/// completed jobs to take a median from — and when it is null the client shows
/// the POSITION ONLY. No ETA is ever invented, because a wrong wait is worse
/// than no wait: it is a promise.
struct QueueState: Equatable, Hashable {
    let position: Int
    let etaSeconds: Int?

    var positionText: String { "Position \(position) in queue" }

    /// nil when the server gave no estimate. Callers must render the position
    /// alone in that case rather than substituting a guess.
    var waitText: String? {
        guard let s = etaSeconds, s > 0 else { return nil }
        if s < 90 { return "about a minute" }
        let mins = Int((Double(s) / 60.0).rounded())
        return "about \(mins) min"
    }
}

// MARK: - Shared helpers

enum GenerationContract {
    /// ISO-8601 with and without fractional seconds. Two formatters because
    /// ISO8601DateFormatter matches the option set EXACTLY — a formatter built
    /// for fractional seconds returns nil for a timestamp without them, which
    /// would silently read every whole-second expiry as "no expiry".
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func date(fromISO s: String) -> Date? {
        isoFractional.date(from: s) ?? isoPlain.date(from: s)
    }

    /// The spelling `date(fromISO:)` can read back. Whole seconds, because the
    /// plain formatter is the one guaranteed to parse it.
    static func iso(from d: Date) -> String { isoPlain.string(from: d) }
}
