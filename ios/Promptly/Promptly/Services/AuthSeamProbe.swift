#if DEBUG
import Foundation
import RevenueCat

/// Executes the deferred-auth seams signed out and prints a verdict per seam.
///
/// WHY THIS EXISTS. The seams were wired at three call sites and checked by
/// auth-seam-gate, which reads the SOURCE — it proves the line is present, not
/// that it refuses anything. "Chat send is silently discarding" is a claim about
/// behaviour, and the only honest answer to it is to run the behaviour.
///
/// What it cannot cover is the RESUME: replaying the intent after a real
/// sign-in needs a real account, an OTP or an Apple/Google sheet, and a device.
/// That one is named as untestable here rather than quietly skipped.
@MainActor
enum AuthSeamProbe {
    static func run() async {
        guard AuthService.shared.currentUser?.id == nil else {
            print("SEAMPROBE SKIPPED — a session exists; this must run signed out")
            return
        }

        // 1. PURCHASE. The real call, not a stand-in: a signed-out purchase must
        //    return false and never reach RevenueCat.
        AuthGate.shared.cancel()
        let packages = SubscriptionService.shared.offerings?.current?.availablePackages ?? []
        if let pkg = packages.first {
            let ok = await SubscriptionService.shared.purchase(pkg, context: "seam_probe")
            let raised = AuthGate.shared.pending != nil
            print("SEAMPROBE purchase refused=\(!ok) gateRaised=\(raised) "
                  + "verdict=\(!ok && raised ? "PASS" : "FAIL")")
        } else {
            print("SEAMPROBE purchase UNVERIFIED — no packages in this offering")
        }

        // 2. CHAT SEND. The same guard send() runs, before anything is accepted.
        AuthGate.shared.cancel()
        let sendAllowed = AuthGate.shared.allow(.profileWrite("chat_send"))
        let sendRaised = AuthGate.shared.pending != nil
        print("SEAMPROBE chatSend refused=\(!sendAllowed) gateRaised=\(sendRaised) "
              + "verdict=\(!sendAllowed && sendRaised ? "PASS" : "FAIL")")

        // 3. EXPORT. The guard prepareGatedLocalFile runs before the gate probe.
        AuthGate.shared.cancel()
        let exportAllowed = AuthGate.shared.allow(.export(jobId: nil))
        let exportRaised = AuthGate.shared.pending != nil
        print("SEAMPROBE export refused=\(!exportAllowed) gateRaised=\(exportRaised) "
              + "verdict=\(!exportAllowed && exportRaised ? "PASS" : "FAIL")")

        // 4. RESUME — cannot be run here. Replaying after sign-in needs a real
        //    account; anything simulated would be testing the simulation.
        print("SEAMPROBE resume verdict=NEEDS_DEVICE (real sign-in required)")

        AuthGate.shared.cancel()
    }
}
#endif
