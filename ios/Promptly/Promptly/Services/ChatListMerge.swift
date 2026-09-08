import Foundation

/// WHAT A SERVER LIST IS ALLOWED TO REMOVE.
///
/// Its own file, and generic over the two fields it actually reads, so the rule
/// can be exercised without a network, an account, or a `Chat`. The behaviour
/// lives in Tests/ChatListMergeTests.swift — a grep over ChatStore would only
/// prove the call site still spells the same words.
protocol ChatListItem {
    var id: String { get }
    var updatedAt: Date { get }
}

enum ChatListMerge {
    /// Two things `chats = fetched` got wrong.
    ///
    /// 1. AN EMPTY LIST IS NOT AUTHORITATIVE. A 200 carrying `[]` is
    ///    indistinguishable, at this layer, from a stale token or a transient
    ///    RLS miss — and it wiped the thread the user was looking at, on every
    ///    foreground (AppShell's willEnterForeground calls loadChats). The
    ///    catch block was already careful never to clear on an error, which is
    ///    the tell: only one of the two failure shapes was handled, and the
    ///    unhandled one arrives as a success.
    ///
    ///    So an empty list removes nothing. The cost is bounded and small — a
    ///    user who deletes their VERY LAST chat on another device keeps seeing
    ///    it until a non-empty load or a local delete — and deletion still
    ///    propagates the moment one chat remains. Showing a stale row is not a
    ///    symmetric trade with losing a conversation.
    ///
    /// 2. A CHAT WHOSE SAVE HAS NOT LANDED IS NOT A DELETED CHAT. Saves are
    ///    debounced, so a chat created seconds ago is legitimately absent from
    ///    the server list. Foregrounding mid-debounce dropped it. Anything
    ///    still in `pendingSaves` survives a list that omits it; anything else
    ///    the server omits is a real deletion and goes.
    ///
    /// Order is the server's — `updated_at.desc` — re-established over the
    /// union so a retained chat sits where its own timestamp puts it.
    static func merged<T: ChatListItem>(fetched: [T], local: [T], unsavedIds: Set<String>) -> [T] {
        if fetched.isEmpty { return local }
        let fetchedIds = Set(fetched.map(\.id))
        let retained = local.filter { !fetchedIds.contains($0.id) && unsavedIds.contains($0.id) }
        if retained.isEmpty { return fetched }
        return (fetched + retained).sorted { $0.updatedAt > $1.updatedAt }
    }
}
