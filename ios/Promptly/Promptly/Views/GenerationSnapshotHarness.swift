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
    static let clips: [String] = (0..<10).map { "clip-\($0)" }

    /// A server that started only SOME of the batch. Every job here is running
    /// and already charged; the rest were never begun and never charged.
    static func dispatched(_ n: Int) -> BatchDispatched {
        let jobs = (0..<n).map { "{\"job_id\":\"j\($0)\",\"clip_id\":\"clip-\($0)\"}" }
        return decode("{\"jobs\":[\(jobs.joined(separator: ","))],\"balance\":15}")!
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

    // ── REAL SERVER BODIES ──────────────────────────────────────────────────
    // Decoded through the shipping PaymentRequired, so the screenshots show the
    // copy the card actually produces from a 402 — not a hand-written string
    // that happens to resemble it.
    static func payment(_ json: String) -> PaymentRequired { decode(json)! }

    static let body402Pro =
        "{\"error\":\"payment_required\",\"reason\":\"pro_required\"," +
        "\"needed\":5,\"balance\":0,\"shortfall\":5,\"actions\":[\"upgrade\"]}"
    static let body402Cap =
        "{\"error\":\"payment_required\",\"reason\":\"daily_cap\",\"scope\":\"today's\"," +
        "\"needed\":5,\"balance\":40,\"shortfall\":0,\"actions\":[\"topup\"]}"
    static let body402Short =
        "{\"error\":\"payment_required\",\"reason\":\"insufficient_credits\"," +
        "\"needed\":5,\"balance\":2,\"shortfall\":3,\"actions\":[\"topup\",\"upgrade\"]}"

    @ViewBuilder
    private var card: some View {
        switch stateIndex {
        // ── THE RE-EDIT STATES (20+) ────────────────────────────────────────
        case 20: reeditRow(status: "idle")
        case 21: reeditRow(status: "running")
        case 22: reeditRow(status: "queued")
        case 23: reeditRow(status: "queued_edit")
        case 24: PaymentRequiredCard(payment: Self.payment(Self.body402Pro), subject: "This change")
        case 25: PaymentRequiredCard(payment: Self.payment(Self.body402Cap), subject: "This change")
        case 26: PaymentRequiredCard(payment: Self.payment(Self.body402Short), subject: "This change")
        case 27: questionThread(retracted: false)
        case 28: questionThread(retracted: true)
        case 29: reeditRow(status: "never_sent")
        case 30: reeditRow(status: "failed_refunded")
        case 31: reeditRow(status: "failed_charge_stands")
        case 2:  PosedQuoteCard(state: .confirming(Self.quote()))
        case 3:  PosedQuoteCard(state: .blocked(Self.payment("insufficient_credits", needed: 45, balance: 20, shortfall: 25), Self.quote()))
        case 4:  PosedQuoteCard(state: .blocked(Self.payment("pro_required", needed: 45, balance: 0, shortfall: 45), Self.quote()))
        case 5:  PosedQuoteCard(state: .blocked(Self.payment("daily_cap", needed: 45, balance: 500, shortfall: 0), Self.quote()))
        case 6:  PosedQuoteCard(state: .offered(Self.quote(credits: 50)))   // the 410's fresh price, in place
        case 7:  BatchConfirmCard(batch: Self.batch(affordable: 10), clipIds: Self.clips)
        case 8:  BatchConfirmCard(batch: Self.batch(affordable: 4), clipIds: Self.clips)
        case 11: PosedBatchCard(batch: Self.batch(affordable: 10), clipIds: Self.clips,
                                started: Self.dispatched(7))   // server began 7 of 10
        case 9:  queuedCard(QueueState(position: 3, etaSeconds: 300))
        case 10: queuedCard(QueueState(position: 3, etaSeconds: nil))
        default: PosedQuoteCard(state: .offered(Self.quote()))
        }
    }

    /// The composer-side states, drawn the way the thread draws them.
    @ViewBuilder
    private func reeditRow(status: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            switch status {
            case "idle":
                rowCard { Text(verbatim: "Ready when you are.").foregroundColor(.white.opacity(0.5)) }
            case "running":
                rowCard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(verbatim: "make the captions punchier").foregroundColor(.white.opacity(0.9))
                        HStack(spacing: 8) {
                            ProgressView().tint(.white.opacity(0.7)).scaleEffect(0.7)
                            Text(verbatim: "Editing…").foregroundColor(.white.opacity(0.7))
                        }
                    }
                }
            case "queued":
                VStack(alignment: .leading, spacing: 8) {
                    rowCard {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(verbatim: "and trim the intro").foregroundColor(.white.opacity(0.9))
                            Text(verbatim: "Queued, next up").font(.system(size: 12)).foregroundColor(.white.opacity(0.55))
                        }
                    }
                    pill("clock.arrow.circlepath", "1 change queued · tap to edit")
                }
            case "queued_edit":
                VStack(alignment: .leading, spacing: 8) {
                    composerBox("and trim the intro")
                    Text(verbatim: "Editing the queued change — sending replaces it.")
                        .font(.system(size: 12)).foregroundColor(.white.opacity(0.55))
                }
            default:
                // THE COPY COMES FROM THE CLASSIFIER, not a literal — so the
                // screenshot shows what the rule produces, and a change to the
                // rule changes the picture.
                let copy: ReeditFailureCopy = {
                    switch status {
                    case "failed_refunded":      return .classify(reachedServer: true, creditsRefunded: 5)
                    case "failed_charge_stands": return .classify(reachedServer: true, creditsRefunded: nil, chargeStands: true)
                    default:                     return .classify(reachedServer: false, creditsRefunded: nil)
                    }
                }()
                rowCard {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(verbatim: "make the captions punchier").foregroundColor(.white.opacity(0.9))
                        Text(verbatim: copy.text)
                            .font(.system(size: 12)).foregroundColor(.white.opacity(0.6))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    /// A delivered video with the agent's question under it — and the same
    /// thread once a re-edit has superseded it.
    @ViewBuilder
    private func questionThread(retracted: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            rowCard {
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: "AI video · 5s").font(.system(size: 15, weight: .semibold))
                        .foregroundColor(.white.opacity(0.95))
                    Text(verbatim: "Your video is ready!").font(.system(size: 13))
                        .foregroundColor(.white.opacity(0.6))
                }
            }
            if retracted {
                rowCard {
                    Text(verbatim: "make the captions punchier").foregroundColor(.white.opacity(0.9))
                }
                Text(verbatim: "(question retracted — a newer change supersedes it)")
                    .font(.system(size: 11)).foregroundColor(.white.opacity(0.35))
            } else {
                rowCard {
                    Text(verbatim: "Captions are now live. Would you like any emphasis added to specific words, or a different caption style?")
                        .font(.system(size: 14)).foregroundColor(.white.opacity(0.9))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func rowCard<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        content()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5))
    }

    private func pill(_ icon: String, _ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon).font(.system(size: 12, weight: .semibold)).foregroundColor(.white.opacity(0.75))
            Text(verbatim: text).font(.system(size: 13, weight: .medium)).foregroundColor(.white.opacity(0.88))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Capsule().fill(Color.white.opacity(0.07)))
    }

    private func composerBox(_ text: String) -> some View {
        HStack {
            Text(verbatim: text).foregroundColor(.white.opacity(0.95))
            Spacer(minLength: 0)
            Circle().fill(Color.white).frame(width: 28, height: 28)
                .overlay(Image(systemName: "arrow.up").font(.system(size: 13, weight: .bold)).foregroundColor(.black))
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 20).fill(Color.white.opacity(0.10)))
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
        case 11: return "11 · BATCH, server started 7 of 10"
        case 20: return "20 · IDLE"
        case 21: return "21 · RUNNING"
        case 22: return "22 · QUEUED"
        case 23: return "23 · QUEUED, being edited"
        case 24: return "24 · 402 pro_required (free user)"
        case 25: return "25 · 402 daily_cap — price + scope from the server"
        case 26: return "26 · 402 insufficient_credits"
        case 27: return "27 · QUESTION posted under the video"
        case 28: return "28 · QUESTION retracted by a newer change"
        case 29: return "29 · NEVER SENT — no money claim"
        case 30: return "30 · SENT, FAILED, refund CONFIRMED"
        case 31: return "31 · SENT, FAILED, charge STANDS"
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

/// The batch card after a confirm, so the started / not-started split can be
/// photographed. Same view body as the shipping card.
private struct PosedBatchCard: View {
    let batch: BatchQuote
    let clipIds: [String]
    let started: BatchDispatched
    var body: some View { BatchConfirmCard(batch: batch, clipIds: clipIds, posed: started) }
}
#endif
