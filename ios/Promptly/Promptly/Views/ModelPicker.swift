import SwiftUI

/// Premium "Lumen = light" visual tokens. The warm-to-light ambience that
/// makes locked Lumen read as aspirational, not disabled.
private enum LumenStyle {
    static let amber = Color(red: 1.0, green: 0.74, blue: 0.38)
    static let warmLight = Color(red: 1.0, green: 0.91, blue: 0.72)

    /// Foreground gradient for the sparkle + name accent.
    static let textGradient = LinearGradient(
        colors: [amber, warmLight, .white],
        startPoint: .leading, endPoint: .trailing
    )
    /// Soft fill behind the locked row — a gentle warm glow, low alpha.
    static let rowFill = LinearGradient(
        colors: [amber.opacity(0.20), warmLight.opacity(0.07)],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )
    static let stroke = amber.opacity(0.55)
    static let glow = amber.opacity(0.45)
}

// MARK: - The composer pill

/// Understated model pill that lives in the composer (the "Opus 4.8 High"
/// slot in the Claude reference). Shows the active model; tap to open the
/// picker. Neutral at rest; a small sparkle accent only when Lumen is active.
struct ModelPickerPill: View {
    @ObservedObject private var models = ModelService.shared
    // Observe BOTH entitlement signals so the accent updates the instant tier
    // changes (effectiveIsPro = subscription.isPro || usage.isPro).
    @ObservedObject private var subscription = SubscriptionService.shared
    @ObservedObject private var usage = UsageService.shared
    @State private var showPicker = false
    @State private var pendingUpgrade = false

    /// Show the premium accent only when a premium model is selected AND the
    /// user is actually entitled — so a lapsed user never sees a premium-styled
    /// pill, even for the frame before `reconcile` flips the selection back.
    private var showPremiumAccent: Bool {
        models.premiumPipelineFlag(isPro: subscription.effectiveIsPro)
    }

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            showPicker = true
        } label: {
            HStack(spacing: 5) {
                if showPremiumAccent {
                    Image(systemName: "sparkles")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(LumenStyle.textGradient)
                }
                Text(models.selected.displayName)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.white.opacity(0.82))
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(.white.opacity(0.4))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Capsule().fill(Color.white.opacity(0.06)))
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Model: \(models.selected.displayName)")
        .accessibilityHint("Choose the editing model")
        // onDismiss fires the paywall AFTER the picker has fully closed. iOS
        // forbids presenting the root paywall sheet while this one is mid-
        // dismiss — doing both in the same tick silently drops the paywall.
        .sheet(isPresented: $showPicker, onDismiss: {
            if pendingUpgrade {
                pendingUpgrade = false
                AppState.shared.paywallReason = .lumen
            }
        }) {
            ModelPickerSheet(onRequestUpgrade: { pendingUpgrade = true })
                .presentationDetents([.height(296)])
                .presentationDragIndicator(.visible)
                .presentationBackground(.ultraThinMaterial)
        }
    }
}

// MARK: - The picker sheet

/// Lists both models. Flare is neutral + selectable. Lumen is selectable for
/// Pro; for free users it's shown LOCKED + GLOWING — tapping it opens the
/// paywall rather than selecting it. A free user cannot leave this sheet with
/// Lumen active by any path.
struct ModelPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var models = ModelService.shared
    @ObservedObject private var subscription = SubscriptionService.shared
    // effectiveIsPro = subscription.isPro || usage.isPro — observe BOTH so the
    // lock/glow state stays exact if entitlement flips via the server snapshot
    // while the sheet is open.
    @ObservedObject private var usage = UsageService.shared

    /// Called when the user taps locked Lumen. The PARENT defers the paywall
    /// to its sheet's onDismiss (presenting mid-dismiss would drop it), so the
    /// sheet itself only signals intent — it never touches AppState directly.
    let onRequestUpgrade: () -> Void

    private var isPro: Bool { subscription.effectiveIsPro }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Model")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.white.opacity(0.55))
                .tracking(0.6)
                .textCase(.uppercase)
                .padding(.horizontal, 20)
                .padding(.top, 22)
                .padding(.bottom, 12)

            ForEach(VideoModel.allCases) { model in
                let locked = model.isPremium && !isPro
                ModelRow(
                    model: model,
                    isSelected: models.selected == model,
                    locked: locked
                ) {
                    if locked {
                        // Locked Lumen → signal upgrade intent + close; the
                        // parent opens the paywall once this sheet has fully
                        // dismissed. Never selects the model.
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        onRequestUpgrade()
                        dismiss()
                    } else {
                        models.select(model, isPro: isPro)
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        dismiss()
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 4)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - A single model row

private struct ModelRow: View {
    let model: VideoModel
    let isSelected: Bool
    let locked: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 13) {
                icon
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(model.displayName)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(.white)
                        if locked {
                            Image(systemName: "lock.fill")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(LumenStyle.warmLight.opacity(0.9))
                        }
                    }
                    Text(model.descriptor)
                        .font(.system(size: 13))
                        .foregroundColor(.white.opacity(0.55))
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(.white)
                } else if locked {
                    Text("Pro")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(LumenStyle.textGradient)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(LumenStyle.amber.opacity(0.15)))
                        .overlay(Capsule().strokeBorder(LumenStyle.stroke, lineWidth: 0.5))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .background(rowBackground)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    @ViewBuilder private var icon: some View {
        ZStack {
            if locked {
                Circle().fill(LumenStyle.rowFill)
                Circle().strokeBorder(LumenStyle.stroke, lineWidth: 0.5)
            } else {
                Circle().fill(Color.white.opacity(0.08))
            }
            Image(systemName: model.isPremium ? "sparkles" : "bolt.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(model.isPremium ? AnyShapeStyle(LumenStyle.textGradient)
                                                  : AnyShapeStyle(Color.white.opacity(0.85)))
        }
        .frame(width: 38, height: 38)
    }

    @ViewBuilder private var rowBackground: some View {
        if locked {
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .fill(LumenStyle.rowFill)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                        .strokeBorder(LumenStyle.stroke, lineWidth: 0.5)
                )
                .shadow(color: LumenStyle.glow, radius: 14, x: 0, y: 0)
        } else if isSelected {
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .fill(Color.white.opacity(0.07))
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5)
                )
        } else {
            Color.clear
        }
    }

    private var accessibilityLabel: String {
        if locked { return "\(model.displayName), \(model.descriptor) Pro only. Opens upgrade." }
        return "\(model.displayName), \(model.descriptor)\(isSelected ? " Selected." : "")"
    }
}
