import SwiftUI
import AVKit

/// Beat 1 — THE HOOK. The before/after transformation plays in the first five
/// seconds, before any ask. Cal AI opens with a demo video for a reason: the
/// wow precedes every ask.
///
/// Asset contract: a bundled `OnboardingHook.mp4` (9:16, muted-autoplay-safe,
/// captions carrying meaning) — THE clip Zac picks from the Phase-4 shortlist.
/// Until that asset lands, a designed placeholder renders the before/after
/// concept so the flow is buildable + testable end-to-end; the harness and
/// App Review never see a broken screen either way.
struct OnboardingHookView: View {
    let onContinue: () -> Void

    @State private var player: AVQueuePlayer? = nil
    @State private var looper: AVPlayerLooper? = nil

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let player {
                // The real hook clip, full-bleed, muted, looping.
                VideoPlayer(player: player)
                    .disabled(true) // no scrub chrome — it's a moment, not a player
                    .ignoresSafeArea()
                    .onAppear { player.play() }
            } else {
                placeholderHero
            }

            // Bottom gradient + copy + CTA. The clip carries the wow; the words
            // only name it. One thumb, one action.
            VStack {
                Spacer()
                LinearGradient(colors: [.clear, .black.opacity(0.85)], startPoint: .top, endPoint: .bottom)
                    .frame(height: 260)
                    .overlay(alignment: .bottom) {
                        VStack(spacing: 14) {
                            Text("Raw clip in. Studio edit out.")
                                .font(.system(size: 30, weight: .heavy))
                                .multilineTextAlignment(.center)
                                .foregroundColor(.white)
                            Text("Captions, cuts, and B-roll — from one talking-head take.")
                                .font(.system(size: 15))
                                .foregroundColor(.white.opacity(0.75))
                                .multilineTextAlignment(.center)
                            Button {
                                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                onContinue()
                            } label: {
                                Text("Get started")
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundColor(.black)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 54)
                                    .background(Color.white, in: Capsule())
                            }
                            .padding(.horizontal, 24)
                            .padding(.bottom, 20)
                        }
                        .padding(.horizontal, 20)
                    }
            }
            .ignoresSafeArea(edges: .bottom)
        }
        .onAppear {
            Analytics.track("onboarding_step", props: ["step": "hook_view"])
            if let url = Bundle.main.url(forResource: "OnboardingHook", withExtension: "mp4") {
                let item = AVPlayerItem(url: url)
                let queue = AVQueuePlayer()
                queue.isMuted = true
                looper = AVPlayerLooper(player: queue, templateItem: item)
                player = queue
            }
        }
        .onDisappear { player?.pause() }
    }

    /// Designed placeholder until THE clip lands: a split before/after concept
    /// built from layout + type. Honest by construction — it depicts the
    /// product's real transformation without faking a specific result.
    private var placeholderHero: some View {
        VStack(spacing: 0) {
            ZStack {
                Color(white: 0.10)
                VStack(spacing: 10) {
                    Text("BEFORE")
                        .font(.system(size: 12, weight: .bold))
                        .tracking(2)
                        .foregroundColor(.white.opacity(0.45))
                    RoundedRectangle(cornerRadius: 18)
                        .fill(Color(white: 0.16))
                        .overlay(
                            Image(systemName: "person.crop.rectangle")
                                .font(.system(size: 44))
                                .foregroundColor(.white.opacity(0.3))
                        )
                        .frame(width: 190, height: 240)
                    Text("one raw take")
                        .font(.system(size: 13))
                        .foregroundColor(.white.opacity(0.4))
                }
            }
            ZStack {
                Color.black
                VStack(spacing: 10) {
                    Text("AFTER")
                        .font(.system(size: 12, weight: .bold))
                        .tracking(2)
                        .foregroundColor(.yellow.opacity(0.85))
                    RoundedRectangle(cornerRadius: 18)
                        .fill(LinearGradient(colors: [Color(white: 0.18), Color(white: 0.10)],
                                             startPoint: .top, endPoint: .bottom))
                        .overlay(
                            VStack(spacing: 8) {
                                Image(systemName: "captions.bubble.fill")
                                    .font(.system(size: 34))
                                    .foregroundColor(.yellow)
                                Text("CAPTIONS · CUTS · B-ROLL")
                                    .font(.system(size: 11, weight: .heavy))
                                    .tracking(1.2)
                                    .foregroundColor(.white)
                            }
                        )
                        .frame(width: 190, height: 240)
                    Text("the edit, done for you")
                        .font(.system(size: 13))
                        .foregroundColor(.white.opacity(0.6))
                }
            }
        }
        .ignoresSafeArea()
    }
}
