import Foundation

/// §6 POST PACKAGE — the posting-ready copy delivered alongside a finished
/// video (see POST_PACKAGE_CONTRACT.md). Rides `result.post_package` on the
/// completed job row (and the flat `video_jobs.post_package` jsonb column).
///
/// Every field is OPTIONAL. An absent/garbled package renders NOTHING — never
/// an empty box. Decoding is fully tolerant (mirror of `AskPayload`): a
/// malformed package must never throw, because it decodes inside the reconcile
/// poll row — a throw there would fail the WHOLE row decode and freeze the bar.
struct PostPackage: Codable, Hashable {
    /// Why the edit was cut this way — 1-2 plain-language sentences (cap 400).
    let editRationale: String?
    /// Paste-ready caption in the speaker's voice + 1-2 hashtags (cap 120).
    let postCaption: String?
    /// The scroll-stopping first line — the video's sharpest claim (cap 60).
    let postHook: String?

    enum CodingKeys: String, CodingKey {
        case editRationale = "edit_rationale"
        case postCaption   = "post_caption"
        case postHook      = "post_hook"
    }

    init(editRationale: String? = nil, postCaption: String? = nil, postHook: String? = nil) {
        self.editRationale = editRationale
        self.postCaption = postCaption
        self.postHook = postHook
    }

    init(from decoder: Decoder) throws {
        // Non-object value → all nil (never throw). Per field: decode-if-string,
        // trim, drop-if-empty, and re-cap client-side — the contract says the
        // client may rely on the caps but not on minimum lengths.
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else {
            self.editRationale = nil; self.postCaption = nil; self.postHook = nil; return
        }
        func field(_ key: CodingKeys, _ cap: Int) -> String? {
            guard let raw = try? c.decode(String.self, forKey: key) else { return nil }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            return String(trimmed.prefix(cap))
        }
        self.editRationale = field(.editRationale, 400)
        self.postCaption   = field(.postCaption, 120)
        self.postHook      = field(.postHook, 60)
    }

    /// True when at least one field survived — the gate for showing the block.
    var hasContent: Bool {
        editRationale != nil || postCaption != nil || postHook != nil
    }
}
