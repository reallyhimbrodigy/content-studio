import Foundation
import Security

/// Minimal Keychain string store, for the one thing that must outlive an
/// app deletion: the device id the reverse-trial grant is keyed on.
///
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`:
///   • afterFirstUnlock — readable in the background, which matters because
///     analytics and dispatch both run outside the foreground.
///   • ThisDeviceOnly — deliberately NOT synced to iCloud Keychain. A synced
///     item would follow the user to a second device and make two real devices
///     look like one, which would deny a legitimate trial on the new phone. The
///     goal is to stop a reinstall farming repeat trials, not to bind a person.
enum Keychain {
    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "app.usepromptly.ios",
         kSecAttrAccount as String: key]
    }

    static func get(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data, let s = String(data: data, encoding: .utf8),
              !s.isEmpty else { return nil }
        return s
    }

    @discardableResult
    static func set(_ value: String, for key: String) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }
        // Delete-then-add rather than update: an update on a missing item fails,
        // and branching on which case we are in is more code than re-adding.
        SecItemDelete(query(key) as CFDictionary)
        var q = query(key)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    /// Removal. Only the DEBUG harness needs this — a first-run funnel cannot be
    /// re-tested on a device that has already seen it, and reinstalling does not
    /// help because surviving reinstall is the entire point of storing it here.
    @discardableResult
    static func delete(_ key: String) -> Bool {
        let status = SecItemDelete(query(key) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
