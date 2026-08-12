import Foundation

// Item 7b — unit tests for the CONTRACT-FREE machinery: the part planner, the
// chunk-to-file materializer, and the resume ledger. Pure Foundation, no device,
// no server — exactly the pieces that can be proven now (the network contract
// and the background-session resume loop are gated elsewhere).
//
//   swiftc ../Promptly/Services/ResumableUpload.swift ResumableUploadTests.swift \
//          -o /tmp/resumabletest && /tmp/resumabletest
// (wired into Tests/run.sh)
//
// Compiled as two files, so top-level executable statements aren't allowed; the
// globals below are declarations and the run body lives in @main (same shape as
// the other tests in this folder, e.g. TricklePacingTests).

var failures = 0, checks = 0
func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}

@main
struct ResumableUploadTestMain {
    static func main() throws {
        let MB: Int64 = 1024 * 1024

        // ── 1. partPlan — the split math ─────────────────────────────────────

        // Exact multiple: 48MB at 16MB → 3 full parts.
        let exact = MultipartChunker.partPlan(fileSize: 48 * MB, partSize: 16 * MB)
        check(exact.count == 3, "48MB/16MB → 3 parts")
        check(exact.map { $0.partNumber } == [1, 2, 3], "part numbers are 1-based, ascending")
        check(exact.allSatisfy { $0.length == 16 * MB }, "exact multiple → every part is full")
        check(exact[0].offset == 0 && exact[1].offset == 16 * MB && exact[2].offset == 32 * MB,
              "offsets are contiguous")

        // Remainder: 40MB at 16MB → 16 + 16 + 8.
        let rem = MultipartChunker.partPlan(fileSize: 40 * MB, partSize: 16 * MB)
        check(rem.count == 3, "40MB/16MB → 3 parts")
        check(rem[2].length == 8 * MB, "final part carries the remainder (8MB)")
        check(rem.reduce(0) { $0 + $1.length } == 40 * MB, "part lengths sum to the file size")

        // Smaller than one part: 5MB at 16MB → a single whole-file part.
        let small = MultipartChunker.partPlan(fileSize: 5 * MB, partSize: 16 * MB)
        check(small.count == 1 && small[0].length == 5 * MB, "file < partSize → one whole-file part")

        // Degenerate inputs.
        check(MultipartChunker.partPlan(fileSize: 0, partSize: 16 * MB).isEmpty, "empty file → no parts")
        check(MultipartChunker.partPlan(fileSize: -1, partSize: 16 * MB).isEmpty, "negative file → no parts")
        check(MultipartChunker.partPlan(fileSize: 10 * MB, partSize: 0).count == 1,
              "partSize 0 clamps to one whole-file part (no divide-by-zero)")
        check(MultipartChunker.partCount(fileSize: 40 * MB, partSize: 16 * MB) == 3, "partCount matches plan")

        // ── 2. writePart — chunk-to-file byte fidelity ───────────────────────

        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("resumable-test-\(ProcessInfo.processInfo.processIdentifier)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        // A deterministic fixture: byte i = i % 251 (prime avoids alignment coincidences).
        let fixtureSize = 5 * 1024 * 1024 + 12345   // ~5MB, deliberately not a round number
        var fixtureBytes = Data(count: fixtureSize)
        for i in 0..<fixtureSize { fixtureBytes[i] = UInt8(i % 251) }
        let fixtureURL = tmp.appendingPathComponent("fixture.bin")
        try fixtureBytes.write(to: fixtureURL)

        // Chunk at 1MB, materialize every part, verify each part's bytes equal the
        // corresponding slice, and that concatenating them reconstructs the original.
        let plan = MultipartChunker.partPlan(fileSize: Int64(fixtureSize), partSize: MB)
        check(plan.count == 6, "~5.01MB/1MB → 6 parts")
        var reassembled = Data()
        var allPartsMatch = true
        for range in plan {
            let partURL = tmp.appendingPathComponent("part-\(range.partNumber).bin")
            do {
                try MultipartChunker.writePart(from: fixtureURL, range: range, to: partURL)
            } catch {
                allPartsMatch = false
                check(false, "writePart threw for part \(range.partNumber): \(error)")
                continue
            }
            let partData = (try? Data(contentsOf: partURL)) ?? Data()
            let expected = fixtureBytes.subdata(in: Int(range.offset)..<Int(range.offset + range.length))
            if Int64(partData.count) != range.length || partData != expected { allPartsMatch = false }
            reassembled.append(partData)
        }
        check(allPartsMatch, "each materialized part equals its byte-range of the source")
        check(reassembled == fixtureBytes, "concatenated parts reconstruct the original file exactly")

        // A part that runs past EOF throws .shortRead (never uploads a truncated part).
        let overrun = MultipartPartRange(partNumber: 1, offset: Int64(fixtureSize) - 10, length: 100)
        var threwShortRead = false
        do {
            try MultipartChunker.writePart(from: fixtureURL, range: overrun,
                                           to: tmp.appendingPathComponent("overrun.bin"))
        } catch MultipartError.shortRead { threwShortRead = true } catch {}
        check(threwShortRead, "a part past EOF throws .shortRead")

        // ── 3. MultipartResumeLedger — resume + persistence ──────────────────

        var ledger = MultipartResumeLedger(
            uploadId: "up-123", key: "uploads/abc.mp4",
            publicUrl: "https://cdn/abc.mp4", fileSize: 40 * MB, partSize: 16 * MB
        )
        check(ledger.partCount == 3, "ledger derives partCount (40MB/16MB = 3)")
        check(ledger.remainingPartNumbers() == [1, 2, 3], "fresh ledger: all parts remain")
        check(!ledger.isComplete, "fresh ledger is not complete")
        check(ledger.orderedParts() == nil, "orderedParts nil until every part is present")

        ledger.record(partNumber: 1, eTag: "etag-1")
        ledger.record(partNumber: 3, eTag: "etag-3")
        check(ledger.remainingPartNumbers() == [2], "after 1 & 3 upload, only part 2 remains (resume skips 1 & 3)")
        check(!ledger.isComplete, "still incomplete with a gap at part 2")

        // Idempotent re-record (a retried part) must not create a phantom or complete early.
        ledger.record(partNumber: 1, eTag: "etag-1-retry")
        check(ledger.remainingPartNumbers() == [2], "re-recording part 1 doesn't change what remains")

        ledger.record(partNumber: 2, eTag: "etag-2")
        check(ledger.isComplete, "all three parts recorded → complete")
        check(ledger.remainingPartNumbers().isEmpty, "nothing remains when complete")
        let ordered = ledger.orderedParts()
        check(ordered?.map { $0.partNumber } == [1, 2, 3], "orderedParts ascending by PartNumber")
        check(ordered?[0].eTag == "etag-1-retry", "orderedParts carries the latest (retried) ETag")

        // Persistence round-trip: save, reload, confirm the resume state survives.
        try ledger.save(in: tmp)
        let reloaded = MultipartResumeLedger.load(uploadId: "up-123", in: tmp)
        check(reloaded == ledger, "ledger round-trips through disk unchanged")
        check(reloaded?.isComplete == true, "reloaded ledger is still complete (resume would skip everything)")

        // A partial ledger reloads with the right remaining set — the actual resume case.
        var partial = MultipartResumeLedger(
            uploadId: "up-partial", key: "k", publicUrl: "u", fileSize: 40 * MB, partSize: 16 * MB
        )
        partial.record(partNumber: 1, eTag: "e1")
        try partial.save(in: tmp)
        let partialReloaded = MultipartResumeLedger.load(uploadId: "up-partial", in: tmp)
        check(partialReloaded?.remainingPartNumbers() == [2, 3],
              "reloaded partial ledger resumes at parts 2 & 3 (part 1 already done)")

        check(MultipartResumeLedger.load(uploadId: "does-not-exist", in: tmp) == nil,
              "missing ledger loads as nil (a fresh upload)")

        MultipartResumeLedger.clear(uploadId: "up-123", in: tmp)
        check(MultipartResumeLedger.load(uploadId: "up-123", in: tmp) == nil, "clear removes the ledger")

        print("\n\(checks - failures)/\(checks) passed")
        exit(failures == 0 ? 0 : 1)
    }
}
