import Foundation

// Standalone unit tests for ChatMessageMerge — what a client save may remove
// from a chat. UI-free:
//
//   swiftc ../Promptly/Services/ChatMessageMerge.swift ChatMessageMergeTests.swift -o /tmp/cmm && /tmp/cmm
//
// (or: ios/Promptly/Tests/run.sh). Exit code is non-zero if any check fails.
//
// The defect: the client PATCHed the whole messages array blind, so the
// server's correctly-CAS'd render attach was overwritten by an array that
// predated it. 16 of 16 stranded jobs had a client write after the render
// completed. The opposite defect is just as real — a merge that keeps
// everything resurrects messages the user deleted — so both directions are
// asserted here.

var failures = 0, checks = 0
func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}
struct M: ChatMessageIdentifiable, Equatable { let id: String }
func ids(_ a: [M]) -> [String] { a.map(\.id) }

@main
struct ChatMessageMergeTestMain {
static func main() {

let a = M(id: "a"), b = M(id: "b"), render = M(id: "render")

// THE DEFECT ITSELF. The server attached `render` after this client last read.
check(ids(ChatMessageMerge.merged(local: [a, b], remote: [a, b, render], seen: ["a", "b"]))
      == ["a", "b", "render"],
      "a message written after my last read is PRESERVED")

// THE OPPOSITE DEFECT. The client read `b` and deleted it; the merge must not
// bring it back.
check(ids(ChatMessageMerge.merged(local: [a], remote: [a, b], seen: ["a", "b"])) == ["a"],
      "a message I read and removed stays removed")

// BOTH AT ONCE — the case that separates a real merge from a union.
check(ids(ChatMessageMerge.merged(local: [a], remote: [a, b, render], seen: ["a", "b"]))
      == ["a", "render"],
      "delete honoured and server message preserved in the same save")

// LOCAL WINS ON IDS PRESENT IN BOTH: my edit of a message I hold is not
// reverted by the copy I read earlier.
let edited = M(id: "a")
check(ChatMessageMerge.merged(local: [edited], remote: [a], seen: ["a"]).first == edited,
      "local copy is kept for an id present on both sides")

// ORDER: local order exactly, rescued messages appended in remote order.
check(ids(ChatMessageMerge.merged(local: [b, a], remote: [a, b, render], seen: ["a", "b"]))
      == ["b", "a", "render"],
      "local order is preserved and the rescue is appended")
let r1 = M(id: "r1"), r2 = M(id: "r2")
check(ids(ChatMessageMerge.merged(local: [a], remote: [r2, r1, a], seen: ["a"]))
      == ["a", "r2", "r1"],
      "two rescued messages keep the remote's own order")

// AN EMPTY SEEN SET IS THE COLD-START CASE: nothing has been read, so nothing
// can have been deleted, so nothing on the server may be dropped.
check(ids(ChatMessageMerge.merged(local: [], remote: [a, b], seen: [])) == ["a", "b"],
      "with nothing seen, a save removes nothing")

// AND NO REMOTE MESSAGES MEANS NO CHANGE — the common case must not allocate a
// different array or reorder anything.
check(ids(ChatMessageMerge.merged(local: [a, b], remote: [], seen: ["a", "b"])) == ["a", "b"],
      "nothing on the server leaves the local array exactly as it was")
check(ids(ChatMessageMerge.merged(local: [a, b], remote: [a, b], seen: ["a", "b"])) == ["a", "b"],
      "an identical server copy is a no-op")

// THE RESURRECTION GUARD IS `seen`, NOT PRESENCE. A message absent from local
// and absent from seen is preserved even when local is empty — that is a
// backgrounded client whose array is stale, not a user who cleared the chat.
check(ids(ChatMessageMerge.merged(local: [], remote: [render], seen: ["a"])) == ["render"],
      "an empty local array does not wipe a server message it never saw")

print("\n\(checks - failures)/\(checks) checks passed")
if failures > 0 { exit(1) }
}
}
