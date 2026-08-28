import SwiftUI

/// render_transparency — the labour-illusion header (amendment 2026-08-27).
///
/// PREMISE CORRECTION (2026-08-27): the stage-truthful feed the brief asked
/// for ALREADY SHIPPED and is live — `PipelineProgressView` walks the
/// 17-stage `PipelineCatalog`, driven by SERVER-AUTHORITATIVE stage tokens
/// (`StageTimeline.advance`), with per-stage sub-messages. Stages are named
/// by what the pipeline actually does ("Transcribing every word", "Timing
/// cuts to the beat", "Placing captions word-by-word"). Building a second
/// feed would have duplicated it and invented a less truthful one.
///
/// What was genuinely missing is what the amendment names: the wait says
/// nothing about the USER'S OWN JOB. This header supplies that line — built
/// from the v2 survey answers where they exist, generic where they don't —
/// and nothing else. The stage list underneath stays untouched and stays the
/// only claim about pipeline state.
///
/// Truthfulness rules kept:
///   • This view NEVER asserts pipeline progress. It names the job the user
///     asked for; the stages below remain the sole progress claim.
///   • Flag off, or no survey answers → the generic line, which is what the
///     surface effectively says today.
struct RenderTransparencyHeader: View {
    /// Render-caught 2026-08-27: this view originally echoed the user's vibe
    /// under the headline — but PlanPreviewCard directly below already quotes
    /// it verbatim, so the wait printed the same sentence twice. The header
    /// contributes ONLY the line nothing else says: whose job this is.
    @ObservedObject private var onboarding = OnboardingState.shared

    /// "Cutting your podcast clip for TikTok" / "Cutting your video" —
    /// composed ONLY from answers the user actually gave.
    private var line: String {
        let making = OnboardingQuestion.makingLabelV2(onboarding.v2Making)
        let platform = Self.platformLabel(onboarding.v2Platform)
        switch (making, platform) {
        case let (m?, p?): return String(localized: "Cutting your \(m) clip for \(p)")
        case let (m?, nil): return String(localized: "Cutting your \(m) clip")
        case let (nil, p?): return String(localized: "Cutting your video for \(p)")
        default:            return String(localized: "Cutting your video")
        }
    }

    static func platformLabel(_ key: String?) -> String? {
        switch key {
        case "tiktok":   return String(localized: "TikTok")
        case "reels":    return String(localized: "Reels")
        case "shorts":   return String(localized: "Shorts")
        case "linkedin": return String(localized: "LinkedIn")
        default:         return nil   // "multi" / skipped → no platform clause
        }
    }

    var body: some View {
        Text(line)
            .font(.system(size: 15, weight: .semibold))
            .foregroundColor(.white)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 8)
    }
}
