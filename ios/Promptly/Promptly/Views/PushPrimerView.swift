import SwiftUI
import UIKit

/// Post-first-delivery push pre-permission primer (conversion build, flag:
/// push_primer). The soft-ask SHEET shown once per install, the moment the
/// user's FIRST rendered video lands in a chat — the payoff moment, when
/// "we'll tell you when it's ready" has a concrete referent. 76% of users
/// have no push token; this re-times the ask to right after value landed.
///
/// The iOS system dialog fires ONLY on the active "Notify me" tap — via the
/// existing PushService.requestPermissionIfNeeded() path, so registration
/// stays single-tracked (idempotent status check + token short-circuit in
/// setDeviceToken; nothing here double-registers). "Not now" — or a
/// swipe-down, which counts as the same choice — dismisses forever-quiet:
/// the once-per-install guard was claimed at present time, and the system
/// one-shot stays intact for a future re-ask flag.
///
/// Emits push_primer_viewed / push_primer_accepted / push_primer_declined,
/// all with ["context": "post_first_delivery"]. Viewed fires from onAppear,
/// so it counts actual showings, not presentation attempts.
struct PushPrimerView: View {

    /// Dismisses the host sheet, then raises the system permission dialog.
    let onAccept: () -> Void
    /// Dismisses the host sheet; nothing else.
    let onDecline: () -> Void

    /// Set by either button so a swipe-down dismissal can be told apart from
    /// a button choice in onDisappear (a swipe counts as a decline — the
    /// primer never re-shows, so the funnel must not silently lose these).
    @State private var choiceMade = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: Theme.Space.lg) {
                // Glass icon puck — same circular ghost treatment as the
                // feedback card's rating buttons, scaled up for a hero slot.
                ZStack {
                    Circle().fill(Color.white.opacity(0.08))
                    Circle().strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
                    Image(systemName: "bell.badge.fill")
                        .font(.system(size: 26, weight: .semibold))
                        .foregroundColor(.white)
                }
                .frame(width: 64, height: 64)
                .accessibilityHidden(true)

                VStack(spacing: Theme.Space.xs) {
                    Text(String(localized: "Know the second it's ready"))
                        .font(Theme.Font.title3)
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                    Text(String(localized: "Edits take a few minutes. We'll tell you the moment your next one is done — no need to keep the app open."))
                        .font(Theme.Font.body)
                        .foregroundColor(.white.opacity(0.65))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, Theme.Space.xs)

                VStack(spacing: Theme.Space.xs) {
                    // Primary: the ONLY path to the iOS dialog. White capsule
                    // on black — the app-wide primary-CTA treatment.
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        choiceMade = true
                        Analytics.track("push_primer_accepted", props: ["context": "post_first_delivery"])
                        onAccept()
                    } label: {
                        Text(String(localized: "Notify me"))
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(.black)
                            .frame(maxWidth: .infinity)
                            .frame(height: 50)
                            .background(Color.white)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)

                    // Quiet decline — no guilt styling, full-width tap target.
                    Button {
                        choiceMade = true
                        Analytics.track("push_primer_declined", props: ["context": "post_first_delivery"])
                        onDecline()
                    } label: {
                        Text(String(localized: "Not now"))
                            .font(Theme.Font.bodyMedium)
                            .foregroundColor(.white.opacity(0.6))
                            .frame(maxWidth: .infinity)
                            .frame(height: 40)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Theme.Space.xl)
            .padding(.top, Theme.Space.xxl)
            .padding(.bottom, Theme.Space.md)
        }
        .onAppear {
            Analytics.track("push_primer_viewed", props: ["context": "post_first_delivery"])
        }
        .onDisappear {
            // Pull-down without a button tap is an implicit "Not now". The
            // extra prop lets the funnel split explicit vs swipe declines.
            if !choiceMade {
                Analytics.track("push_primer_declined", props: [
                    "context": "post_first_delivery",
                    "method": "swipe",
                ])
            }
        }
    }
}


// MARK: - UIKit presenter

/// Presents the primer as a compact sheet from the topmost view controller.
/// Mirrors AppState.presentPaywallFromTop: a UIHostingController presented
/// from the top VC is the presentation that works from a service context (no
/// SwiftUI `.sheet` host to borrow), and it composes over whatever the user
/// is looking at when the render completes.
enum PushPrimerPresenter {
    @MainActor
    static func present() {
        guard let top = AppState.topViewController() else { return }
        weak var hostRef: UIViewController?
        let primer = PushPrimerView(
            onAccept: {
                // Dismiss first, THEN raise the system dialog — the OS alert
                // centers cleanly over the chat instead of floating over a
                // sheet that's mid-departure.
                hostRef?.dismiss(animated: true) {
                    Task { await PushService.shared.requestPermissionIfNeeded() }
                }
            },
            onDecline: {
                hostRef?.dismiss(animated: true)
            }
        )
        let host = UIHostingController(rootView: primer)
        host.modalPresentationStyle = .pageSheet
        host.view.backgroundColor = .black
        if let sheet = host.sheetPresentationController {
            sheet.detents = [.custom { _ in 360 }]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = Theme.Radius.lg
        }
        hostRef = host
        top.present(host, animated: true)
    }
}


#if DEBUG
#Preview("Push primer") {
    PushPrimerView(
        onAccept: { print("accept") },
        onDecline: { print("decline") }
    )
}
#endif
