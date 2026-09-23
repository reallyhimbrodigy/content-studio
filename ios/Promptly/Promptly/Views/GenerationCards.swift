import SwiftUI

// THE QUOTE, BATCH AND QUEUE CARDS — one card, in the thread, one tap.
//
// THE SHAPE OF THE WHOLE THING. A quote arrives on the assistant message; the
// card shows what it will make, what it costs, what you hold, and a single
// button. The card is the SAME OBJECT through every state that follows —
// confirming, blocked on payment, re-quoted, queued — because moving the user
// to a settings screen or an error screen is what makes generation feel like
// filing a form instead of asking for something.
//
// WHY NO MODEL NAMES AND NO SETTINGS. The label is display-ready from the
// server ("AI video · 5s") and the client never composes it. There is nothing
// here to configure, so there is no screen to configure it on.
//
// EVENTS FIRE ONCE PER SERVER RESPONSE, NEVER PER RENDER. Every Analytics call
// for this flow lives in GenerationService, inside the async function that
// received the response. SwiftUI re-runs a body freely — anything tracked from
// a body would count redraws. The one impression event here is deduped through
// state, the same discipline as the credit badge.

// MARK: - Card state

/// What the card is showing right now. A 402 and a 410 are STATES, not errors —
/// that is the whole reason this is an enum and not a `Result`.
enum QuoteCardState: Equatable {
    case offered(GenerationQuote)
    case confirming(GenerationQuote)
    /// 402. `reason` alone decides what the user is offered next.
    case blocked(PaymentRequired, GenerationQuote)
    /// Transport only — the sole state permitted to say "something went wrong".
    case failed(String, GenerationQuote)

    var quote: GenerationQuote {
        switch self {
        case .offered(let q), .confirming(let q): return q
        case .blocked(_, let q), .failed(_, let q): return q
        }
    }
}

// MARK: - The quote card

struct QuoteCardView: View {
    @Environment(\.conversionScale) private var k
    let quote: GenerationQuote
    /// Handed the confirmed job so the thread can swap this card for progress.
    var onConfirmed: (QuoteConfirmed) -> Void = { _ in }

    @State private var state: QuoteCardState
    @State private var reportedImpression = false

    init(quote: GenerationQuote, onConfirmed: @escaping (QuoteConfirmed) -> Void = { _ in }) {
        self.quote = quote
        self.onConfirmed = onConfirmed
        _state = State(initialValue: .offered(quote))
    }

    #if DEBUG
    /// Pose one state for a snapshot. It seeds the SAME `state` the live card
    /// drives and renders the SAME body — so a screenshot taken through this is
    /// evidence about the shipping card, not about a mock that resembles it.
    init(quote: GenerationQuote, posed: QuoteCardState) {
        self.quote = quote
        self.onConfirmed = { _ in }
        _state = State(initialValue: posed)
    }
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 10 * k) {
            header
            switch state {
            case .offered(let q):      offeredBody(q)
            case .confirming(let q):   confirmingBody(q)
            case .blocked(let pr, _):  blockedBody(pr)
            case .failed(let why, _):  failedBody(why)
            }
        }
        .padding(14 * k)
        .background(RoundedRectangle(cornerRadius: 14 * k).fill(Color.white.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 14 * k).strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5))
        .animation(.easeInOut(duration: 0.22), value: state)
        .task {
            // ONCE. Not in the body, and deduped, so this counts appearances
            // rather than redraws.
            guard !reportedImpression else { return }
            reportedImpression = true
            Analytics.track("quote_card_shown", props: ["kind": state.quote.kind])
        }
    }

    // The label and price, which never change identity across states — the
    // user must be able to see WHAT they are being asked about while they are
    // being asked about payment.
    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8 * k) {
            // Display-ready from the server. Verbatim, because Text(_:) would
            // treat it as a LocalizedStringKey and silently swallow it.
            Text(verbatim: state.quote.label)
                .font(.system(size: 15 * k, weight: .semibold))
                .foregroundColor(.white.opacity(0.95))
            Spacer(minLength: 0)
            Text(verbatim: "\(state.quote.credits) credits")
                .font(.system(size: 13 * k, weight: .medium))
                .foregroundColor(.white.opacity(0.7))
                .monospacedDigit()
        }
    }

    @ViewBuilder
    private func offeredBody(_ q: GenerationQuote) -> some View {
        // Balance is shown only when the server told us one. An unread balance
        // is never drawn as zero.
        if let balance = q.balance {
            Text(verbatim: "You have \(balance)")
                .font(.system(size: 12 * k))
                .foregroundColor(.white.opacity(0.55))
                .monospacedDigit()
        }
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            Task { await confirm(q) }
        } label: {
            Text("Generate")
                .font(.system(size: 15 * k, weight: .semibold))
                .foregroundColor(.black)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11 * k)
                .background(Capsule().fill(Color.white))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func confirmingBody(_ q: GenerationQuote) -> some View {
        HStack(spacing: 8 * k) {
            ProgressView().tint(.white.opacity(0.7)).scaleEffect(0.8)
            Text("Starting…")
                .font(.system(size: 14 * k))
                .foregroundColor(.white.opacity(0.7))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 11 * k)
        .background(Capsule().fill(Color.white.opacity(0.08)))
    }

    /// THE 402, AND IT IS NEVER AN ERROR. `reason` alone chooses the words and
    /// the button; nothing is read from a message string.
    @ViewBuilder
    private func blockedBody(_ pr: PaymentRequired) -> some View {
        switch pr.reason {
        case .insufficientCredits:
            // The shortfall is a NUMBER from the server. The user has already
            // been taken to top-up; this is what they come back to.
            if let short = pr.shortfall, let have = pr.balance {
                Text(verbatim: "You have \(have) — \(short) short")
                    .font(.system(size: 12 * k))
                    .foregroundColor(.white.opacity(0.6))
                    .monospacedDigit()
            }
            twoActions(primary: "Get credits",
                       primaryAction: { AppState.shared.showCredits = true },
                       secondary: "Upgrade",
                       secondaryAction: { AppState.shared.presentPaywall(.manual) })
        case .proRequired:
            // Free tier asking to generate. An upgrade card, never an error.
            Text("Generating is a Pro feature.")
                .font(.system(size: 12 * k))
                .foregroundColor(.white.opacity(0.6))
            primaryButton("Upgrade") { AppState.shared.presentPaywall(.manual) }
        case .dailyCap:
            // ONE LINE, AND NOT A DEAD END. The cap resets; saying only "you
            // hit a limit" strands someone who would happily pay to continue.
            Text("That's today's limit — back tomorrow.")
                .font(.system(size: 12 * k))
                .foregroundColor(.white.opacity(0.6))
            primaryButton("Upgrade for more") { AppState.shared.presentPaywall(.manual) }
        case .none:
            // An unknown reason from a newer server. Offer the least-wrong door
            // rather than a dead end, and the raw reason is already in analytics.
            Text("Not available right now.")
                .font(.system(size: 12 * k))
                .foregroundColor(.white.opacity(0.6))
            primaryButton("Get credits") { AppState.shared.showCredits = true }
        }
    }

    @ViewBuilder
    private func failedBody(_ why: String) -> some View {
        Text("Couldn't start that.")
            .font(.system(size: 12 * k))
            .foregroundColor(.white.opacity(0.6))
        primaryButton("Try again") { Task { await confirm(state.quote) } }
    }

    // MARK: - Confirm

    /// ONE TAP, ONE RESPONSE, ONE STATE CHANGE.
    private func confirm(_ q: GenerationQuote) async {
        state = .confirming(q)
        switch await GenerationService.shared.confirmQuote(q.quoteId) {
        case .confirmed(let ok):
            onConfirmed(ok)
        case .requoted(let fresh):
            // SILENT SWAP. The price may have changed; the card has not. No
            // alert, no error, no lost place in the thread — the user tapped
            // once and is looking at a live offer again.
            state = .offered(fresh)
        case .paymentRequired(let pr):
            state = .blocked(pr, q)
            // Straight to the door the reason names, so the common case is one
            // tap rather than two. The card stays behind them to return to.
            switch pr.reason {
            case .insufficientCredits: AppState.shared.showCredits = true
            case .proRequired:         AppState.shared.presentPaywall(.manual)
            case .dailyCap, .none:     break   // a cap has no purchase to make
            }
        case .failed(let why):
            state = .failed(why, q)
        }
    }

    // MARK: - Buttons

    private func primaryButton(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 15 * k, weight: .semibold))
                .foregroundColor(.black)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11 * k)
                .background(Capsule().fill(Color.white))
        }
        .buttonStyle(.plain)
    }

    private func twoActions(primary: String, primaryAction: @escaping () -> Void,
                            secondary: String, secondaryAction: @escaping () -> Void) -> some View {
        HStack(spacing: 8 * k) {
            Button(action: primaryAction) {
                Text(primary)
                    .font(.system(size: 14 * k, weight: .semibold))
                    .foregroundColor(.black)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10 * k)
                    .background(Capsule().fill(Color.white))
            }
            .buttonStyle(.plain)
            Button(action: secondaryAction) {
                Text(secondary)
                    .font(.system(size: 14 * k, weight: .semibold))
                    .foregroundColor(.white.opacity(0.9))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10 * k)
                    .background(Capsule().fill(Color.white.opacity(0.10)))
            }
            .buttonStyle(.plain)
        }
    }
}

// MARK: - Batch

/// THE ONE LINE BEFORE SENDING. "10 videos · 100 credits · you have 45" —
/// stated once, before anything is dispatched, because a partial send the user
/// did not agree to is the failure this exists to prevent.
struct BatchConfirmCard: View {
    @Environment(\.conversionScale) private var k
    let batch: BatchQuote
    var onDispatched: ([String], Int?) -> Void = { _, _ in }

    @State private var busy = false
    @State private var blocked: PaymentRequired?

    /// The server's own count. NEVER derived here — the client does no
    /// arithmetic about money, and "how many can they afford" is money.
    private var affordable: Int { batch.affordableCount ?? batch.count }
    private var canAffordAll: Bool { affordable >= batch.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 10 * k) {
            Text(verbatim: summaryLine)
                .font(.system(size: 14 * k, weight: .medium))
                .foregroundColor(.white.opacity(0.95))
                .monospacedDigit()

            if let pr = blocked {
                // Fresh numbers, and nothing was dispatched.
                Text(verbatim: shortfallLine(pr))
                    .font(.system(size: 12 * k))
                    .foregroundColor(.white.opacity(0.6))
                    .monospacedDigit()
            }

            if busy {
                HStack(spacing: 8 * k) {
                    ProgressView().tint(.white.opacity(0.7)).scaleEffect(0.8)
                    Text("Starting…").font(.system(size: 14 * k)).foregroundColor(.white.opacity(0.7))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11 * k)
                .background(Capsule().fill(Color.white.opacity(0.08)))
            } else if canAffordAll {
                action("Generate \(batch.count)") { Task { await confirm(batch.count) } }
            } else {
                // NEVER A SILENT PARTIAL SEND. Both doors are explicit, and the
                // count that will actually run is in the button's own words.
                HStack(spacing: 8 * k) {
                    action("Edit \(affordable) now", filled: true) { Task { await confirm(affordable) } }
                    action("Top up for all", filled: false) { AppState.shared.showCredits = true }
                }
            }
        }
        .padding(14 * k)
        .background(RoundedRectangle(cornerRadius: 14 * k).fill(Color.white.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 14 * k).strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5))
    }

    /// Every number here came from the server. The separator is ours; the
    /// figures are not.
    private var summaryLine: String {
        var parts = ["\(batch.count) videos", "\(batch.creditsTotal) credits"]
        if let b = batch.balance { parts.append("you have \(b)") }
        return parts.joined(separator: " · ")
    }

    private func shortfallLine(_ pr: PaymentRequired) -> String {
        if let s = pr.shortfall, let b = pr.balance { return "You have \(b) — \(s) short" }
        return "Not enough credits"
    }

    private func confirm(_ count: Int) async {
        busy = true
        defer { busy = false }
        switch await GenerationService.shared.confirmBatch(batch.batchQuoteId, count: count) {
        case .dispatched(let ids, let balance):
            onDispatched(ids, balance)
        case .paymentRequired(let pr):
            // Nothing ran. Fresh numbers, and the user chooses again.
            blocked = pr
        case .failed:
            blocked = nil
        }
    }

    private func action(_ title: String, filled: Bool = true, _ go: @escaping () -> Void) -> some View {
        Button(action: go) {
            Text(verbatim: title)
                .font(.system(size: 14 * k, weight: .semibold))
                .foregroundColor(filled ? .black : .white.opacity(0.9))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11 * k)
                .background(Capsule().fill(filled ? Color.white : Color.white.opacity(0.10)))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Queue

/// Position and an honest wait, in the job's own card. Never an error — a
/// queued job is working, it just has not started yet.
struct QueueLine: View {
    @Environment(\.conversionScale) private var k
    let state: QueueState

    var body: some View {
        // ONLY ABOVE ZERO. A position of 0 means "next", which is not a queue,
        // and a null or zero ETA is shown as nothing rather than as a guess.
        if state.position > 0 {
            HStack(spacing: 6 * k) {
                Image(systemName: "clock")
                    .font(.system(size: 11 * k))
                    .foregroundColor(.white.opacity(0.5))
                Text(verbatim: line)
                    .font(.system(size: 12 * k))
                    .foregroundColor(.white.opacity(0.6))
                    .monospacedDigit()
            }
        }
    }

    private var line: String {
        guard let wait = state.waitText else { return state.positionText }
        return "\(state.positionText) · \(wait)"
    }
}
