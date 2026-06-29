import Foundation

// Standalone unit tests for the pure ModelSelection tier-gate logic — the
// security-critical rules behind the Flare/Lumen picker. The Xcode project has
// no test target and these need none: VideoModel/ModelSelection are
// Foundation-only, so we compile them together with this file and run natively:
//
//   swiftc ../Promptly/Models/VideoModel.swift ModelSelectionTests.swift -o /tmp/modeltest && /tmp/modeltest
//
// (or: ios/Promptly/Tests/run.sh). Exit code is non-zero if any check fails.

var failures = 0
var checks = 0

func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond {
        print("ok   - \(msg)")
    } else {
        failures += 1
        print("FAIL - \(msg)")
    }
}

@main
struct ModelSelectionTestMain {
static func main() {

    // Model metadata
    check(VideoModel.flare.isPremium == false, "Flare is not premium")
    check(VideoModel.lumen.isPremium == true, "Lumen is premium")
    check(VideoModel.base == .flare, "base model is Flare")
    check(VideoModel.allCases.count == 2, "exactly two models")

    // canSelect — base always; premium only when Pro
    check(ModelSelection.canSelect(.flare, isPro: false) == true, "free can select Flare")
    check(ModelSelection.canSelect(.flare, isPro: true) == true, "pro can select Flare")
    check(ModelSelection.canSelect(.lumen, isPro: true) == true, "pro can select Lumen")
    check(ModelSelection.canSelect(.lumen, isPro: false) == false,
          "free CANNOT select Lumen")

    // resolve — premium held by non-Pro falls back to base
    check(ModelSelection.resolve(selected: .flare, isPro: false) == .flare,
          "resolve: free + Flare stays Flare")
    check(ModelSelection.resolve(selected: .flare, isPro: true) == .flare,
          "resolve: pro + Flare stays Flare")
    check(ModelSelection.resolve(selected: .lumen, isPro: true) == .lumen,
          "resolve: pro + Lumen stays Lumen")
    check(ModelSelection.resolve(selected: .lumen, isPro: false) == .flare,
          "resolve: DOWNGRADE — free + Lumen falls back to Flare")

    // premiumFlag — THE wire signal. True ONLY for (premium AND pro).
    check(ModelSelection.premiumFlag(selected: .lumen, isPro: true) == true,
          "premiumFlag: Lumen + pro → TRUE")
    check(ModelSelection.premiumFlag(selected: .lumen, isPro: false) == false,
          "premiumFlag: Lumen + FREE → false (free never emits the flag)")
    check(ModelSelection.premiumFlag(selected: .flare, isPro: true) == false,
          "premiumFlag: Flare + pro → false")
    check(ModelSelection.premiumFlag(selected: .flare, isPro: false) == false,
          "premiumFlag: Flare + free → false")

    // Headline invariant: across EVERY combination, a non-Pro user can never
    // produce a true flag and can never resolve to a premium model.
    for model in VideoModel.allCases {
        check(ModelSelection.premiumFlag(selected: model, isPro: false) == false,
              "free never emits premium flag for \(model.rawValue)")
        check(ModelSelection.resolve(selected: model, isPro: false).isPremium == false,
              "free never resolves to a premium model from \(model.rawValue)")
    }

    print("\n\(checks - failures)/\(checks) checks passed")
    exit(failures == 0 ? 0 : 1)
}
}
