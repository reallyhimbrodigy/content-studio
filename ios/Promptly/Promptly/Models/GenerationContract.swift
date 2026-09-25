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
        /// LEGACY. Not in B2's contract as of 04b0b26 — the set is
        /// pro_required / cap_reached / insufficient_credits. Kept only so a
        /// server that has not shipped that commit still renders the cap card
        /// rather than falling through to the generic refusal.
        case dailyCap = "daily_cap"
        /// THE CAP, per B2's contract (04b0b26). The card still does not
        /// DEPEND on this string — `isCapShaped` recognises a cap by its
        /// numbers — so a future rename degrades to the same copy instead of a
        /// dead end. Pinning it just makes the match exact.
        case capReached = "cap_reached"
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
    /// THE CAP, IN THE SERVER'S NUMBERS. `included` is the allowance, `used`
    /// what has been spent of it, `price` what the NEXT one costs. All three
    /// are the server's: the client has never known what a cap is worth and
    /// must not start guessing now.
    let included: Int?
    let used: Int?
    let price: Int?

    /// What the next change costs. `price` is the cap contract's field;
    /// `needed` is the older generic one. Prefer the specific.
    var nextPrice: Int? { price ?? needed }

    /// WHAT THE CARD SHOULD ACTUALLY SAY, after affordability.
    ///
    /// A user can be past the cap AND short at the same time, and that body
    /// carries cap numbers — so the numbers rule alone would offer "Use 5
    /// credits" to someone holding 2, and the tap would fail. Being told the
    /// price of something you cannot buy, by a button that then errors, is
    /// worse than being told you are short.
    ///
    /// So affordability WINS whenever it is knowable: if the balance is known
    /// and below the price, this is an insufficient-credits card whatever the
    /// server called it. A NULL balance is UNKNOWN, not zero — it cannot make
    /// anything insufficient, and nothing numeric is claimed from it.
    /// PRECEDENCE, per B2 (04b0b26): pro_required > insufficient_credits >
    /// cap_reached. The server already applies it — past the cap with a short
    /// balance arrives AS insufficient_credits, carrying price and balance —
    /// so this is a fallback for a body that has not had it applied.
    ///
    /// AND IT MUST NOT OUTRANK pro_required. The earlier version promoted to
    /// insufficient whenever the balance was below the price, which would have
    /// turned a free user's "this is a Pro feature" into "you are 3 credits
    /// short" — sending them to buy credits for something credits cannot
    /// unlock. Only a CAP (or an unrecognised reason) may be promoted.
    var effectiveReason: Reason? {
        // ONE RULE, NOT TWO. Only a CAP or an unrecognised reason may be
        // promoted — which is what keeps pro_required intact. An extra early
        // return for pro_required read as load-bearing and was not: removing
        // it changed nothing, which is exactly how a redundant guard misleads
        // the next person into thinking the protection lives there.
        let promotable = (reason == .capReached || reason == .dailyCap || reason == nil)
        if promotable, let price = nextPrice, let have = balance, have < price {
            return .insufficientCredits
        }
        return reason
    }

    /// A cap is recognised by its NUMBERS, not by a string. The reason names
    /// which cap; these three say what to render, and a body carrying them is
    /// a cap whatever it calls itself — so a rename on the server degrades to
    /// slightly generic copy instead of the wrong card.
    var isCapShaped: Bool { included != nil && used != nil }

    enum CodingKeys: String, CodingKey {
        case error, reason, needed, balance, shortfall, actions, scope, included, used, price
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rawReason = ((try? c.decodeIfPresent(String.self, forKey: .reason)) ?? nil) ?? ""
        let parsed = Reason(rawValue: rawReason)
        needed = (try? c.decodeIfPresent(Int.self, forKey: .needed)) ?? nil
        balance = (try? c.decodeIfPresent(Int.self, forKey: .balance)) ?? nil
        shortfall = (try? c.decodeIfPresent(Int.self, forKey: .shortfall)) ?? nil
        actions = ((try? c.decodeIfPresent([String].self, forKey: .actions)) ?? nil) ?? []
        included = (try? c.decodeIfPresent(Int.self, forKey: .included)) ?? nil
        used = (try? c.decodeIfPresent(Int.self, forKey: .used)) ?? nil
        price = (try? c.decodeIfPresent(Int.self, forKey: .price)) ?? nil
        scope = ((try? c.decodeIfPresent(String.self, forKey: .scope)) ?? nil)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .flatMap { $0.isEmpty ? nil : $0 }
        // RECOGNISED BY ITS NUMBERS. If B2 renames the reason, a body carrying
        // included+used still renders the cap card rather than the fallback —
        // the copy stays right through a rename instead of silently degrading.
        if parsed == nil, included != nil, used != nil {
            reason = .capReached
        } else {
            reason = parsed
        }
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

// MARK: - What a refusal or a failure may claim

/// WHICH UPGRADE, IF ANY, TO OFFER BESIDE "Get credits".
///
/// Insufficient credits only reaches a PAYING user — a free user cannot
/// re-edit at all, they get pro_required. So "Upgrade" is either wrong or
/// ambiguous depending on which tier they already hold:
///   - Max already holds the top tier. An Upgrade button leads nowhere, and a
///     button that leads nowhere is worse than no button.
///   - Pro means Max, so it should say Max rather than making them find out.
/// Returns nil when there is nothing above them.
enum TierOffer {
    /// `resolved` is whether the entitlement is actually KNOWN yet.
    ///
    /// UNKNOWN IS NOT FREE, and treating it as free is the live bug the
    /// snapshot harness exposed by accident: before customerInfo loads at
    /// launch, or offline, `isPro` and `isMax` are both false — indistinguish-
    /// able from a free account. A Max subscriber opening the app on a plane
    /// would be offered "Upgrade", a button to a tier they already hold.
    ///
    /// So when the tier is unknown we offer NOTHING above Get credits. Get
    /// credits is right for every tier; an upgrade is right only for some, and
    /// showing it on a guess is how a paying user is told to pay again.
    static func upgradeLabel(isPro: Bool, isMax: Bool, resolved: Bool = true) -> String? {
        guard resolved else { return nil }
        if isMax { return nil }
        if isPro { return "Upgrade to Max" }
        return "Upgrade"
    }
}

/// WHAT A FAILED CHANGE IS ALLOWED TO SAY ABOUT MONEY.
///
/// Two different failures wear one face today, and only one of them touches
/// money:
///   - it never reached the server: nothing ran, nothing was charged, and
///     nothing needs refunding. Saying "you weren't charged" here is true but
///     beside the point.
///   - it reached the server and the edit failed: a charge was taken. Whether
///     it came back is a FACT we either have or do not.
///
/// THE RULE: never claim "you weren't charged" until a refund is confirmed —
/// in the response or on the job row. A reassurance that turns out to be false
/// is worse than saying nothing, because the user stops checking.
enum ReeditFailureCopy {
    case neverSent
    case failedRefundConfirmed(Int)
    /// A CONTRACT VIOLATION, not a normal state. B2 commits the refund in the
    /// same transaction that marks a re-edit failed, so a failure without one
    /// cannot happen — and if it does, the honest response is to say nothing
    /// about money rather than guess in either direction. Kept as a guard
    /// precisely because it should never fire.
    case failedRefundUnknown

    static func classify(reachedServer: Bool, creditsRefunded: Int?) -> ReeditFailureCopy {
        guard reachedServer else { return .neverSent }
        if let n = creditsRefunded, n > 0 { return .failedRefundConfirmed(n) }
        return .failedRefundUnknown
    }

    var text: String {
        switch self {
        case .neverSent:
            // No money claim at all: nothing ran.
            return String(localized: "That change didn't get sent. Tap to try it again.")
        case .failedRefundConfirmed:
            return String(localized: "That change didn't work. You weren't charged. Tap to try again.")
        case .failedRefundUnknown:
            // Ran, failed, and no refund was reported — which the server
            // contract says is impossible. Say what is true and nothing more.
            return String(localized: "That change didn't work. Tap to try again.")
        }
    }

    /// Only true when the copy actually contains the reassurance, so a test can
    /// assert the claim rather than the phrasing.
    var claimsNotCharged: Bool {
        if case .failedRefundConfirmed = self { return true }
        return false
    }
}
