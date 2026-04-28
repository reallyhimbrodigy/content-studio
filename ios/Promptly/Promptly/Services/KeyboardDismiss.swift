import SwiftUI
import UIKit

/// Global utilities for hiding the keyboard. Centralizes the
/// "send-resignFirstResponder" pattern so every view dismisses the
/// keyboard the same synchronous, non-jumpy way regardless of whether
/// it's wrapping a SwiftUI form, a UIKit search bar, or a custom field.
enum Keyboard {
    /// Synchronously hide whatever responder currently owns the keyboard.
    ///
    /// Goes straight through UIKit — `@FocusState` mutations inside a
    /// `withAnimation` transaction defer the state write, which produces
    /// the visible "keyboard slides down then jolts back into place"
    /// jump that users perceive as broken. UIResponder takes effect on
    /// the next runloop tick with no animation contention.
    static func dismiss() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil, from: nil, for: nil
        )
    }
}

extension View {
    /// Tap anywhere inside this view's bounds to dismiss the keyboard.
    /// Uses a `simultaneousGesture` so it never steals taps from
    /// buttons, list rows, or text fields underneath — those still
    /// receive their tap and behave normally; the keyboard just goes
    /// down alongside.
    func dismissKeyboardOnTap() -> some View {
        simultaneousGesture(
            TapGesture().onEnded {
                Keyboard.dismiss()
            }
        )
    }
}
