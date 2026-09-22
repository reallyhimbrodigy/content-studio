import SwiftUI

// RE-EDIT, SCOPED TO ONE VIDEO.
//
// Opened by the re-edit pill on a finished video — the one that already carried
// the Pro wall and the reedit_tap event (ruled for 258: no hold gesture, no
// second entry). Everything here is about ONE root: its versions, and one
// composer that adds the next one.
//
// A VIDEO'S HISTORY IS A FLAT LIST, NOT A TREE. Re-edits branch in the data —
// parent_job_id records provenance, and production already holds chains four
// deep and parents with four children — but the ordinal is creation order under
// the root, so the user sees v1, v2, v3 with the latest selected. No branch UI,
// because a branch is not a thing the user asked for.
//
// ONE RE-EDIT AT A TIME PER VIDEO. The server enforces it with a partial unique
// index and answers 409. This screen never guesses at that state: it reads the
// 409's `status` and says WHICH, because "already being re-edited" on a video
// that is actually parked waiting for an answer sends the user to watch a
// render that is not running.
struct ReeditSheet: View {
    let jobId: String
    var onDismiss: () -> Void = {}

    @Environment(\.conversionScale) private var k
    @State private var loaded: ReeditVersionsResponse?
    @State private var selectedId: String?
    @State private var text: String = ""
    @State private var composer: ComposerState = .loading
    @FocusState private var focused: Bool

    /// The composer has FIVE states and they are not interchangeable. A single
    /// `isDisabled` bool would collapse "rendering" and "waiting on your answer"
    /// into one greyed-out field with no explanation, which is the shape that
    /// makes a user think the app is broken.
    enum ComposerState: Equatable {
        case loading
        case ready
        case sending
        /// 409 with status queued|processing — work is genuinely in flight.
        case lockedRendering(inFlightJobId: String)
        /// The video is parked on a question. The escape is ANSWERING it, not
        /// waiting: 19 rows in production sat like this for up to 62 days
        /// because nothing ever surfaced the question.
        case parked(question: String, retryJobId: String)
        case failed(String)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let loaded { versionStrip(loaded) }
                Divider().opacity(0.12)
                Spacer(minLength: 0)
                if case .parked(let q, _) = composer { parkedCard(q) }
                if case .failed(let m) = composer { errorCard(m) }
                composerBar
            }
            .navigationTitle("Re-edit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { onDismiss() }
                }
            }
        }
        .task { await load() }
    }

    // MARK: - Versions

    /// Ascending, latest LAST — matching the wire order — and the latest is
    /// selected on open, because the thing a user wants to act on is the newest
    /// cut, not the original.
    @ViewBuilder
    private func versionStrip(_ r: ReeditVersionsResponse) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10 * k) {
                ForEach(r.versions) { v in
                    Button { selectedId = v.job_id } label: {
                        VStack(spacing: 3 * k) {
                            Text("v\(v.version)")
                                .font(.system(size: 15 * k, weight: .semibold))
                            if let cr = v.change_request, !cr.isEmpty {
                                Text(cr).font(.system(size: 11 * k)).lineLimit(1)
                            } else {
                                // v1 is the original upload and has no change
                                // request. Saying "original" is truer than an
                                // empty line that reads like missing data.
                                Text("original").font(.system(size: 11 * k)).opacity(0.6)
                            }
                        }
                        .padding(.horizontal, 12 * k).padding(.vertical, 8 * k)
                        .background(
                            RoundedRectangle(cornerRadius: 12 * k, style: .continuous)
                                .fill(v.job_id == selectedId
                                      ? MessageBubble.userAccent.opacity(0.9)
                                      : Color.white.opacity(0.08))
                        )
                        .foregroundColor(.white)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Version \(v.version)\(v.job_id == selectedId ? ", selected" : "")")
                }
            }
            .padding(.horizontal, 16 * k).padding(.vertical, 10 * k)
        }
    }

    // MARK: - Parked on a question

    @ViewBuilder
    private func parkedCard(_ question: String) -> some View {
        VStack(alignment: .leading, spacing: 6 * k) {
            Text("One question first").font(.system(size: 13 * k, weight: .semibold))
            // The worker writes this in the USER'S language; nothing on the row
            // says which, so it is rendered as-is and never re-worded here.
            Text(question).font(.system(size: 15 * k))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14 * k)
        .background(RoundedRectangle(cornerRadius: 14 * k, style: .continuous)
            .fill(MessageBubble.userAccent.opacity(0.18)))
        .padding(.horizontal, 16 * k)
        .padding(.bottom, 8 * k)
    }

    @ViewBuilder
    private func errorCard(_ message: String) -> some View {
        Text(message)
            .font(.system(size: 13 * k))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12 * k)
            .background(RoundedRectangle(cornerRadius: 12 * k, style: .continuous)
                .fill(Color.red.opacity(0.14)))
            .padding(.horizontal, 16 * k).padding(.bottom, 8 * k)
    }

    // MARK: - Composer

    private var isLocked: Bool {
        switch composer {
        case .lockedRendering, .sending, .loading: return true
        case .ready, .parked, .failed: return false
        }
    }

    /// Says WHICH state, always. A disabled field with no reason is how a user
    /// concludes the app is broken.
    private var placeholder: String {
        switch composer {
        case .loading:                return "Loading versions…"
        case .sending:                return "Sending…"
        case .lockedRendering:        return "Already re-editing this video — one at a time"
        case .parked:                 return "Answer the question above"
        case .ready, .failed:         return "Describe the change"
        }
    }

    @ViewBuilder
    private var composerBar: some View {
        HStack(spacing: 10 * k) {
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...4)
                .focused($focused)
                .disabled(isLocked)
                .opacity(isLocked ? 0.5 : 1)
                .font(.system(size: 16 * k))
            Button {
                Task { await send() }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 28 * k))
            }
            .disabled(isLocked || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .opacity(isLocked || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
        }
        .padding(.horizontal, 16 * k).padding(.vertical, 10 * k)
    }

    // MARK: - Actions

    /// THE COMPOSER COMES UP EITHER WAY. The only thing a /versions outcome
    /// decides is whether the strip is drawn — never whether the sheet works.
    private func load() async {
        composer = .loading
        let outcome: VersionsOutcome
        do {
            outcome = VersionsOutcome.forSuccess(
                try await ReeditVersionsSource.current.versions(forJobId: jobId))
        } catch {
            // No `.failed` here, on purpose and by ruling. Until the server half
            // merges this path is a 404 on every launch, and an error state
            // would tell the user their video is broken when the thing they came
            // to do still works.
            outcome = VersionsOutcome.forFailure(error)
        }
        loaded = outcome.response
        // `selectedId` nil means the composer targets the job the sheet was
        // opened for, which is the right target when there is no history.
        selectedId = outcome.response?.latest?.job_id
        composer = .ready
    }

    private func send() async {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }

        // ANSWERING A CLARIFICATION IS A RE-EDIT, not a separate rail. The reply
        // goes to the parked row's RETRY target, and the server cancels the
        // parked row and creates the new job in ONE transaction — so a user who
        // answers cannot get a 409 for their trouble.
        let target: String
        if case .parked(_, let retryJobId) = composer { target = retryJobId }
        else { target = selectedId ?? jobId }

        composer = .sending
        do {
            _ = try await APIService.shared.reeditFromJob(originalJobId: target, changeRequest: body)
            text = ""
            await load()                            // the new version appears in the strip
        } catch let APIError.reeditInFlight(inFlight) {
            // Read the state from the payload rather than inferring it.
            if inFlight.isParkedOnAQuestion {
                // THE 409 SAYS PARKED, NOT WHAT WAS ASKED. It carries `status`
                // and an id, never the question — so fetch the job and park on
                // the REAL text and the REAL target.
                //
                // The previous version used the in-flight id as the retry
                // target, which is the parked row itself: a row with no
                // rendered video, because the plan-diff failing to produce a
                // plan is why it asked. The server's own rule is the parent —
                // `retryTargetFor` returns parent_job_id and returns null
                // rather than ever retrying a row against itself.
                if let live = inFlight.jobId,
                   let fields = try? await APIService.shared.jobFields(jobId: live),
                   let q = fields.clarification_question, !q.isEmpty,
                   let retry = fields.clarification_retry_job_id {
                    composer = .parked(question: q, retryJobId: retry)
                } else {
                    // Parked, but the question could not be read. Say only what
                    // is known — and offer no reply target rather than a wrong
                    // one, since a reply to the parked row cannot succeed.
                    composer = .failed("This video is waiting on an earlier question. Open it from your library to answer that first.")
                }
            } else {
                composer = .lockedRendering(inFlightJobId: inFlight.jobId ?? jobId)
            }
        } catch {
            composer = .failed(error.localizedDescription)
        }
    }
}
