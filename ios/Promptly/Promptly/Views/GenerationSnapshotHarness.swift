#if DEBUG
import SwiftUI

/// EVERY STATE OF THE GENERATION CARDS, ON SCREEN, FROM THE STUBS.
///
/// Launch with:  -snapshotGen YES -genState N
///
///   1  quote            the offer: label, credits, balance, one button
///   2  confirming       after the tap, before the response
///   3  insufficient     402 insufficient_credits — shortfall as a number
///   4  pro_required     402 pro_required — free tier, an upgrade card
///   5  daily_cap        402 daily_cap — one line, and not a dead end
///   6  requote          410 — the fresh price, swapped in place, no error
///   7  batch_full       10 affordable, one button
///   8  batch_partial    4 of 10 affordable — "Edit 4 now" / "Top up for all"
///   9  queued           position + honest wait
///  10  queued_no_eta    position ONLY — the server gave no estimate
///
/// WHY A HARNESS AND NOT A UI TEST. These states are reached through a server
/// response, and half of them are responses we hope never to see in production.
/// Posing them directly is the only way to LOOK at each one — and looking is
/// the point, because every one of them is a moment where a user is being told
/// they cannot have something.
struct GenerationSnapshotHarnessView: View {
    private var stateIndex: Int {
        let a = ProcessInfo.processInfo.arguments
        if let i = a.firstIndex(of: "-genState"), i + 1 < a.count { return Int(a[i + 1]) ?? 1 }
        return 1
    }

    // Fixtures spelled as the SERVER would send them, decoded through the real
    // types — so a screenshot cannot show a shape the decoder would reject.
    private static func quote(credits: Int = 45, balance: Int? = 120) -> GenerationQuote {
        decode("""
        {"quote_id":"q1","kind":"ai_video","label":"AI video · 5s","credits":\(credits),
         "balance":\(balance.map(String.init) ?? "null"),"affordable":true,
         "expires_at":"2030-01-01T00:00:00Z"}
        """)!
    }
    private static func payment(_ reason: String, needed: Int, balance: Int, shortfall: Int) -> PaymentRequired {
        decode("""
        {"error":"payment_required","reason":"\(reason)","needed":\(needed),
         "balance":\(balance),"shortfall":\(shortfall),"actions":["topup","upgrade"]}
        """)!
    }
    private static func batch(affordable: Int) -> BatchQuote {
        decode("""
        {"batch_quote_id":"bq1","count":10,"credits_each":10,"credits_total":100,
         "balance":45,"affordable_count":\(affordable),"shortfall":55,
         "expires_at":"2030-01-01T00:00:00Z"}
        """)!
    }
    private static func decode<T: Decodable>(_ s: String) -> T? {
        try? JSONDecoder().decode(T.self, from: Data(s.utf8))
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 14) {
                Text(verbatim: caption)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.white.opacity(0.35))
                card
                Spacer()
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .preferredColorScheme(.dark)
        .onAppear {
            // The app underneath still owns a focused composer, and its keyboard
            // rises through the harness into every capture. Evidence should show
            // the card, not the chrome of the screen it happens to cover.
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder),
                                            to: nil, from: nil, for: nil)
        }
    }

    @ViewBuilder
    private var card: some View {
        switch stateIndex {
        case 2:  PosedQuoteCard(state: .confirming(Self.quote()))
        case 3:  PosedQuoteCard(state: .blocked(Self.payment("insufficient_credits", needed: 45, balance: 20, shortfall: 25), Self.quote()))
        case 4:  PosedQuoteCard(state: .blocked(Self.payment("pro_required", needed: 45, balance: 0, shortfall: 45), Self.quote()))
        case 5:  PosedQuoteCard(state: .blocked(Self.payment("daily_cap", needed: 45, balance: 500, shortfall: 0), Self.quote()))
        case 6:  PosedQuoteCard(state: .offered(Self.quote(credits: 50)))   // the 410's fresh price, in place
        case 7:  BatchConfirmCard(batch: Self.batch(affordable: 10))
        case 8:  BatchConfirmCard(batch: Self.batch(affordable: 4))
        case 9:  queuedCard(QueueState(position: 3, etaSeconds: 300))
        case 10: queuedCard(QueueState(position: 3, etaSeconds: nil))
        default: PosedQuoteCard(state: .offered(Self.quote()))
        }
    }

    /// The queue line as it sits in a job's card, not floating on its own.
    private func queuedCard(_ q: QueueState) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: "AI video · 5s")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(.white.opacity(0.95))
            QueueLine(state: q)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5))
    }

    private var caption: String {
        switch stateIndex {
        case 2: return "2 · CONFIRMING"
        case 3: return "3 · 402 insufficient_credits"
        case 4: return "4 · 402 pro_required (free tier)"
        case 5: return "5 · 402 daily_cap"
        case 6: return "6 · 410 requote — fresh price, swapped in place"
        case 7: return "7 · BATCH, all affordable"
        case 8: return "8 · BATCH, 4 of 10 affordable"
        case 9: return "9 · QUEUED with eta"
        case 10: return "10 · QUEUED, eta null — position only"
        default: return "1 · QUOTE"
        }
    }
}

/// The real QuoteCardView draws from its own @State, which a snapshot cannot
/// reach. This poses one state directly so every branch can be photographed —
/// it renders THE SAME view body, so a screenshot is evidence about the
/// shipping card and not about a mock of it.
private struct PosedQuoteCard: View {
    let state: QuoteCardState
    var body: some View { QuoteCardView(quote: state.quote, posed: state) }
}
#endif
