import SwiftUI
import AVKit
import Photos

struct MessageBubble: View {
    let message: ChatMessage
    /// Long-press → "Regenerate." Provided only on assistant text
    /// replies (not on the welcome message, in-flight thinking messages,
    /// or video render messages — those don't make sense to regenerate).
    var onRegenerate: (() -> Void)? = nil
    /// Long-press → "Edit." Provided only on user text messages.
    /// Pulls the message text into the input bar and removes everything
    /// from this message forward so the user can resend a revision.
    var onEdit: (() -> Void)? = nil
    /// Tap on the failed-render Retry button. Provided only on
    /// assistant render bubbles where the backend's structured
    /// failure said retryable: true AND we have the cached S3 URLs
    /// + vibe stored on the message. Calling this re-dispatches
    /// createVideoJob with the cached values — no re-upload, no
    /// re-type, single tap.
    var onRetry: (() -> Void)? = nil
    /// Start a fresh upload — post-render "make another" and the guided recovery
    /// after a non-retryable rejection. Wired to the composer's picker.
    var onMakeAnother: (() -> Void)? = nil

    /// Tap the red Cancel button on a processing render bubble (shown only
    /// before the edit recipe). Runs the full cancel: server cancel + daily-slot
    /// refund, SSE teardown, and bubble removal.
    var onCancel: (() -> Void)? = nil

    /// Phase D ask-back: called when the user answers or skips the ask, so the
    /// parent flips this bubble back to "processing" and the bar resumes.
    var onAskResolved: (() -> Void)? = nil

    /// SwiftUI-rendered markdown view for chat text.
    ///
    /// AttributedString(markdown:) handles **bold**, *italic*, `inline
    /// code`, ~~strikethrough~~, and [links](url). `inlineOnlyPreservingWhitespace`
    /// keeps newlines + list-line prefixes so multi-line replies render
    /// the way Gemini emitted them. If markdown parsing fails (rare —
    /// only on malformed input mid-stream), we fall back to plain text
    /// so we never show a blank message.
    @ViewBuilder
    private func bubbleText(_ content: String) -> some View {
        if let attr = try? AttributedString(
            markdown: content,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
        ) {
            Text(attr)
        } else {
            Text(content)
        }
    }

    /// Display-time safety net: never render engineering output in a failure
    /// bubble. A raw string that reads like an internal error (a code, JSON,
    /// "is not defined", a stack, an over-long blob) is swapped for a generic,
    /// friendly line. Belt-and-suspenders — callers already map to friendly
    /// copy, but this guarantees it even if a new code path forgets to.
    static func displaySafeError(_ raw: String?) -> String {
        let generic = "Something went wrong. Please try again."
        guard let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return generic }
        let looksTechnical =
            s.contains("is not defined") || s.contains("undefined") ||
            s.localizedCaseInsensitiveContains("error:") || s.contains("{") || s.hasPrefix("[") ||
            s.count > 160 ||
            s.range(of: "^[a-z][a-z0-9_]*$", options: .regularExpression) != nil   // snake_case code
        if looksTechnical {
            print("[error] suppressed technical error from bubble: \(s)")
            return generic
        }
        return s
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if message.role == .user {
                Spacer(minLength: 48)
                userContent
            } else {
                assistantContent
                Spacer(minLength: 48)
            }
        }
    }

    // MARK: - User (right-aligned, subtle gray container)

    @ViewBuilder
    private var userContent: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if let attachment = message.videoAttachment {
                if let thumb = attachment.thumbnail {
                    Image(uiImage: thumb)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 172, height: 229)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .accessibilityLabel("Attached video")
                } else if let thumbUrlStr = attachment.remoteThumbnailUrl, let thumbUrl = URL(string: thumbUrlStr) {
                    AsyncImage(url: thumbUrl) { phase in
                        if let image = phase.image {
                            image.resizable().aspectRatio(contentMode: .fill)
                        } else {
                            Color(.tertiarySystemBackground)
                        }
                    }
                    .frame(width: 172, height: 229)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .accessibilityLabel("Attached video")
                }
            }

            if !message.content.isEmpty {
                bubbleText(message.content)
                    .font(.system(.body, design: .default).weight(.regular))
                    .tracking(0.2)
                    .textSelection(.enabled)
                    .dynamicTypeSize(...DynamicTypeSize.accessibility3)
                    .foregroundColor(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
                    .background(
                        // User bubble: brighter glass — vision-pro feel,
                        // distinct from the assistant's softer treatment
                        // below so the conversation flow is legible.
                        ZStack {
                            RoundedRectangle(cornerRadius: 20, style: .continuous)
                                .fill(.ultraThinMaterial)
                            RoundedRectangle(cornerRadius: 20, style: .continuous)
                                .fill(
                                    LinearGradient(
                                        colors: [
                                            Color.white.opacity(0.14),
                                            Color.white.opacity(0.04)
                                        ],
                                        startPoint: .top, endPoint: .bottom
                                    )
                                )
                        }
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .contextMenu {
                        Button {
                            UIPasteboard.general.string = message.content
                        } label: {
                            Label("Copy", systemImage: "doc.on.doc")
                        }
                        if let onEdit {
                            Button {
                                onEdit()
                            } label: {
                                Label("Edit", systemImage: "pencil")
                            }
                        }
                    }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(message.videoAttachment != nil ? [] : [])
    }

    // MARK: - Assistant (left-aligned bubble, iMessage-style)

    @ViewBuilder
    private var assistantContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            if message.isThinking {
                // Typing indicator wrapped in the same bubble shape as a
                // real reply, so the transition from "thinking" to "answer"
                // feels like the bubble's content morphing in place.
                ThinkingDots()
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color.white.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }

            // §5 progressive playback: once the backend emits the HLS manifest
            // mid-render (flag-gated capture in EditorView), play it inline as a muted
            // PREVIEW that SWAPS in place to the final MP4 when it lands. Rendered here
            // in ONE stable position so the AVPlayer persists from manifest-arrival
            // through completion (seamless swap, not a teardown). The progress UI and
            // the completed thumbnail both step aside for it. Gated by the server flag
            // + a manifest + no error/pause. Inert until both halves flip on.
            let showProgressive = UsageService.shared.progressivePlaybackEnabled
                && message.hlsManifestUrl != nil
                && message.error == nil
                && message.jobStatus != "needs_input"
            if showProgressive {
                ProgressivePlayerView(
                    manifestUrl: message.hlsManifestUrl,
                    finalUrl: message.renderedVideoUrl,
                    posterUrl: message.thumbnailUrl,
                    onTapFullscreen: {
                        VideoPlayerPresenter.present(
                            urlString: message.renderedVideoUrl ?? message.hlsManifestUrl ?? "",
                            hlsManifestUrl: message.hlsManifestUrl,
                            thumbnailUrl: message.thumbnailUrl,
                            jobId: message.jobId,
                            title: message.originalVibe
                        )
                    }
                )
                .padding(.bottom, 6)
            }

            // Show the progress UI ONLY while the job is not terminal (and the
            // progressive preview isn't already owning the surface). Any terminal
            // status — completed/complete, failed/error, canceled/cancelled,
            // needs_input/needs_clarification — stops the spinner.
            if let status = message.jobStatus, !JobLifecycle.isTerminal(status), !showProgressive {
                if let timeline = message.stageTimeline {
                    // §5 plan preview: reflect the user's vibe + what Promptly is
                    // making, so the multi-minute wait reads as a craft in progress
                    // (not a dead spinner). Honest — these are what every edit gets.
                    // Hidden on the ask-back pause (the AskCard owns that moment).
                    if let vibe = message.originalVibe, status != "needs_input" {
                        PlanPreviewCard(vibe: vibe)
                            .padding(.bottom, 10)
                    }
                    PipelineProgressView(
                        timeline: timeline,
                        progress: message.jobProgress ?? 0,
                        subMessage: message.stepMessage,
                        finishing: message.isFinishing,
                        onCancel: onCancel
                    )
                } else {
                    ProcessingIndicator(
                        stepMessage: message.stepMessage ?? "Getting started...",
                        progress: message.jobProgress ?? 0,
                        finishing: message.isFinishing
                    )
                }
            }

            // Phase D ask-back: the job is parked on a question — render Lumen's
            // ask right under the (held) progress bar, in the same bubble.
            if message.jobStatus == "needs_input", let ask = message.ask, ask.isRenderable {
                AskCard(ask: ask, jobId: message.jobId ?? "") {
                    onAskResolved?()
                }
                .padding(.top, 8)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            if !message.content.isEmpty {
                bubbleText(message.content)
                    .font(.system(.body, design: .default).weight(.regular))
                    .tracking(0.2)
                    .textSelection(.enabled)
                    .dynamicTypeSize(...DynamicTypeSize.accessibility3)
                    .foregroundColor(.white)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
                    .background(
                        // Assistant bubble: subtler glass — softer than
                        // the user bubble so the conversation alternates
                        // with clear visual rhythm.
                        ZStack {
                            RoundedRectangle(cornerRadius: 20, style: .continuous)
                                .fill(.ultraThinMaterial)
                            RoundedRectangle(cornerRadius: 20, style: .continuous)
                                .fill(Color.white.opacity(0.03))
                        }
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.06), lineWidth: 0.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .contextMenu {
                        if message.error == nil {
                            Button {
                                UIPasteboard.general.string = message.content
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                            }
                        }
                        if let onRegenerate {
                            Button {
                                onRegenerate()
                            } label: {
                                Label(
                                    message.error != nil ? "Try again" : "Regenerate",
                                    systemImage: "arrow.clockwise"
                                )
                            }
                        }
                    }
            }

            if let videoUrlStr = message.renderedVideoUrl {
                CompletedVideoView(
                    videoUrlStr: videoUrlStr,
                    thumbnailUrlStr: message.thumbnailUrl,
                    hlsManifestUrl: message.hlsManifestUrl,
                    jobId: message.jobId,
                    title: message.originalVibe,
                    postPackage: message.postPackage,
                    onReedit: buildReeditHandler(for: message),
                    onMakeAnother: onMakeAnother,
                    // The inline progressive player already shows the (swapped) video;
                    // hide the redundant thumbnail but keep the re-edit/make-another row.
                    videoSurfaceHidden: showProgressive
                )
            }

            if message.jobStatus == "failed" || message.jobStatus == "error" {
                VStack(alignment: .leading, spacing: 10) {
                    Text(Self.displaySafeError(message.error))
                        .font(.system(size: 14))
                        .foregroundColor(.red)

                    // Credit reassurance (free tier): a failed render refunds the
                    // daily slot server-side (inline + backstop sweep), so the
                    // user's one-a-day is never burned by our failure. Say so —
                    // Pro has no daily limit, so it's free-tier only.
                    if !SubscriptionService.shared.effectiveIsPro {
                        HStack(spacing: 5) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 11))
                                .foregroundColor(.green.opacity(0.85))
                            Text("You weren't charged — this didn't use your daily render.")
                                .font(.system(size: 12))
                                .foregroundColor(Color(.secondaryLabel))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    // Try Again button — shown only when the backend
                    // marked this failure as retryable AND we have the
                    // cached S3 URLs to re-dispatch with. One tap re-
                    // submits the SAME source + proxy + vibe via
                    // createVideoJob; no upload, no re-typing.
                    if message.isRetryable,
                       message.cachedSourceUrl != nil,
                       let onRetry = onRetry {
                        Button {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            onRetry()
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "arrow.clockwise")
                                    .font(.system(size: 12, weight: .semibold))
                                Text("Try Again")
                                    .font(.system(size: 14, weight: .semibold))
                            }
                            .foregroundColor(.white)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                            .background(
                                Capsule().fill(Color.white.opacity(0.12))
                            )
                            .overlay(
                                Capsule().stroke(Color.white.opacity(0.18), lineWidth: 0.5)
                            )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Try again — re-runs the render with the same video and vibe")
                    } else if let onMakeAnother = onMakeAnother {
                        // Rejected-user recovery: for a content rejection (no speech,
                        // no audio, too short/long, not-talking-head), the SAME clip
                        // can't succeed — the honest copy above already names the fix,
                        // and this is the one-tap way to act on it. 140/198 rejected
                        // users quit after one rejection; this is the path back in.
                        Button {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            onMakeAnother()
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "video.badge.plus")
                                    .font(.system(size: 12, weight: .semibold))
                                Text("Upload a new video")
                                    .font(.system(size: 14, weight: .semibold))
                            }
                            .foregroundColor(.white)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                            .background(Capsule().fill(Color.white.opacity(0.12)))
                            .overlay(Capsule().stroke(Color.white.opacity(0.18), lineWidth: 0.5))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Upload a new video")
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Color.red.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        }
    }

    /// Produce the Re-edit closure for a completed video message. Requires a
    /// jobId (the server needs it as original_job_id to load the parent's
    /// saved edit_recipe / transcript / resolved B-roll). Nil when the message
    /// has no jobId — button is then hidden from the action row.
    private func buildReeditHandler(for message: ChatMessage) -> (() -> Void)? {
        guard let jobId = message.jobId else { return nil }
        let vibe = message.originalVibe ?? ""
        let thumb = message.thumbnailUrl
        return {
            Analytics.track("reedit_tap", props: ["source": "chat", "isPro": SubscriptionService.shared.effectiveIsPro])
            // Pro gate: re-edit is a paid feature. Free users get the
            // paywall sheet with the right reason copy; the actual re-edit
            // only fires when SubscriptionService says they're entitled.
            // effectiveIsPro consults BOTH RevenueCat and the server-derived
            // /api/usage snapshot so server-comped users (SQL update) work.
            if !SubscriptionService.shared.effectiveIsPro {
                AppState.shared.presentPaywall(.reedit)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                return
            }
            AppState.shared.pendingReedit = ReeditSession(
                originalJobId: jobId,
                oldVibe: vibe,
                thumbnailUrl: thumb
            )
            AppState.shared.selectedTab = 0  // no-op if already on Edit
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        }
    }
}

// MARK: - Thinking Dots (minimal, inline — no bubble)

struct ThinkingDots: View {
    @State private var animating = false
    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(Color(.secondaryLabel))
                    .frame(width: 7, height: 7)
                    .opacity(animating ? 1 : 0.3)
                    .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true).delay(Double(i) * 0.15), value: animating)
            }
        }
        .padding(.vertical, 4)
        .onAppear { animating = true }
    }
}

// MARK: - Smooth progress animator
//
// Drives a continuously-moving progress value on its own ~30fps clock. The
// pure pacing math lives in `TricklePacing` (see TricklePacing.swift, which is
// unit-tested standalone); this class is just the stateful animator that holds
// the clock, the latest backend value, and the displayed number.
//
// The bar is paced by TIME, not by the backend's percentage. The worker emits
// sparse, big pct steps that front-load bar points (0->66 in the first ~40% of
// wall-clock, then a slow crawl 75->94 through the long render) — feeding that
// in directly is what made the bar leap "25% -> 45% per step" and stall between
// heartbeats. Instead the bar fills smoothly over a fixed ~6.5 min estimate;
// the backend value is fed in only as an anti-stall ceiling tether (the bar
// won't sit more than a small margin past the last confirmed milestone, so a
// hang holds it rather than marching a lie to 95%). Hard-capped below 100 until
// `complete()`. See `TricklePacing` for the full rationale.
//
// Monotonic by construction: `displayed` only ever increases.
@MainActor
final class TrickleProgress: ObservableObject {
    /// 0–100, the value the UI shows. Updated ~30×/s while a render runs.
    @Published private(set) var displayed: Double = 0

    /// Highest backend-confirmed bar value (0–100). Never decreases. Fed to
    /// the pacing math as a ceiling tether, NOT as the displayed number.
    private var confirmedTarget: Double = 0
    /// Wall-clock the job has been animating against. Set once on first start
    /// and never rewound, so scrolling the bubble off/on screen (which cancels
    /// and restarts the driver) doesn't reset the time schedule.
    private var startedAt: Date?
    private var lastTickAt = Date()
    private var isComplete = false
    private var driver: Task<Void, Never>?

    /// Pure pacing math — clock-free, unit-tested in TricklePacing.swift.
    private let pacing = TricklePacing()

    /// Feed the latest backend-mapped bar value (0–100). Monotonic — a value
    /// at or below the current confirmed value is ignored.
    func update(target raw: Int) {
        let v = min(100, max(0, Double(raw)))
        if v > confirmedTarget { confirmedTarget = v }
        start()
    }

    /// Rehydrate the bar to a durable, polled progress value (the source of
    /// truth) — the lifecycle fix. Called on view-appear / foreground /
    /// relaunch. Snaps `displayed` UP to `polled` (never down — monotonic), and
    /// realigns the time schedule so the ramp continues forward from there
    /// instead of stalling until elapsed catches up. A no-op when the bar is
    /// already at or past `polled` (the normal scroll-off/on case), so it never
    /// rewinds an in-flight animation — it only heals a view that restarted at
    /// 0 (relaunch / SwiftUI recreate), which is what caused the 50%→1% snap.
    func rehydrate(to polled: Int) {
        let v = min(100, max(0, Double(polled)))
        if v > confirmedTarget { confirmedTarget = v }
        // The live bar LEADS the confirmed milestone by up to overshootMargin
        // (the time-paced tether). That lead lives only in this ephemeral
        // animator, so a view recreated on relaunch / scroll-back must
        // RECONSTRUCT it — otherwise displayed snaps down to the bare milestone,
        // a visible backward jump. Restore to milestone + allowed lead (≤ hardCap).
        let lead = min(pacing.hardCap, v + pacing.overshootMargin)
        if lead > displayed {
            displayed = lead
            // Back-date startedAt so the time schedule maps "now" to `lead`,
            // letting the pacing glide forward from the snapped position.
            startedAt = Date().addingTimeInterval(-pacing.elapsedForBar(lead))
        }
        start()
    }

    /// Real completion — release the cap and glide to 100.
    func complete() {
        isComplete = true
        start()
    }

    func start() {
        guard driver == nil else { return }
        if startedAt == nil { startedAt = Date() }
        lastTickAt = Date()
        driver = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 33_000_000) // ~30 fps
                guard let self else { return }
                if self.tick() { break }
            }
        }
    }

    func stop() {
        driver?.cancel()
        driver = nil
    }

    deinit { driver?.cancel() }

    /// Advance one frame via the pure pacing math. Returns true only when
    /// fully complete (nothing left to animate); otherwise keeps ticking so
    /// the time schedule keeps gliding between sparse backend updates.
    private func tick() -> Bool {
        let now = Date()
        let dt = min(0.1, max(0, now.timeIntervalSince(lastTickAt))) // clamp scheduler jitter
        lastTickAt = now
        let elapsed = now.timeIntervalSince(startedAt ?? now)
        let next = pacing.advance(
            displayed: displayed,
            elapsed: elapsed,
            backendBar: confirmedTarget,
            dt: dt,
            isComplete: isComplete
        )
        if next != displayed { displayed = next }
        return isComplete && displayed >= 100
    }
}

// MARK: - Processing Indicator (ChatGPT-style — inline, thin progress line)
//
// Bar position is owned by TrickleProgress: a self-driving ~30fps ramp
// that eases toward the backend target and never freezes or snaps.

struct ProcessingIndicator: View {
    let stepMessage: String
    let progress: Int              // target from upload/SSE
    var finishing: Bool = false    // true on real completion → release to 100
    @StateObject private var trickle = TrickleProgress()
    @State private var pulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Circle()
                    .fill(Color.white)
                    .frame(width: 6, height: 6)
                    .opacity(pulse ? 1 : 0.35)
                    .animation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true), value: pulse)

                Text(stepMessage)
                    .font(.system(size: 15))
                    .foregroundColor(.white)
                    .lineLimit(2)
                    // Smooth fade + slight slide when SSE rotates the
                    // stage message ("Watching your video" → "Reading
                    // the speaker's energy" → "Choosing visual
                    // treatments" etc.). Without this the text snaps
                    // between strings every 5-15s and reads as glitchy
                    // — the spec calls out that the transitions should
                    // "feel like work happening, not just text changes."
                    // .id ties the transition to the message content
                    // so SwiftUI treats each new string as a new view.
                    .id(stepMessage)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                    .animation(.easeInOut(duration: 0.28), value: stepMessage)

                Spacer(minLength: 8)

                Text("\(max(Int(trickle.displayed), 1))%")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.secondary)
                    .monospacedDigit()
                    .contentTransition(.numericText())
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color(.separator).opacity(0.5))
                    Capsule()
                        .fill(Color.white)
                        .frame(width: max(6, geo.size.width * CGFloat(max(0.02, trickle.displayed / 100.0))))
                }
            }
            .frame(height: 3)
        }
        .frame(maxWidth: 320, alignment: .leading)
        // No implicit .animation here — TrickleProgress already moves the
        // bar continuously at ~30fps, so the width follows it frame-by-
        // frame. An ease-out tween on top would fight that and re-introduce
        // the snap we're getting rid of.
        .onAppear {
            pulse = true
            // Rehydrate from the persisted/polled progress so a view that was
            // recreated (relaunch, scroll-on) starts at TRUE progress, not 0.
            // Clamp below 100 unless actually finishing, so a completed-but-
            // videoless row (progress=100, still in-flight) doesn't show 100%.
            trickle.rehydrate(to: finishing ? progress : min(progress, 99))
            if finishing { trickle.complete() }
        }
        .onDisappear { trickle.stop() }
        // Feed the backend value in as a target ceiling. The animator owns
        // monotonicity and all visual motion.
        .onChange(of: progress, initial: true) { _, new in
            trickle.update(target: finishing ? new : min(new, 99))
        }
        // Real completion → release the cap and sweep to 100.
        .onChange(of: finishing) { _, done in
            if done { trickle.complete() }
        }
    }
}

// MARK: - Pipeline Progress (stage-aware, skip-tolerant, expandable)
//
// Replaces ProcessingIndicator for jobs that have a StageTimeline. Shows:
//   - Active stage row: SF Symbol (pulsing) + stage title + smoothed percent
//   - Progress bar (same ticker smoothing as before, drives the numeric %)
//   - Completed trail: last two finished stages as a compact subtitle
//   - Expandable "View all steps" disclosure: per-stage status glyphs
//     (completed / in-progress / upcoming / skipped) with the skipped ones
//     struck-through + captioned "not needed"
//
// The display is driven by the observable StageTimeline on the message. All
// skip inference happens inside the timeline; this view is purely
// presentational.

/// §5 plan preview — a compact "here's what we're making" card shown atop the
/// progress bar during a render. Reflects the user's own vibe back to them and
/// lists what every Promptly edit delivers, so the wait feels like a craft in
/// progress. Purely honest reassurance — no fabricated per-clip specifics.
struct PlanPreviewCard: View {
    let vibe: String
    private static let gold = Color(red: 1, green: 0.82, blue: 0.5)
    private static let deliverables: [(icon: String, label: String)] = [
        ("captions.bubble", "Captions"),
        ("scissors", "Cuts"),
        ("paintpalette", "Color"),
        ("waveform", "Pacing"),
    ]
    private var trimmedVibe: String { vibe.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 6) {
                Image(systemName: "wand.and.sparkles")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Self.gold)
                Text("Making your edit")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.9))
            }
            if !trimmedVibe.isEmpty {
                Text("“\(trimmedVibe)”")
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.55))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 12) {
                ForEach(Self.deliverables, id: \.label) { d in
                    HStack(spacing: 4) {
                        Image(systemName: d.icon).font(.system(size: 10, weight: .semibold))
                        Text(d.label).font(.system(size: 11, weight: .medium))
                    }
                    .foregroundStyle(.white.opacity(0.7))
                }
            }
        }
        .padding(12)
        .frame(maxWidth: 300, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5))
    }
}

struct PipelineProgressView: View {
    @ObservedObject var timeline: StageTimeline
    let progress: Int
    /// Optional finer-grained SSE message (e.g. "Reading the speaker's
    /// energy" while the stage stays on `analyze`). Surfaced as a
    /// subtitle below the stage title so backend rotations within a
    /// single catalog stage are visible to the user — without this
    /// the stage label can sit on "Analyzing your video" for 30-60s
    /// while the backend cycles through more detailed copy, and the
    /// progress UI reads as frozen even though work is happening.
    var subMessage: String? = nil
    /// True on real completion → release the bar's cap and sweep to 100.
    var finishing: Bool = false
    /// Cancel action, provided only while the render is still cancellable
    /// (before the edit recipe). When set AND `timeline.isCancellable`, a small
    /// red Cancel button shows on the steps row; tapping it confirms, then runs
    /// this. Nil → no button (e.g. re-edits or past the cutoff).
    var onCancel: (() -> Void)? = nil
    // Self-driving bar position: TrickleProgress glides continuously at
    // ~30fps toward the backend target and never freezes or snaps. See
    // its definition above for why the old "mirror the backend pct"
    // model produced the stuck-at-90/99 and jumpy behavior.
    @StateObject private var trickle = TrickleProgress()
    @State private var lastUpdateAt: Date = Date()
    // Rotating fallback message shown when no SSE event has arrived
    // for several seconds. Nil when a real subMessage is available
    // (or recent activity exists).
    @State private var fallbackMessage: String? = nil
    @State private var fallbackIndex: Int = 0
    @State private var expanded: Bool = false
    @State private var showCancelConfirm: Bool = false

    private func relativeQuiet(_ s: TimeInterval) -> String {
        if s < 90 { return "\(Int(s))s" }
        return "\(Int(s / 60))m"
    }

    /// Rotated through when SSE goes quiet for 3.5s+. Keeps the user
    /// reassured that work is still happening even when the bar can't
    /// move (typical: bar sits at the cap of plan / render / upload
    /// heartbeats while the backend is heads-down for 30-90s).
    private static let stuckMessages = [
        "Hang tight\u{2026}",
        "Just a moment more\u{2026}",
        "Almost there\u{2026}"
    ]
    /// Swapped in after 60+ seconds of silence. Different copy so the
    /// user clocks that this particular render is on the long side
    /// without us declaring failure.
    private static let veryStuckMessages = [
        "This is taking a little longer than usual",
        "Still working on it\u{2026}",
        "Hanging in there\u{2026}"
    ]

    private var activeStage: PipelineStage? {
        if let did = timeline.currentDerivedId, let s = timeline.stages.first(where: { $0.id == did }) {
            return s
        }
        if let cid = timeline.currentStageId, let s = timeline.stages.first(where: { $0.id == cid }) {
            return s
        }
        // No stage has fired yet — show a neutral starting state instead of
        // pre-rendering the first catalog entry. The first server event lands
        // within a few hundred ms; during that window we don't want to
        // mislead the user about which specific stage is in progress.
        return nil
    }

    /// Last two completed stages, in order of completion.
    private var completedTrail: [PipelineStage] {
        let completedIds = Set(timeline.states.filter { $0.value == .completed }.map { $0.key })
        let completed = timeline.stages.filter { completedIds.contains($0.id) }
        return Array(completed.suffix(2))
    }

    /// What actually renders in the subtitle slot. Preference order:
    ///   1. The backend's SSE message if non-empty and not a duplicate
    ///      of the stage title.
    ///   2. The rotating fallback when SSE has gone quiet long enough
    ///      to set one.
    ///   3. Nothing.
    private var effectiveSubMessage: String? {
        if let sub = subMessage?.trimmingCharacters(in: .whitespacesAndNewlines),
           !sub.isEmpty,
           sub != (activeStage?.title ?? "") {
            return sub
        }
        return fallbackMessage
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Active stage header
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .center, spacing: 10) {
                    stageIcon
                    Text(activeStage?.title ?? "Starting")
                        .font(.system(size: 15))
                        .foregroundColor(.white)
                        .lineLimit(2)
                        .transition(.opacity)
                    Spacer(minLength: 8)
                    Text("\(max(Int(trickle.displayed), 1))%")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.secondary)
                        .monospacedDigit()
                        .contentTransition(.numericText())
                }
                .animation(.easeInOut(duration: 0.25), value: activeStage?.id)

                // SSE subtitle — finer-grained backend message that
                // rotates within a stage. Slides + fades on every
                // rotation so the user sees real motion even when
                // the headline stage label is unchanged.
                if let sub = effectiveSubMessage {
                    Text(sub)
                        .font(.system(size: 12))
                        .foregroundColor(Color.white.opacity(0.6))
                        .lineLimit(2)
                        .padding(.leading, 28)  // align past the stageIcon
                        .id(sub)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                        .animation(.easeInOut(duration: 0.28), value: sub)
                }

                // Honest liveness (stuck-jobs directive): when events go
                // quiet for 20s+, say exactly HOW stale we are instead of
                // only rotating reassurance copy. Slow-and-alive must look
                // different from dead — that's what makes the failure card
                // trustworthy when it does appear.
                TimelineView(.periodic(from: .now, by: 5)) { context in
                    let quiet = context.date.timeIntervalSince(lastUpdateAt)
                    if quiet >= 20 {
                        Text("still working — last update \(relativeQuiet(quiet)) ago")
                            .font(.system(size: 11))
                            .foregroundColor(Color.white.opacity(0.45))
                            .padding(.leading, 28)
                            .transition(.opacity)
                    }
                }
            }

            // Progress bar. Width follows `trickle.displayed`, which the
            // animator advances continuously at ~30fps — no implicit
            // tween needed (or wanted: it would re-introduce the snap).
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color(.separator).opacity(0.5))
                    Capsule()
                        .fill(Color.white)
                        .frame(width: max(6, geo.size.width * CGFloat(max(0.02, trickle.displayed / 100.0))))
                }
            }
            .frame(height: 3)

            // Completed trail — last two finished stages, compact
            if !completedTrail.isEmpty {
                HStack(spacing: 10) {
                    ForEach(completedTrail) { stage in
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark")
                                .font(.system(size: 9, weight: .semibold))
                            Text(stage.title)
                                .font(.system(size: 11))
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                        .foregroundColor(Color(.secondaryLabel))
                    }
                    Spacer(minLength: 0)
                }
                .transition(.opacity)
            }

            // Steps disclosure (leading) + a red Cancel button (trailing), the
            // latter only while the render is still cancellable — before the
            // edit recipe. It fades/scales out the instant the pipeline reaches
            // `plan`, so the affordance disappears exactly when cancelling can no
            // longer save the GPU work.
            HStack(spacing: 12) {
                Button {
                    withAnimation(.easeInOut(duration: 0.22)) { expanded.toggle() }
                } label: {
                    HStack(spacing: 4) {
                        Text(expanded ? "Hide steps" : "View all steps")
                            .font(.system(size: 12, weight: .medium))
                        Image(systemName: "chevron.down")
                            .font(.system(size: 10, weight: .semibold))
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                    .foregroundColor(Color(.secondaryLabel))
                }
                .buttonStyle(.plain)

                Spacer(minLength: 8)

                if let onCancel, timeline.isCancellable {
                    Button(role: .destructive) {
                        showCancelConfirm = true
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 12, weight: .semibold))
                            Text("Cancel")
                                .font(.system(size: 12, weight: .semibold))
                        }
                        .foregroundColor(.red)
                        .padding(.vertical, 4)
                        .padding(.horizontal, 10)
                        .background(
                            Capsule().fill(Color.red.opacity(0.12))
                        )
                    }
                    .buttonStyle(.plain)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                    .confirmationDialog(
                        "Cancel this render?",
                        isPresented: $showCancelConfirm,
                        titleVisibility: .visible
                    ) {
                        Button("Cancel render", role: .destructive) { onCancel() }
                        Button("Keep rendering", role: .cancel) {}
                    } message: {
                        Text("This stops the edit before it starts — your daily render won't be used.")
                    }
                }
            }
            .animation(.easeInOut(duration: 0.2), value: timeline.isCancellable)

            if expanded {
                // Only reveal stages that have actually begun (in_progress /
                // completed / skipped). Upcoming ones stay hidden until the
                // server fires their event — the list grows as the pipeline
                // progresses instead of dumping the whole roadmap on the
                // user at once.
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(timeline.stages.filter { (timeline.states[$0.id] ?? .upcoming) != .upcoming }) { stage in
                        stageRow(stage)
                            .transition(.opacity.combined(with: .move(edge: .leading)))
                    }
                }
                .padding(.top, 2)
                .animation(.easeOut(duration: 0.25), value: timeline.currentStageId)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: 340, alignment: .leading)
        // Rehydrate from the persisted/polled progress so a view recreated on
        // relaunch (or scrolled back on) resumes at TRUE progress instead of
        // re-ramping from 0 — the 50%→1% snap-back fix.
        // Clamp below 100 unless actually finishing, so a completed-but-
        // videoless row (progress=100, still in-flight) never shows 100%.
        .onAppear { trickle.rehydrate(to: finishing ? progress : min(progress, 99)) }
        .onDisappear { trickle.stop() }
        // Feed the backend value in as a target ceiling. TrickleProgress
        // owns monotonicity (a lower pct is ignored for positioning) and
        // all visual motion — it glides continuously rather than snapping.
        // Every event also counts as activity so the stale-watcher resets.
        .onChange(of: progress, initial: true) { _, new in
            lastUpdateAt = Date()
            fallbackMessage = nil
            fallbackIndex = 0
            trickle.update(target: finishing ? new : min(new, 99))
        }
        // Any backend message change is also activity — reset stale.
        .onChange(of: subMessage) { _, _ in
            lastUpdateAt = Date()
            fallbackMessage = nil
            fallbackIndex = 0
        }
        // Real completion → release the cap and sweep to 100. initial: true so a
        // bubble restored mid-finish still releases on appear.
        .onChange(of: finishing, initial: true) { _, done in
            if done { trickle.complete() }
        }
        .task {
            // Stale-progress watcher. Does NOT touch the bar position.
            // Rotates a reassuring fallback message into the subtitle
            // slot whenever no SSE event has landed for 3.5s+. After
            // 60s, the copy shifts to "taking longer than usual"
            // variants so the user knows the render is on the long
            // side — without ever claiming failure.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_500_000_000)
                if Task.isCancelled { break }
                let silentSec = Date().timeIntervalSince(lastUpdateAt)
                guard silentSec >= 3.0 else { continue }
                let pool = silentSec > 60
                    ? Self.veryStuckMessages
                    : Self.stuckMessages
                fallbackMessage = pool[fallbackIndex % pool.count]
                fallbackIndex += 1
            }
        }
    }

    @ViewBuilder
    private var stageIcon: some View {
        if let stage = activeStage {
            Image(systemName: stage.icon)
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(.white)
                .symbolEffect(.pulse.byLayer, options: .repeating)
                .frame(width: 20, height: 20)
                .transition(.scale.combined(with: .opacity))
        } else {
            // Neutral "Starting…" glyph shown during the brief window between
            // user tapping Send and the first stage event arriving. Avoids
            // leading with a specific stage label before the worker confirms it.
            Image(systemName: "sparkles")
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(.white)
                .symbolEffect(.pulse.byLayer, options: .repeating)
                .frame(width: 20, height: 20)
        }
    }

    @ViewBuilder
    private func stageRow(_ stage: PipelineStage) -> some View {
        let state = timeline.states[stage.id] ?? .upcoming
        HStack(spacing: 10) {
            Group {
                switch state {
                case .completed:
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.white)
                case .inProgress:
                    Image(systemName: stage.icon)
                        .foregroundColor(.white)
                        .symbolEffect(.pulse.byLayer, options: .repeating)
                case .upcoming:
                    Image(systemName: "circle")
                        .foregroundColor(Color(.tertiaryLabel))
                case .skipped:
                    Image(systemName: "minus.circle")
                        .foregroundColor(Color(.tertiaryLabel))
                }
            }
            .font(.system(size: 14))
            .frame(width: 18, height: 18)

            Text(stage.title)
                .font(.system(size: 13))
                .foregroundColor(rowTextColor(state))
                .strikethrough(state == .skipped, color: Color(.tertiaryLabel))
                .lineLimit(1)

            if state == .skipped {
                Text("not needed")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(Color(.tertiaryLabel))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color(.tertiarySystemBackground).opacity(0.6))
                    .clipShape(Capsule())
            }

            Spacer(minLength: 0)
        }
        .padding(.leading, stage.parent != nil ? 20 : 0)
    }

    private func rowTextColor(_ state: StageState) -> Color {
        switch state {
        case .completed, .inProgress: return .white
        case .upcoming:               return Color(.secondaryLabel)
        case .skipped:                return Color(.tertiaryLabel)
        }
    }
}

// MARK: - Video Exporter (Save to Photos)
//
// One VideoExporter per completed video message (via @StateObject on the
// VideoActionRow). Manages:
//   - Single download of the remote MP4 to a temp file (cached for the
//     session so re-taps don't re-download).
//   - Save-to-Photos with idle / loading / success / error state.
//
// All other share destinations go through the iOS share sheet
// (`shareLinkPill` → `ShareLink`), which handles AirDrop, Messages,
// Mail, copy-to-pasteboard, and any third-party app the user has
// installed (TikTok, Instagram, etc.) without us having to maintain
// per-app SDKs.

@MainActor
final class VideoExporter: ObservableObject {
    let videoUrlStr: String
    let thumbnailUrlStr: String?
    /// Optional job id so the EXPORT funnel event (`export_completed`) can be
    /// tied back to the render. nil for surfaces that don't supply one.
    let jobId: String?

    @Published var saveState: ActionState = .idle

    private var cachedLocalUrl: URL?
    private var cachedAssetId: String?

    enum ActionState: Equatable {
        case idle, loading, success
        case error(String)
    }

    enum ExportError: LocalizedError {
        case invalidUrl
        case photosDenied
        case saveFailed(String)
        case appNotInstalled(String)
        /// Export gate returned 402 — sentinel so save() presents the paywall
        /// instead of an error, and NEVER falls back to the free public save.
        case exportGated

        var errorDescription: String? {
            switch self {
            case .invalidUrl:        return "Invalid video URL"
            case .photosDenied:      return "Photos access was denied"
            case .saveFailed(let m): return "Couldn't save: \(m)"
            case .appNotInstalled(let app): return "\(app) isn't installed"
            case .exportGated:       return "Upgrade to save the clean version"
            }
        }
    }

    init(videoUrlStr: String, thumbnailUrlStr: String?, jobId: String? = nil) {
        self.videoUrlStr = videoUrlStr
        self.thumbnailUrlStr = thumbnailUrlStr
        self.jobId = jobId
    }

    // MARK: - Private helpers

    private func ensureLocalFile(from urlStr: String) async throws -> URL {
        if let cached = cachedLocalUrl, FileManager.default.fileExists(atPath: cached.path) {
            return cached
        }
        guard let remoteUrl = URL(string: urlStr) else { throw ExportError.invalidUrl }
        let (tempUrl, _) = try await URLSession.shared.download(from: remoteUrl)
        let finalUrl = FileManager.default.temporaryDirectory
            .appendingPathComponent("promptly-export-\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: finalUrl)
        try FileManager.default.moveItem(at: tempUrl, to: finalUrl)
        cachedLocalUrl = finalUrl
        return finalUrl
    }

    /// Resolve the URL to download for a save/export. With a jobId, the server
    /// export gate decides: 200 → the clean signed URL; 402 → paywall (throws
    /// exportGated, caller NEVER falls back); 404/network → the public preview.
    /// Without a jobId (LibraryView) → the public URL, ungated. The 402→paywall
    /// vs 404/network→fallback split is the whitelist in APIService.exportAction —
    /// a 402 that fell back would defeat the paywall for every shipped client.
    private func resolveExportSourceUrl() async throws -> String {
        guard let jobId else { return videoUrlStr }
        do {
            let signed = try await APIService.shared.exportJob(jobId: jobId)
            return signed.absoluteString                       // 200 — clean export
        } catch {
            switch APIService.exportAction(for: error) {
            case .paywall:            throw ExportError.exportGated           // 402 — NEVER fall back
            case .fallbackPublicSave: return videoUrlStr                     // 404 / network
            case .surfaceError:       throw ExportError.saveFailed("export prep failed")
            case .save:               return videoUrlStr                     // unreachable; keep total
            }
        }
    }

    private func ensureSavedToPhotos() async throws -> String {
        if let cached = cachedAssetId { return cached }

        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            throw ExportError.photosDenied
        }

        let sourceUrl = try await resolveExportSourceUrl()
        let localFile = try await ensureLocalFile(from: sourceUrl)

        var placeholderId: String?
        try await PHPhotoLibrary.shared().performChanges {
            if let req = PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: localFile) {
                placeholderId = req.placeholderForCreatedAsset?.localIdentifier
            }
        }
        guard let id = placeholderId else { throw ExportError.saveFailed("no asset id") }
        cachedAssetId = id
        // EXPORT funnel: a NEW asset was just written to the camera roll — fire
        // once per real save (repeat taps hit the cachedAssetId early-return at
        // the top of this method and don't re-fire). job_id is attached when the
        // constructing surface supplied one (MessageBubble does; LibraryView
        // builds VideoExporter without a jobId, so those saves omit it).
        var exportProps: [String: Any] = ["method": "save"]
        if let jobId { exportProps["job_id"] = jobId }
        Analytics.track("export_completed", props: exportProps)
        return id
    }

    // MARK: - Public actions

    func save() {
        Task {
            saveState = .loading
            do {
                _ = try await ensureSavedToPhotos()
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                saveState = .success
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if saveState == .success { saveState = .idle }
            } catch ExportError.exportGated {
                // 402 — present the export paywall. NEVER save, NEVER show an error.
                // (Using .manual until an .export PaywallReason with watermark copy
                // is added; the gate itself is what matters here.)
                saveState = .idle
                await MainActor.run { AppState.shared.presentPaywall(.manual) }
            } catch {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                saveState = .error(error.localizedDescription)
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if case .error = saveState { saveState = .idle }
            }
        }
    }

}

// MARK: - Video Action Row (iOS Share Sheet aesthetic — circle icon + label)

struct VideoActionRow: View {
    let videoUrlStr: String
    let thumbnailUrlStr: String?
    /// Threaded through so the share/save EXPORT events carry job_id.
    let jobId: String?
    let onReedit: (() -> Void)?
    let onMakeAnother: (() -> Void)?
    @StateObject private var exporter: VideoExporter
    // Observe both signals so the Re-edit pill re-renders (gold ↔ lock)
    // the moment Pro state flips — a fresh purchase or an SQL comp on
    // an open chat lights up the icon without an app relaunch.
    @ObservedObject private var subscription = SubscriptionService.shared
    @ObservedObject private var usage = UsageService.shared

    init(videoUrlStr: String, thumbnailUrlStr: String?, jobId: String? = nil, onReedit: (() -> Void)?, onMakeAnother: (() -> Void)? = nil) {
        self.videoUrlStr = videoUrlStr
        self.thumbnailUrlStr = thumbnailUrlStr
        self.jobId = jobId
        self.onReedit = onReedit
        self.onMakeAnother = onMakeAnother
        _exporter = StateObject(wrappedValue: VideoExporter(videoUrlStr: videoUrlStr, thumbnailUrlStr: thumbnailUrlStr, jobId: jobId))
    }

    private var isPro: Bool { subscription.isPro || usage.isPro }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // HERO: Share — the growth action. A finished edit does nothing
            // sitting in the app; sharing it is the point, so it leads as the
            // one primary button instead of being one of four equal pills.
            shareHeroButton

            // Secondary actions — save, re-edit, start another.
            HStack(spacing: 14) {
                pill(
                    icon: "square.and.arrow.down",
                    label: "Save",
                    state: exporter.saveState,
                    action: exporter.save
                )
                if let onReedit {
                    reeditPill(action: onReedit)
                }
                // Post-render next action: keep the momentum instead of
                // dead-ending the win. One tap starts a fresh video.
                if let onMakeAnother {
                    makeAnotherPill(action: onMakeAnother)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.top, 8)
    }

    /// "New" pill — a plain circle+label action matching the row rhythm (the
    /// stateful `pill(...)` is for export progress; this one has no state).
    private func makeAnotherPill(action: @escaping () -> Void) -> some View {
        Button(action: {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        }) {
            VStack(spacing: 6) {
                ZStack {
                    Circle().fill(Color(.tertiarySystemBackground))
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(Color(.secondaryLabel))
                }
                .frame(width: 48, height: 48)
                .overlay(Circle().stroke(Color.white.opacity(0.08), lineWidth: 0.5))
                Text("New")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(Color(.secondaryLabel))
                    .lineLimit(1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Make another video")
    }

    // MARK: - Pill subviews

    /// Re-edit pill — visually swaps between two states:
    ///   - Pro: the wand icon paints with the PromptlyGold gradient and
    ///     the circle gets a faint gold border + soft gold glow so the
    ///     button reads "premium". Tap fires the onReedit closure directly.
    ///   - Free: the icon stays muted (.secondaryLabel) and a tiny
    ///     lock badge sits at the bottom-right of the circle, mirroring
    ///     how App Store / Photos overlay status icons. Tap still fires
    ///     the closure — the closure itself is the actual gate (it pops
    ///     the paywall sheet). UI here is purely about communicating
    ///     "this is locked, but tap to see why."
    /// Same hit-target size and label as the other pills so the action
    /// row keeps a clean rhythm regardless of state.
    @ViewBuilder
    private func reeditPill(action: @escaping () -> Void) -> some View {
        Button(action: {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        }) {
            VStack(spacing: 6) {
                ZStack {
                    Circle().fill(Color(.tertiarySystemBackground))
                    if isPro {
                        Image(systemName: "wand.and.stars")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(PromptlyGold.gradient)
                    } else {
                        Image(systemName: "wand.and.stars")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(Color(.secondaryLabel))
                    }
                }
                .frame(width: 48, height: 48)
                .overlay(
                    Circle()
                        .stroke(
                            isPro ? AnyShapeStyle(PromptlyGold.gradient)
                                  : AnyShapeStyle(Color.white.opacity(0.08)),
                            lineWidth: isPro ? 1.2 : 0.5
                        )
                )
                .shadow(
                    color: isPro ? PromptlyGold.solid.opacity(0.35) : .clear,
                    radius: 8, y: 0
                )
                // Lock badge — overlay the bottom-right corner with a
                // small filled circle + lock glyph. Same idiom Apple
                // uses on locked Photos / App Store buttons.
                .overlay(alignment: .bottomTrailing) {
                    if !isPro {
                        ZStack {
                            Circle()
                                .fill(Color(.systemBackground))
                                .frame(width: 18, height: 18)
                            Image(systemName: "lock.fill")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(Color(.secondaryLabel))
                        }
                        .offset(x: 2, y: 2)
                    }
                }

                Text("Re-edit")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(Color(.secondaryLabel))
                    .lineLimit(1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Re-edit this video")
        .accessibilityValue(isPro ? "" : "Pro feature, tap to unlock")
    }

    @ViewBuilder
    private func pill(
        icon: String,
        label: String,
        state: VideoExporter.ActionState,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        }) {
            VStack(spacing: 6) {
                ZStack {
                    Circle().fill(Color(.tertiarySystemBackground))
                    pillSymbol(icon: icon, state: state)
                }
                .frame(width: 48, height: 48)
                .overlay(
                    Circle()
                        .stroke(Color.white.opacity(0.08), lineWidth: 0.5)
                )

                Text(labelText(state: state, defaultLabel: label))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(Color(.secondaryLabel))
                    .lineLimit(1)
                    .contentTransition(.identity)
            }
        }
        .buttonStyle(.plain)
        .disabled(state == .loading)
        // Combine the icon + text into one VoiceOver element with a
        // dedicated label per action and a value reflecting in-flight
        // state. Stops VoiceOver from reading the SF symbol name.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(for: label))
        .accessibilityValue(accessibilityValue(for: state))
    }

    private func accessibilityLabel(for label: String) -> String {
        switch label {
        case "Re-edit": return "Re-edit this video"
        case "Save":    return "Save video to Photos"
        default:        return label
        }
    }

    private func accessibilityValue(for state: VideoExporter.ActionState) -> String {
        switch state {
        case .idle:     return ""
        case .loading:  return "in progress"
        case .success:  return "done"
        case .error:    return "failed"
        }
    }

    @ViewBuilder
    private func pillSymbol(
        icon: String,
        state: VideoExporter.ActionState
    ) -> some View {
        switch state {
        case .idle:
            Image(systemName: icon)
                .font(.system(size: 18, weight: .medium))
                .foregroundColor(.white)
                .symbolRenderingMode(.hierarchical)
        case .loading:
            ProgressView()
                .controlSize(.small)
                .tint(.white)
        case .success:
            Image(systemName: "checkmark")
                .font(.system(size: 18, weight: .bold))
                .foregroundColor(.white)
                .transition(.scale.combined(with: .opacity))
        case .error:
            Image(systemName: "exclamationmark")
                .font(.system(size: 18, weight: .bold))
                .foregroundColor(.white)
        }
    }

    private func labelText(state: VideoExporter.ActionState, defaultLabel: String) -> String {
        switch state {
        case .success: return "Done"
        case .error:   return "Error"
        default:       return defaultLabel
        }
    }

    /// Share promoted to the primary CTA — a full-width filled button, not one
    /// of four equal circle pills. This is the §6 "Share as hero" change.
    @ViewBuilder
    private var shareHeroButton: some View {
        if let url = URL(string: videoUrlStr) {
            ShareLink(item: url) {
                HStack(spacing: 8) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 16, weight: .semibold))
                    Text("Share")
                        .font(.system(size: 16, weight: .semibold))
                }
                .foregroundColor(.black)
                .frame(maxWidth: 300)
                .padding(.vertical, 13)
                .background(Capsule().fill(Color.white))
            }
            .accessibilityLabel("Share your video")
            .accessibilityAddTraits(.isButton)
            .simultaneousGesture(TapGesture().onEnded {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                // EXPORT funnel: ShareLink exposes NO completion callback, so
                // "share" is counted on INITIATION (intent-to-share) when the
                // user taps the hero share pill — not on delivery confirmation.
                var exportProps: [String: Any] = ["method": "share"]
                if let jobId { exportProps["job_id"] = jobId }
                Analytics.track("export_completed", props: exportProps)
            })
        }
    }
}

// MARK: - §6 Post package (posting-ready copy under a finished video)

/// The payoff block shown under a completed video: the hook as a headline, the
/// paste-ready caption in a card with a Copy button, and the edit rationale as a
/// quiet "why this edit" note. Each field is optional — only what's present is
/// shown; `hasContent` gates the whole block at the call site.
struct PostPackageView: View {
    let package: PostPackage
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let hook = package.postHook {
                Text(hook)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(.white)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }

            if let caption = package.postCaption {
                VStack(alignment: .leading, spacing: 9) {
                    Text(caption)
                        .font(.system(size: 14))
                        .foregroundColor(Color(.label))
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                    Button {
                        UIPasteboard.general.string = caption
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        withAnimation(.easeInOut(duration: 0.2)) { copied = true }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                            withAnimation(.easeInOut(duration: 0.2)) { copied = false }
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                                .font(.system(size: 12, weight: .semibold))
                            Text(copied ? "Copied" : "Copy caption")
                                .font(.system(size: 13, weight: .semibold))
                        }
                        .foregroundColor(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(Capsule().fill(Color.white.opacity(0.14)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(copied ? "Caption copied" : "Copy caption")
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                )
            }

            if let why = package.editRationale {
                HStack(alignment: .top, spacing: 7) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 12))
                        .foregroundColor(Color(.tertiaryLabel))
                        .padding(.top, 1)
                    Text(why)
                        .font(.system(size: 13))
                        .foregroundColor(Color(.secondaryLabel))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: 300, alignment: .leading)
    }
}

// MARK: - Completed Video (clean thumbnail tile + in-chat quick actions)
//
// Tapping the thumbnail presents PromptlyPlayerHostVC — the custom
// player with poster-first rendering, glass overlay, frame-strip
// scrubber, and HLS-preferred streaming. Pre-warms the AVAsset on
// thumbnail mount so first-frame paint after tap is sub-100 ms.
//
// Below the thumbnail: VideoActionRow — Re-edit / Save / Share pill
// buttons so the user never has to leave the chat for common tasks.

struct CompletedVideoView: View {
    let videoUrlStr: String
    let thumbnailUrlStr: String?
    let hlsManifestUrl: String?
    let jobId: String?
    let title: String?
    /// §6 post package — posting-ready copy (hook / caption / rationale) shown
    /// between the video surface and the action row. nil → nothing rendered.
    let postPackage: PostPackage?
    let onReedit: (() -> Void)?
    let onMakeAnother: (() -> Void)?
    /// §5 progressive: when the inline ProgressivePlayerView owns the video surface
    /// (the preview→final swap plays inline above), hide this view's static thumbnail
    /// tile but KEEP the action row (re-edit / make another). Default false — zero
    /// change to the normal completed UX.
    var videoSurfaceHidden: Bool = false

    /// When AsyncImage hits a 403 (signed URL expired past 7 days),
    /// we ask the server for fresh URLs and stash them here. Future
    /// renders of this view use the live URLs in preference to the
    /// stale stored ones.
    @State private var liveVideoUrl: String?
    @State private var liveThumbnailUrl: String?
    @State private var refreshAttempted = false
    /// Shows the subtle "Happy with this edit?" feedback card under this video.
    /// Set only when the user taps play AND FeedbackManager says we're due
    /// (rare, frequency-capped). Lives per-video so only the watched one asks.
    @State private var showFeedbackPrompt = false

    /// ACTIVATION funnel dedupe: `result_viewed` fires at most once per
    /// appearance-session of this completed result, so scrolling the bubble
    /// on/off screen doesn't spam the event.
    @State private var didTrackViewed = false

    /// Drives the loading-vs-playable thumbnail state. Updates the
    /// instant `VideoCache.shared.cachedIds` flips for this jobId.
    @ObservedObject private var cache = VideoCache.shared

    private var effectiveVideoUrl: String { liveVideoUrl ?? videoUrlStr }
    private var effectiveThumbnailUrl: String? { liveThumbnailUrl ?? thumbnailUrlStr }
    private var isCached: Bool {
        guard let jobId else { return false }
        return cache.cachedIds.contains(jobId)
    }
    /// CDN-backed URLs are safe to play directly — AVPlayer streams
    /// from the edge with consistent throughput. No need to wait for
    /// a local cache. Origin S3 URLs require the cache-first path.
    private var isStreamingReady: Bool {
        isStreamingReadyUrl(effectiveVideoUrl)
    }
    /// The play button (and tap) unlock when EITHER the file is
    /// already cached OR the URL points at our CDN. Background
    /// download still runs for offline replay either way.
    private var isPlayable: Bool {
        isCached || isStreamingReady
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if !videoSurfaceHidden {
            Button {
                guard isPlayable else { return }
                // The user is watching a finished render — the natural, earned
                // moment to (occasionally) ask for feedback. Record the watch,
                // then let FeedbackManager decide if we're due (rare + capped).
                // The card renders under the video, so it's waiting when they
                // close the player rather than interrupting playback.
                FeedbackManager.shared.recordRenderWatched()
                if FeedbackManager.shared.shouldShowPrompt() {
                    FeedbackManager.shared.recordPromptShown()
                    withAnimation(.easeInOut(duration: 0.28)) { showFeedbackPrompt = true }
                }
                VideoPlayerPresenter.present(
                    urlString: effectiveVideoUrl,
                    hlsManifestUrl: hlsManifestUrl,
                    thumbnailUrl: effectiveThumbnailUrl,
                    jobId: jobId,
                    title: title,
                    onReedit: onReedit,
                    onRefreshNeeded: { await self.refreshAndReturnVideoUrl() }
                )
            } label: {
                thumbnailContent
                    .frame(maxWidth: 240)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay {
                        LinearGradient(
                            colors: [.black.opacity(0.0), .black.opacity(0.25)],
                            startPoint: .center, endPoint: .bottom
                        )
                        .allowsHitTesting(false)
                    }
                    .overlay { thumbnailOverlay }
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!isPlayable)
            .accessibilityLabel(isPlayable ? "Play your edited video" : "Preparing your edited video")
            .accessibilityAddTraits(.isButton)
            .task(id: jobId) {
                // Auto-download the moment this thumbnail comes on screen
                // (no-op if already cached or in flight). Once it lands,
                // VideoCache flips cachedIds and the overlay swaps to
                // the play button without any user action.
                guard let jobId else { return }
                // Pre-warm the AVAsset so that when the user taps Play,
                // tracks/duration are already loaded and first-frame paint
                // is sub-100ms instead of the 300-800ms cold-load window.
                // For streaming-ready URLs this is a small metadata fetch
                // (~moov atom); for cached file URLs the warm hits disk.
                if isStreamingReady {
                    PlayerAssetPrewarm.shared.warm(effectiveVideoUrl)
                }
                if cache.cachedIds.contains(jobId) {
                    if let local = VideoCache.shared.localUrl(forJobId: jobId)?.absoluteString {
                        PlayerAssetPrewarm.shared.warm(local)
                    }
                    return
                }
                _ = await VideoCache.shared.downloadIfNeeded(
                    jobId: jobId,
                    from: effectiveVideoUrl,
                    priority: .userInitiated
                )
                if let local = VideoCache.shared.localUrl(forJobId: jobId)?.absoluteString {
                    PlayerAssetPrewarm.shared.warm(local)
                }
            }
            .contextMenu {
                if isPlayable, let url = URL(string: videoUrlStr) {
                    ShareLink(item: url) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                    // EXPORT funnel: ShareLink has no completion callback, so
                    // "share" counts INITIATION (intent-to-share) on tap of the
                    // context-menu share item. jobId is in scope here
                    // (CompletedVideoView property). Fires best-effort — taps
                    // inside a system context menu aren't guaranteed to deliver
                    // a gesture, so the hero share pill is the primary signal.
                    .simultaneousGesture(TapGesture().onEnded {
                        var exportProps: [String: Any] = ["method": "share"]
                        if let jobId { exportProps["job_id"] = jobId }
                        Analytics.track("export_completed", props: exportProps)
                    })
                    Button {
                        UIApplication.shared.open(url)
                    } label: {
                        Label("Open in Safari", systemImage: "safari")
                    }
                    Button {
                        UIPasteboard.general.string = videoUrlStr
                    } label: {
                        Label("Copy Link", systemImage: "link")
                    }
                }
            }
            } // end if !videoSurfaceHidden

            // §6 payoff: posting-ready copy under the video — the hook, the
            // paste-ready caption, and the "why this edit" note. Renders only
            // the fields that survived; absent package → nothing (no empty box).
            if let pkg = postPackage, pkg.hasContent {
                PostPackageView(package: pkg)
                    .padding(.top, 10)
            }

            VideoActionRow(
                videoUrlStr: videoUrlStr,
                thumbnailUrlStr: thumbnailUrlStr,
                jobId: jobId,
                onReedit: onReedit,
                onMakeAnother: onMakeAnother
            )
            .opacity(isPlayable ? 1 : 0.4)
            .disabled(!isPlayable)

            if showFeedbackPrompt {
                FeedbackPromptView(
                    onThumbsUp: {
                        FeedbackManager.shared.recordThumbsUp()
                        Task { await FeedbackManager.shared.submitFeedback(rating: "up", text: nil, jobId: jobId) }
                        withAnimation(.easeInOut(duration: 0.28)) { showFeedbackPrompt = false }
                    },
                    onThumbsDown: { note in
                        FeedbackManager.shared.recordThumbsDown()
                        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task { await FeedbackManager.shared.submitFeedback(rating: "down", text: trimmed.isEmpty ? nil : trimmed, jobId: jobId) }
                        withAnimation(.easeInOut(duration: 0.28)) { showFeedbackPrompt = false }
                    },
                    onDismiss: {
                        FeedbackManager.shared.recordDismissed()
                        withAnimation(.easeInOut(duration: 0.28)) { showFeedbackPrompt = false }
                    }
                )
                .frame(maxWidth: 320, alignment: .leading)
                .padding(.top, 8)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .onAppear {
            // ACTIVATION funnel: the finished render just became visible INLINE
            // in the chat bubble — the common case the fullscreen player-present
            // event (VideoPlayerPresenter.doPresent) misses. Dedupe so scrolling
            // the bubble on/off screen fires it at most once per appearance.
            guard !didTrackViewed else { return }
            didTrackViewed = true
            var viewedProps: [String: Any] = [:]
            if let jobId { viewedProps["job_id"] = jobId }
            Analytics.track("result_viewed", props: viewedProps)
        }
    }

    /// The play-button or loading-spinner overlay sits on top of the
    /// thumbnail. Crossfades between states when the cache flips.
    @ViewBuilder
    private var thumbnailOverlay: some View {
        ZStack {
            if isPlayable {
                Circle()
                    .fill(.ultraThinMaterial)
                    .frame(width: 62, height: 62)
                Image(systemName: "play.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(.white)
                    .offset(x: 2)
                    .accessibilityHidden(true)
            } else {
                // Dim the thumbnail and show a centered spinner while the
                // file is downloading. Only reached for legacy (non-CDN)
                // URLs where streaming isn't smooth — CDN URLs flip to
                // the play button immediately.
                Color.black.opacity(0.45)
                    .allowsHitTesting(false)
                ProgressView()
                    .progressViewStyle(.circular)
                    .tint(.white)
                    .scaleEffect(1.2)
            }
        }
        .animation(.easeInOut(duration: 0.18), value: isPlayable)
    }

    @ViewBuilder
    private var thumbnailContent: some View {
        if let thumbUrl = effectiveThumbnailUrl, let url = URL(string: thumbUrl) {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().aspectRatio(contentMode: .fit)
                } else if phase.error != nil {
                    // Stored signed URL expired (or otherwise rejected).
                    // Ask the server for a fresh one; on success the
                    // @State change re-renders with the new URL.
                    Color(.tertiarySystemBackground)
                        .aspectRatio(9/16, contentMode: .fit)
                        .task { await refreshIfNeeded() }
                } else {
                    Color(.tertiarySystemBackground)
                        .aspectRatio(9/16, contentMode: .fit)
                }
            }
        } else {
            Color(.tertiarySystemBackground)
                .aspectRatio(9/16, contentMode: .fit)
        }
    }

    /// Fire one refresh attempt per view lifetime. AsyncImage retries
    /// the load automatically when the URL changes, so once we set
    /// `liveThumbnailUrl` the image either renders or stays placeholder.
    private func refreshIfNeeded() async {
        guard !refreshAttempted, let jobId = jobId else { return }
        refreshAttempted = true
        guard let fresh = await APIService.shared.refreshUrls(jobId: jobId) else { return }
        await MainActor.run {
            if let v = fresh.videoUrl { liveVideoUrl = v }
            if let t = fresh.thumbnailUrl { liveThumbnailUrl = t }
        }
    }

    /// Synchronous-from-the-call-site refresh helper used by the play
    /// button. Returns the freshly-signed video URL (or nil on failure)
    /// so VideoPlayerPresenter can present immediately with the new URL.
    private func refreshAndReturnVideoUrl() async -> String? {
        guard let jobId = jobId else { return nil }
        guard let fresh = await APIService.shared.refreshUrls(jobId: jobId) else { return nil }
        await MainActor.run {
            if let v = fresh.videoUrl { liveVideoUrl = v }
            if let t = fresh.thumbnailUrl { liveThumbnailUrl = t }
        }
        return fresh.videoUrl
    }
}

// MARK: - Video Player Presenter
//
// Presents the custom Promptly player (PromptlyPlayerHostVC). Path
// selection (HLS / cache hit / CDN streaming) and SigV4 refresh
// logic live here; the actual playback chrome lives in
// PromptlyVideoPlayer.swift.

enum VideoPlayerPresenter {
    /// Present the player. When `jobId` is provided, the local cache is
    /// Present the player. Selects the playback URL in priority order:
    ///   1. HLS manifest — AVPlayer's fastest path (instant first
    ///      segment, adaptive bitrate, sub-100 ms time-to-first-frame).
    ///   2. Local cache file:// — when a previous play already cached
    ///      the MP4 to disk, no network at all.
    ///   3. CDN MP4 — direct streaming from CloudFront with poster-first
    ///      and pre-warmed AVPlayerItem.
    /// Optional `onRefreshNeeded` is called when the URL fails a
    /// pre-flight HEAD check (or AVPlayer reports a 403/expired error
    /// during load) so the caller can return a freshly-signed URL and
    /// we present with that instead.
    @MainActor
    static func present(
        urlString: String,
        hlsManifestUrl: String? = nil,
        thumbnailUrl: String? = nil,
        jobId: String? = nil,
        title: String? = nil,
        onReedit: (() -> Void)? = nil,
        onRefreshNeeded: (() async -> String?)? = nil
    ) {
        print("[player] present url=\(urlString) hls=\(hlsManifestUrl ?? "-") jobId=\(jobId ?? "-")")
        guard URL(string: urlString) != nil else {
            print("[player] FAILED: invalid URL")
            return
        }

        _ = hlsManifestUrl  // accepted for source-compat; unused (see below)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)

        // Progressive MP4 with `+faststart` is the right playback format
        // for short-form (<90s) VOD — Mux + Apple agree. HLS only earns
        // its overhead at >2 min runtimes or when DRM/ABR matters. We
        // generate the HLS variants server-side as a future-proofing
        // hedge, but iOS plays the MP4 directly: faster first-frame,
        // disk-cacheable, frame-accurate scrub via chase-seek.

        // Cache hit → straight to file:// playback. No HEAD, no refresh.
        if let jobId, let local = VideoCache.shared.localUrl(forJobId: jobId) {
            print("[player] cache HIT for \(jobId)")
            doPresent(
                urlString: local.absoluteString,
                title: title,
                posterUrl: thumbnailUrl,
                jobId: jobId,
                onReedit: onReedit
            )
            return
        }

        // CDN-backed MP4 (or HLS not present yet for legacy jobs).
        // Stream directly through doPresent; pre-warm + faststart get
        // first-frame paint in 1-2s. Background download still runs so
        // subsequent watches are local-instant. Origin-S3 URLs get
        // streamed too — every render now goes through CloudFront,
        // so the old "download-spinner-then-play" path is dead and gone.
        if let jobId, isStreamingReadyUrl(urlString) {
            Task.detached(priority: .background) {
                await VideoCache.shared.downloadIfNeeded(jobId: jobId, from: urlString)
            }
        }
        Task { @MainActor in
            let resolvedUrl = await preflightOrRefresh(
                urlString: urlString,
                onRefreshNeeded: onRefreshNeeded
            )
            doPresent(
                urlString: resolvedUrl,
                title: title,
                posterUrl: thumbnailUrl,
                jobId: jobId,
                onReedit: onReedit
            )
        }
    }

    @MainActor
    private static func doPresent(urlString: String, title: String?, posterUrl: String?, jobId: String?, onReedit: (() -> Void)?) {
        guard let url = URL(string: urlString) else {
            print("[player] FAILED: invalid URL after refresh")
            return
        }
        // Custom Promptly player. Drops AVPlayerViewController so the
        // chrome is intentional — branded glass overlay, frame-strip
        // scrubber, speed pill, loop, re-edit pill, swipe-to-dismiss.
        // The pre-warmed AVPlayerItem (loaded when the thumbnail came
        // on screen) is handed to the player here for sub-100ms
        // first-frame paint.
        let item = PlayerAssetPrewarm.shared.takePlayerItem(for: urlString)
            ?? AVPlayerItem(url: url)
        let session = PromptlyPlayerSession(item: item, urlString: urlString)
        let host = PromptlyPlayerHostVC(
            session: session,
            title: title,
            posterUrl: posterUrl,
            onReedit: onReedit
        )

        guard let topVC = topmostViewController() else {
            print("[player] FAILED: no topmost view controller")
            return
        }
        // ACTIVATION-funnel terminal: the finished render is being viewed
        // (fullscreen player present). The INLINE appearance fires its own
        // result_viewed in CompletedVideoView.onAppear; both carry job_id so
        // downstream can dedupe per render if needed.
        var viewedProps: [String: Any] = [:]
        if let jobId { viewedProps["job_id"] = jobId }
        Analytics.track("result_viewed", props: viewedProps)
        topVC.present(host, animated: true)
    }

    /// HEAD the URL with a tight 5s timeout. On any 4xx response (or a
    /// network error), try the refresh callback and return whatever it
    /// gives us. If refresh isn't provided or also fails, falls back to
    /// the original URL — the player will surface its own error UI.
    private static func preflightOrRefresh(
        urlString: String,
        onRefreshNeeded: (() async -> String?)?
    ) async -> String {
        guard let url = URL(string: urlString) else { return urlString }
        var req = URLRequest(url: url)
        req.httpMethod = "HEAD"
        req.timeoutInterval = 5
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, (200..<400).contains(http.statusCode) {
                return urlString
            }
            print("[player] preflight \( (resp as? HTTPURLResponse)?.statusCode ?? -1) — refreshing")
        } catch {
            print("[player] preflight network error — refreshing: \(error.localizedDescription)")
        }
        if let refresh = onRefreshNeeded, let fresh = await refresh() {
            print("[player] refreshed url")
            return fresh
        }
        // No refresh available — fall back to original URL. Player will
        // surface its own native error chrome rather than us showing
        // nothing.
        return urlString
    }

    @MainActor
    private static func topmostViewController() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
            ?? (UIApplication.shared.connectedScenes.first as? UIWindowScene),
              let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first,
              let root = window.rootViewController
        else { return nil }

        var current = root
        while let presented = current.presentedViewController {
            current = presented
        }
        return current
    }
}
