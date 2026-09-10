import Foundation

/// CRUD on the Supabase `chats` table. Uses PostgREST directly (the same
/// pattern existing code uses for video_jobs in APIService) so we don't
/// pull in the Supabase Swift client just for four queries.
///
/// Auth: every request goes through `Authorization: Bearer <jwt>`, the
/// row-level-security policy on `chats` constrains every select/insert/
/// update/delete to `auth.uid() = user_id`.
final class ChatService {
    static let shared = ChatService()
    private init() {}

    private let supabaseUrl = "https://ejxkzsfruykvgeouymfy.supabase.co"
    private let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE"

    private func authedRequest(path: String, method: String) async -> URLRequest? {
        guard let token = await AuthService.shared.getValidToken() else { return nil }
        var req = URLRequest(url: URL(string: "\(supabaseUrl)\(path)")!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return req
    }

    private static var iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            // Supabase returns timestamps with optional fractional seconds and
            // optional timezone offset — try both shapes.
            if let date = iso8601.date(from: raw) { return date }
            let withoutFrac = ISO8601DateFormatter()
            withoutFrac.formatOptions = [.withInternetDateTime]
            if let date = withoutFrac.date(from: raw) { return date }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unrecognized ISO8601 timestamp: \(raw)"
            )
        }
        return d
    }()

    /// Most-recent-first list of chats for the signed-in user.
    func listChats() async throws -> [Chat] {
        guard let userId = AuthService.shared.currentUser?.id else { throw APIError.notAuthenticated }
        let path = "/rest/v1/chats?user_id=eq.\(userId)&order=updated_at.desc&select=id,title,messages,created_at,updated_at"
        guard var req = await authedRequest(path: path, method: "GET") else { throw APIError.notAuthenticated }
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.jobCreationFailed("listChats failed: \((resp as? HTTPURLResponse)?.statusCode ?? -1)")
        }
        return try Self.decoder.decode([Chat].self, from: data)
    }

    /// Create an empty chat. Server fills in id + timestamps + default title.
    func createChat() async throws -> Chat {
        guard let userId = AuthService.shared.currentUser?.id else { throw APIError.notAuthenticated }
        guard var req = await authedRequest(path: "/rest/v1/chats", method: "POST") else {
            throw APIError.notAuthenticated
        }
        req.setValue("return=representation", forHTTPHeaderField: "Prefer")
        let body: [String: Any] = [
            "user_id": userId,
            "title": "New Chat",
            "messages": [],
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw APIError.jobCreationFailed("createChat \((resp as? HTTPURLResponse)?.statusCode ?? -1): \(body)")
        }
        let rows = try Self.decoder.decode([Chat].self, from: data)
        guard let chat = rows.first else {
            throw APIError.jobCreationFailed("createChat: empty response")
        }
        return chat
    }

    /// Persist the latest message list + auto-derived title for a chat.
    /// Server's BEFORE UPDATE trigger refreshes updated_at automatically.
    /// READ, MERGE, THEN WRITE UNDER A COMPARE-AND-SET.
    ///
    /// This PATCHed `{"messages": <entire array>}` against `?id=eq.<id>` — a
    /// blind whole-column write. The server attaches a render's assistant
    /// message with CAS, correctly; this then wrote back an array that predated
    /// the attach and the message was gone. 16 of 16 stranded jobs (2026-09-09)
    /// had a client write to that user's chats after the render completed —
    /// every one, no exceptions.
    ///
    /// THE CAS IS NOT OPTIONAL. Read-merge-write alone narrows the window; it
    /// does not close it. A server attach landing between the read and the
    /// PATCH is lost exactly as before, and this is a write the sweep re-issues
    /// every ten minutes, so a narrow window is one that gets hit. The filter
    /// carries the `updated_at` the read returned; a row that moved underneath
    /// matches nothing, and the merge runs again on what is actually there.
    ///
    /// Bounded at three attempts and then it throws, so the caller re-queues.
    /// It does NOT fall back to the blind write — falling back to the defect
    /// under contention is falling back exactly when it matters.
    func updateChat(id: String, messages: [SerializedMessage], title: String?,
                    seen: Set<String> = []) async throws {
        for attempt in 1...3 {
            let current = try await fetchChatRow(id: id)
            let merged = ChatMessageMerge.merged(local: messages,
                                                 remote: current.messages,
                                                 seen: seen)
            if try await patchChat(id: id, messages: merged, title: title,
                                   ifUpdatedAt: current.updatedAt) { return }
            print("[chats] updateChat \(id): row moved under attempt \(attempt) — re-merging")
        }
        throw APIError.jobCreationFailed("updateChat \(id): lost the CAS three times")
    }

    private struct ChatRow { let messages: [SerializedMessage]; let updatedAt: String }

    private func fetchChatRow(id: String) async throws -> ChatRow {
        guard let req = await authedRequest(
            path: "/rest/v1/chats?id=eq.\(id)&select=messages,updated_at", method: "GET") else {
            throw APIError.notAuthenticated
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.jobCreationFailed("chat read failed: \((resp as? HTTPURLResponse)?.statusCode ?? -1)")
        }
        guard let rows = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              let row = rows.first else {
            // The row is gone (deleted on another device). Nothing to merge
            // against and nothing to preserve.
            return ChatRow(messages: [], updatedAt: "")
        }
        let updatedAt = row["updated_at"] as? String ?? ""
        var msgs: [SerializedMessage] = []
        if let raw = row["messages"], JSONSerialization.isValidJSONObject(["m": raw]) {
            let blob = try JSONSerialization.data(withJSONObject: raw)
            msgs = (try? Self.decoder.decode([SerializedMessage].self, from: blob)) ?? []
        }
        return ChatRow(messages: msgs, updatedAt: updatedAt)
    }

    /// Returns true when the row was actually written. `return=representation`
    /// makes PostgREST hand back the rows it touched, so zero rows is a LOST
    /// CAS rather than a silent success — a 200 with an empty body is exactly
    /// the shape this whole fix exists to stop trusting.
    private func patchChat(id: String, messages: [SerializedMessage], title: String?,
                           ifUpdatedAt: String) async throws -> Bool {
        var path = "/rest/v1/chats?id=eq.\(id)"
        if !ifUpdatedAt.isEmpty,
           let enc = ifUpdatedAt.addingPercentEncoding(withAllowedCharacters: .alphanumerics) {
            path += "&updated_at=eq.\(enc)"
        }
        guard var req = await authedRequest(path: path, method: "PATCH") else {
            throw APIError.notAuthenticated
        }
        req.setValue("return=representation", forHTTPHeaderField: "Prefer")
        // Encode messages through JSONEncoder so dates serialize consistently
        // with the schema's JSONB column.
        let messagesJSON = try JSONEncoder().encode(messages)
        guard let messagesAny = try JSONSerialization.jsonObject(with: messagesJSON) as? [[String: Any]] else {
            throw APIError.jobCreationFailed("messages encoding failed")
        }
        var body: [String: Any] = ["messages": messagesAny]
        if let title { body["title"] = title }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let bodyStr = String(data: data, encoding: .utf8) ?? ""
            throw APIError.jobCreationFailed("updateChat \((resp as? HTTPURLResponse)?.statusCode ?? -1): \(bodyStr)")
        }
        // ZERO ROWS IS A LOST CAS, NOT A SUCCESS. PostgREST answers a PATCH
        // that matched nothing with 200 and `[]`, which is the same
        // empty-success shape that hid this class in the first place.
        let touched = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
        return !(touched?.isEmpty ?? true)
    }

    /// Hard-delete a chat. RLS prevents touching anyone else's row.
    /// We never delete chats automatically — only via this user-driven
    /// path (long-press → confirm).
    func deleteChat(id: String) async throws {
        guard let req = await authedRequest(path: "/rest/v1/chats?id=eq.\(id)", method: "DELETE") else {
            throw APIError.notAuthenticated
        }
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.jobCreationFailed("deleteChat \((resp as? HTTPURLResponse)?.statusCode ?? -1)")
        }
    }
}
