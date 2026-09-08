import Foundation

// Standalone unit tests for ChatListMerge — the rule deciding what a server
// list is allowed to REMOVE from the chats already on screen. UI-free:
//
//   swiftc ../Promptly/Services/ChatListMerge.swift ChatListMergeTests.swift -o /tmp/cmtest && /tmp/cmtest
//
// (or: ios/Promptly/Tests/run.sh). Exit code is non-zero if any check fails.
//
// The defect: loadChats assigned `fetched` straight onto `chats`, so a 200
// carrying [] — a stale token, a transient RLS miss — wiped the thread the user
// was looking at. It ran on every foreground. The catch block never cleared on
// an ERROR, which is the tell: the unhandled failure shape arrives as a success.

var failures = 0
var checks = 0
func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}

struct Row: ChatListItem, Equatable {
    let id: String
    let updatedAt: Date
}
func t(_ s: Double) -> Date { Date(timeIntervalSince1970: 1_700_000_000 + s) }
func ids(_ r: [Row]) -> [String] { r.map(\.id) }

@main
struct ChatListMergeTestMain {
static func main() {

let a = Row(id: "a", updatedAt: t(300))
let b = Row(id: "b", updatedAt: t(200))
let c = Row(id: "c", updatedAt: t(100))

// THE DEFECT ITSELF. An empty success must remove nothing.
check(ids(ChatListMerge.merged(fetched: [Row](), local: [a, b], unsavedIds: [])) == ["a", "b"],
      "empty fetch keeps every locally-held chat")
check(ids(ChatListMerge.merged(fetched: [Row](), local: [a], unsavedIds: ["a"])) == ["a"],
      "empty fetch keeps an unsaved chat too")

// …and must not invent one. An empty server list over an empty local list is
// still empty — the fix must not turn "no chats" into a permanent nil-guard.
check(ChatListMerge.merged(fetched: [Row](), local: [], unsavedIds: []).isEmpty,
      "empty fetch over empty local stays empty")

// THE SERVER IS STILL AUTHORITATIVE WHEN IT SAYS SOMETHING. A non-empty list
// propagates deletion: c is gone server-side and has no pending save.
check(ids(ChatListMerge.merged(fetched: [a, b], local: [a, b, c], unsavedIds: [])) == ["a", "b"],
      "a non-empty list still deletes a chat the server dropped")
check(ids(ChatListMerge.merged(fetched: [a], local: [a, b, c], unsavedIds: [])) == ["a"],
      "deletion down to one chat propagates")

// THE DEBOUNCE WINDOW. A chat whose save has not landed is absent from the
// server list through no fault of anyone's — foregrounding mid-debounce
// dropped it. It survives; anything else the server omits does not.
check(ids(ChatListMerge.merged(fetched: [a], local: [a, b], unsavedIds: ["b"])) == ["a", "b"],
      "an unsaved local chat survives a list that omits it")
check(ids(ChatListMerge.merged(fetched: [a], local: [a, b], unsavedIds: ["zzz"])) == ["a"],
      "a saved local chat the server omits is a real deletion")
check(ids(ChatListMerge.merged(fetched: [b], local: [a, b], unsavedIds: ["a", "b"])) == ["a", "b"],
      "a pending id already present in the fetch is not duplicated")

// ORDER IS THE SERVER'S — updated_at.desc — re-established over the union, so
// a retained chat sits where its own timestamp puts it, not on the end.
let fresh = Row(id: "fresh", updatedAt: t(999))
check(ids(ChatListMerge.merged(fetched: [a, c], local: [fresh], unsavedIds: ["fresh"])) == ["fresh", "a", "c"],
      "a retained chat sorts by its own updatedAt, not appended")
let stale = Row(id: "stale", updatedAt: t(150))
check(ids(ChatListMerge.merged(fetched: [a, c], local: [stale], unsavedIds: ["stale"])) == ["a", "stale", "c"],
      "a retained chat can sort into the middle")

// PASS-THROUGH. Nothing retained means the fetched order is returned untouched,
// including any order the server chose that a re-sort would have disturbed.
check(ids(ChatListMerge.merged(fetched: [c, a, b], local: [], unsavedIds: [])) == ["c", "a", "b"],
      "with nothing retained the server's order is passed through unchanged")

print("\n\(checks - failures)/\(checks) checks passed")
if failures > 0 { exit(1) }
}
}
