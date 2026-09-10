import Foundation

/// WHAT A CLIENT SAVE IS ALLOWED TO REMOVE FROM A CHAT.
///
/// Its own file, generic over the one field it reads, so the rule can be
/// exercised without a network or a `SerializedMessage`. The behaviour lives in
/// Tests/ChatMessageMergeTests.swift.
protocol ChatMessageIdentifiable {
    var id: String { get }
}

enum ChatMessageMerge {
    /// THE DEFECT (measured 2026-09-09, 16 of 16 with no exceptions).
    ///
    /// `updateChat` PATCHed `{"messages": <entire array>}` against
    /// `?id=eq.<id>` — a blind whole-column write. The server attaches a
    /// render's assistant message with CAS, correctly; the client then wrote
    /// back an array that predated that attach and the message was gone. The
    /// PATCH returned 200, the job stayed `completed` with a
    /// `rendered_video_url`, and the only trace was a jobId that appeared in no
    /// chat. Two of the sixteen made it visible: a server-created chat holding
    /// ZERO messages, and one holding twenty, none of them the render.
    ///
    /// THE TWO ABSENCES ARE DIFFERENT, and telling them apart is the whole job:
    ///
    ///   absent because I never saw it   → the server wrote it after my last
    ///                                     read. PRESERVE it. I cannot have
    ///                                     deleted what I never read.
    ///   absent because I removed it     → I read it and dropped it. HONOUR
    ///                                     that. A merge that keeps everything
    ///                                     resurrects deleted messages, which
    ///                                     is the same bug pointing the other
    ///                                     way.
    ///
    /// `seen` is what separates them: every id this client has read from the
    /// server or created itself, for this chat. It is the merge base — local is
    /// "mine", remote is "theirs", seen is the common ancestor.
    ///
    /// ORDER: local order is kept exactly, and preserved server-only messages
    /// are APPENDED in remote order. A render message is the newest thing in
    /// the conversation, and `SerializedMessage` carries no timestamp to sort
    /// on — so appending is the only honest placement rather than a guess at
    /// where it belongs.
    static func merged<M: ChatMessageIdentifiable>(
        local: [M], remote: [M], seen: Set<String>
    ) -> [M] {
        let localIds = Set(local.map(\.id))
        let rescued = remote.filter { !localIds.contains($0.id) && !seen.contains($0.id) }
        return rescued.isEmpty ? local : local + rescued
    }
}
