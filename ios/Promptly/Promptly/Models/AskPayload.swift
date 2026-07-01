import Foundation

/// Phase D ask-back. Lumen parks a job at `status=needs_input` and writes an
/// `ask` payload to the row; the app reads it via the poll, renders it in the
/// progress bubble, collects an answer (or skip), and resubmits on the re-edit
/// rail. Pure/Foundation-only so the decode + answer-building logic is
/// swiftc-testable (see ios/Promptly/Tests/AskPayloadTests.swift).

/// The kinds of answer an ask can accept. Unknown kinds from the server are
/// ignored (forward-compatible) rather than failing the whole decode.
enum AnswerKind: String, Codable, CaseIterable, Hashable {
    case text, image, clip, choice
}

/// A tappable option for a `choice` ask. Decodes from either a bare string
/// ("moody treatment") or an object ({ "value": …, "label": … }).
struct AskChoice: Codable, Hashable, Identifiable {
    let value: String
    let label: String
    var id: String { value }

    init(value: String, label: String? = nil) {
        self.value = value
        self.label = label ?? value
    }

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let s = try? single.decode(String.self) {
            self.value = s; self.label = s; return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let v = (try? c.decode(String.self, forKey: .value)) ?? (try? c.decode(String.self, forKey: .id)) ?? ""
        self.value = v
        self.label = (try? c.decode(String.self, forKey: .label)) ?? v
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(value, forKey: .value)
        try c.encode(label, forKey: .label)
    }
    enum CodingKeys: String, CodingKey { case value, id, label }
}

/// The ask, as stored on the job row's `ask` jsonb column.
struct AskPayload: Codable, Hashable {
    let askId: String
    let prompt: String
    let answerKinds: [AnswerKind]
    let optional: Bool
    let context: String?
    let choices: [AskChoice]?

    enum CodingKeys: String, CodingKey {
        case askId = "ask_id"
        case prompt
        case answerKinds = "answer_kinds"
        case optional
        case context
        case choices
    }

    init(askId: String, prompt: String, answerKinds: [AnswerKind], optional: Bool = true,
         context: String? = nil, choices: [AskChoice]? = nil) {
        self.askId = askId; self.prompt = prompt; self.answerKinds = answerKinds
        self.optional = optional; self.context = context; self.choices = choices
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Tolerant like every other field: a missing/malformed ask_id must NOT
        // throw — an AskPayload decode failure inside JobStatusRow.ask would
        // fail the WHOLE poll row decode and freeze the bar / never catch
        // completion. Empty id → isRenderable=false → the poll leaves it in-flight.
        self.askId = (try? c.decode(String.self, forKey: .askId)) ?? ""
        self.prompt = (try? c.decode(String.self, forKey: .prompt)) ?? "Want to make this even better?"
        // Filter unknown kinds instead of throwing (forward-compat).
        let rawKinds = (try? c.decode([String].self, forKey: .answerKinds)) ?? []
        self.answerKinds = rawKinds.compactMap(AnswerKind.init(rawValue:))
        self.optional = (try? c.decode(Bool.self, forKey: .optional)) ?? true
        self.context = try? c.decode(String.self, forKey: .context)
        self.choices = try? c.decode([AskChoice].self, forKey: .choices)
    }

    /// A well-formed ask must have a non-empty id and at least one usable kind.
    var isRenderable: Bool { !askId.isEmpty && !answerKinds.isEmpty }
    func accepts(_ kind: AnswerKind) -> Bool { answerKinds.contains(kind) }
}

/// The user's answer, assembled by the ask card before submission.
struct AskAnswer: Equatable {
    var text: String?
    var imageKey: String?
    var clipKey: String?
    var choice: String?
    var skip: Bool = false

    static let skipped = AskAnswer(skip: true)

    /// True once there's something worth sending — a skip, or any content.
    var hasContent: Bool {
        skip
            || !(text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
            || imageKey != nil || clipKey != nil
            || !(choice?.isEmpty ?? true)
    }

    /// The re-edit-rail request body. Optionals omit themselves (encodeIfPresent),
    /// so we send only what the user provided.
    func requestBody(originalJobId: String, askId: String) -> AskAnswerRequest {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        return AskAnswerRequest(
            original_job_id: originalJobId,
            ask_id: askId,
            answer: (trimmed?.isEmpty == false) ? trimmed : nil,
            answer_image_key: imageKey,
            answer_clip_key: clipKey,
            answer_choice: (choice?.isEmpty == false) ? choice : nil,
            skip: skip ? true : nil
        )
    }
}

/// Encodable body for POST /api/video-jobs/re-edit (answer submission). Nil
/// fields are omitted by the synthesized encoder.
struct AskAnswerRequest: Encodable, Equatable {
    let original_job_id: String
    let ask_id: String
    let answer: String?
    let answer_image_key: String?
    let answer_clip_key: String?
    let answer_choice: String?
    let skip: Bool?
}
