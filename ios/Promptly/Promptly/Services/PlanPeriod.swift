import Foundation
import RevenueCat

/// How long a plan lasts, resolved from the PRODUCT rather than the package.
///
/// THE THIRD INSTANCE OF ONE DEFECT. `PackageType` is RevenueCat's slot in an
/// offering, not a property of the product, and anything outside its known set
/// arrives as `.custom` — which is exactly how the Max products arrive. Every
/// `packageType == .annual` test therefore silently answers "no" for Max, and
/// the failure is always a quiet wrong answer rather than an error:
///
///   1. `PlanSavings.percentOff` found neither an annual nor a monthly plan for
///      Max, returned nil, and the yearly row showed no savings badge — a real
///      25% withheld on the most expensive tier.
///   2. `FirstLaunchPaywallView` fell through its label chain to the default and
///      printed "Promptly Pro" for BOTH Max rows, so the live first-launch
///      paywall listed the same plan name twice at two different prices.
///   3. The intro-offer gate would have hidden the intro line on Max only.
///
/// Three surfaces, one root, none of which raised anything. So the resolution
/// lives in ONE place and every site reads it: `subscriptionPeriod` is what the
/// user is actually buying, and `packageType` survives only as a fallback for a
/// product that somehow carries no period at all.
enum PlanPeriodUnit: Equatable {
    case year, month, week, other
}

extension Package {
    /// The plan's real duration. Period first, package type only as a fallback.
    var planPeriod: PlanPeriodUnit {
        if let unit = storeProduct.subscriptionPeriod?.unit {
            switch unit {
            case .year:  return .year
            case .month: return .month
            case .week:  return .week
            default: break
            }
        }
        switch packageType {
        case .annual:  return .year
        case .monthly: return .month
        case .weekly:  return .week
        default:       return .other
        }
    }

    var isAnnualPlan: Bool  { planPeriod == .year }
    var isMonthlyPlan: Bool { planPeriod == .month }
    var isWeeklyPlan: Bool  { planPeriod == .week }
}

/// Our OWN period labels, never StoreKit's `localizedTitle` (the Jul-24 rule).
enum PlanPeriodCopy {
    /// Bare noun, capitalised: "Year" / "Month" / "Week".
    static func title(_ unit: PlanPeriodUnit) -> String {
        switch unit {
        case .year:  return String(localized: "Year")
        case .month: return String(localized: "Month")
        case .week:  return String(localized: "Week")
        case .other: return String(localized: "Plan")
        }
    }

    /// Lower-case noun for mid-sentence use: "per year", "$9.99/month".
    static func noun(_ unit: PlanPeriodUnit) -> String {
        switch unit {
        case .year:  return String(localized: "year")
        case .month: return String(localized: "month")
        case .week:  return String(localized: "week")
        case .other: return String(localized: "period")
        }
    }

    /// "Yearly" / "Monthly" / "Weekly" — the adjective form some rows use.
    static func adjective(_ unit: PlanPeriodUnit) -> String {
        switch unit {
        case .year:  return String(localized: "Yearly")
        case .month: return String(localized: "Monthly")
        case .week:  return String(localized: "Weekly")
        case .other: return String(localized: "Plan")
        }
    }

    /// "per year" and friends.
    static func perPeriod(_ unit: PlanPeriodUnit) -> String {
        switch unit {
        case .year:  return String(localized: "per year")
        case .month: return String(localized: "per month")
        case .week:  return String(localized: "per week")
        case .other: return ""
        }
    }

    /// The analytics plan key. Derived too, so a Max row is "yearly"/"monthly"
    /// in the funnel rather than "other" — otherwise every Max purchase lands in
    /// a bucket that looks like an unrecognised product.
    static func planKey(_ unit: PlanPeriodUnit) -> String {
        switch unit {
        case .year:  return "yearly"
        case .month: return "monthly"
        case .week:  return "weekly"
        case .other: return "other"
        }
    }
}
