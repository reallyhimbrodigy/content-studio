import Foundation

// Item 7b — unit tests for the CONTRACT-FREE machinery against SERVER_CONTRACTS_226
// Contract 2: the part planner (≥5 MiB except the last; ≤1000 parts), the
// chunk-to-file materializer, and the resume + abort ledger (ETags verbatim,
// skip-completed, expiry/abort worklist). Pure Foundation, no device, no server.
//
//   swiftc ../Promptly/Services/ResumableUpload.swift ResumableUploadTests.swift \
//          -o /tmp/resumabletest && /tmp/resumabletest
// (wired into Tests/run.sh)

var failures = 0, checks = 0
func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}

@main
struct ResumableUploadTestMain {
    static func main() throws {
        let MB: Int64 = 1024 * 1024
        let MIN = MultipartChunker.s3MinPartSize   // 5 MiB

        // ── 1. partPlan — split math + the ≥5 MiB guarantee ──────────────────

        // Exact multiple: 48MB at 16MB → 3 full parts.
        let exact = MultipartChunker.partPlan(fileSize: 48 * MB, partSize: 16 * MB)
        check(exact.map { $0.partNumber } == [1, 2, 3], "part numbers are 1-based, ascending")
        check(exact.allSatisfy { $0.length == 16 * MB }, "exact multiple → every part is full")
        check(exact[0].offset == 0 && exact[1].offset == 16 * MB && exact[2].offset == 32 * MB,
              "offsets are contiguous")

        // Remainder: 40MB at 16MB → 16 + 16 + 8.
        let rem = MultipartChunker.partPlan(fileSize: 40 * MB, partSize: 16 * MB)
        check(rem.count == 3 && rem[2].length == 8 * MB, "40MB/16MB → 3 parts, last carries the 8MB remainder")
        check(rem.reduce(0) { $0 + $1.length } == 40 * MB, "part lengths sum to the file size")

        // Smaller than one part → a single (last) part, any size.
        let small = MultipartChunker.partPlan(fileSize: 5 * MB, partSize: 16 * MB)
        check(small.count == 1 && small[0].length == 5 * MB, "file < partSize → one whole-file part")

        // THE CONTRACT-2 GUARANTEE: a sub-5-MiB partSize is clamped UP so no MIDDLE
        // part is short (a short middle part passes the PUT and dies at complete).
        let clamped = MultipartChunker.partPlan(fileSize: 12 * MB, partSize: 4 * MB)
        check(clamped.count == 3, "12MB at a 4MB request → 3 parts (clamped to 5MB), not 3×4MB")
        check(clamped[0].length == MIN && clamped[1].length == MIN, "middle parts are clamped to 5 MiB, never 4")
        check(clamped[2].length == 2 * MB, "last part carries the 2MB remainder (may be < 5 MiB)")
        check(MultipartChunker.partsSatisfyS3SizeRule(clamped), "clamped plan satisfies the S3 size rule")

        // Degenerate inputs.
        check(MultipartChunker.partPlan(fileSize: 0, partSize: 16 * MB).isEmpty, "empty file → no parts")
        check(MultipartChunker.partPlan(fileSize: -1, partSize: 16 * MB).isEmpty, "negative file → no parts")
        check(MultipartChunker.partPlan(fileSize: 10 * MB, partSize: 0).count == 1,
              "partSize 0 → one whole-file part (no divide-by-zero)")

        // partsSatisfyS3SizeRule catches a hand-built short middle part.
        let bad = [MultipartPartRange(partNumber: 1, offset: 0, length: MIN),
                   MultipartPartRange(partNumber: 2, offset: MIN, length: 4 * MB),   // short MIDDLE part
                   MultipartPartRange(partNumber: 3, offset: MIN + 4 * MB, length: MB)]
        check(!MultipartChunker.partsSatisfyS3SizeRule(bad), "a short MIDDLE part fails the size rule")
        check(MultipartChunker.partsSatisfyS3SizeRule([bad[0]]), "a single (last-only) part always passes")

        // ── 2. chosenPartSize — ≥5 MiB and ≤1000 parts ───────────────────────

        check(MultipartChunker.chosenPartSize(fileSize: 50 * MB) == 16 * MB,
              "a normal clip uses the 16 MiB default")
        check(MultipartChunker.chosenPartSize(fileSize: 3 * MB) == 16 * MB,
              "a tiny file still reports the default part size (yields one part)")
        let huge: Int64 = 40 * 1024 * MB   // 40 GiB
        let hugePS = MultipartChunker.chosenPartSize(fileSize: huge)
        check(hugePS >= MIN, "huge-file part size stays ≥ 5 MiB")
        check(MultipartChunker.partCount(fileSize: huge, partSize: hugePS) <= MultipartChunker.maxParts,
              "huge file grows the part size to keep the count ≤ 1000")

        // ── 3. writePart — chunk-to-file byte fidelity (explicit ranges) ─────

        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("resumable-test-\(ProcessInfo.processInfo.processIdentifier)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        // Deterministic fixture: byte i = i % 251 (prime avoids alignment coincidences).
        let fixtureSize = 5 * 1024 * 1024 + 12345   // ~5MB, deliberately not round
        var fixtureBytes = Data(count: fixtureSize)
        for i in 0..<fixtureSize { fixtureBytes[i] = UInt8(i % 251) }
        let fixtureURL = tmp.appendingPathComponent("fixture.bin")
        try fixtureBytes.write(to: fixtureURL)

        // Explicit 1MB ranges (independent of partPlan's clamp) exercise multi-part
        // materialization: verify each part's bytes and that they reconstruct the file.
        var explicit: [MultipartPartRange] = []
        var off: Int64 = 0, n = 1
        while off < Int64(fixtureSize) {
            let len = min(MB, Int64(fixtureSize) - off)
            explicit.append(MultipartPartRange(partNumber: n, offset: off, length: len))
            off += len; n += 1
        }
        check(explicit.count == 6, "~5.01MB in 1MB ranges → 6 parts")
        var reassembled = Data()
        var allPartsMatch = true
        for range in explicit {
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

        // A part past EOF throws .shortRead (never uploads a truncated part).
        let overrun = MultipartPartRange(partNumber: 1, offset: Int64(fixtureSize) - 10, length: 100)
        var threwShortRead = false
        do {
            try MultipartChunker.writePart(from: fixtureURL, range: overrun,
                                           to: tmp.appendingPathComponent("overrun.bin"))
        } catch MultipartError.shortRead { threwShortRead = true } catch {}
        check(threwShortRead, "a part past EOF throws .shortRead")

        // ── 4. Resume ledger — skip-completed + ETag verbatim ────────────────

        let created = Date(timeIntervalSince1970: 1_700_000_000)
        var ledger = MultipartResumeLedger(
            uploadId: "up-123", key: "sources/u/abc.mp4",
            publicUrl: "https://cdn/abc.mp4", fileSize: 40 * MB, partSize: 16 * MB, createdAt: created
        )
        check(ledger.partCount == 3, "ledger derives partCount (40MB/16MB = 3)")
        check(ledger.remainingPartNumbers() == [1, 2, 3], "fresh ledger: all parts remain")
        check(!ledger.isComplete && ledger.orderedParts() == nil, "fresh ledger incomplete; orderedParts nil")

        // ETags are stored VERBATIM, quotes included — S3 compares them exactly.
        ledger.record(partNumber: 1, eTag: "\"9b2cf5aa\"")
        ledger.record(partNumber: 3, eTag: "\"1a77de03\"")
        check(ledger.remainingPartNumbers() == [2], "after 1 & 3, only part 2 remains (resume skips 1 & 3)")

        ledger.record(partNumber: 1, eTag: "\"retry-etag\"")   // idempotent re-record
        check(ledger.remainingPartNumbers() == [2], "re-recording part 1 doesn't change what remains")

        ledger.record(partNumber: 2, eTag: "\"cc00ff11\"")
        check(ledger.isComplete && ledger.remainingPartNumbers().isEmpty, "all parts recorded → complete")
        let ordered = ledger.orderedParts()
        check(ordered?.map { $0.partNumber } == [1, 2, 3], "orderedParts ascending by PartNumber")
        check(ordered?[0].eTag == "\"retry-etag\"", "ETag kept verbatim WITH quotes (latest retry wins)")

        // Persistence round-trip (createdAt + completed survive).
        try ledger.save(in: tmp)
        let reloaded = MultipartResumeLedger.load(uploadId: "up-123", in: tmp)
        check(reloaded == ledger, "ledger round-trips through disk unchanged (incl. createdAt + ETags)")

        // A partial ledger reloads with the right remaining set — the resume case.
        var partial = MultipartResumeLedger(
            uploadId: "up-partial", key: "k", publicUrl: "u",
            fileSize: 40 * MB, partSize: 16 * MB, createdAt: created
        )
        partial.record(partNumber: 1, eTag: "\"e1\"")
        try partial.save(in: tmp)
        check(MultipartResumeLedger.load(uploadId: "up-partial", in: tmp)?.remainingPartNumbers() == [2, 3],
              "reloaded partial ledger resumes at parts 2 & 3")
        check(MultipartResumeLedger.load(uploadId: "nope", in: tmp) == nil, "missing ledger loads as nil (fresh)")

        // ── 5. Abort lifecycle — expiry + sweep worklist ─────────────────────

        check(!ledger.isExpired(ttl: 3600, now: created.addingTimeInterval(100)), "not expired within the ttl")
        check(ledger.isExpired(ttl: 3600, now: created.addingTimeInterval(3601)), "expired once past the ttl")

        // `all` sees every persisted ledger; `expired` is the abort-sweep worklist.
        let all = MultipartResumeLedger.all(in: tmp)
        check(Set(all.map { $0.uploadId }) == ["up-123", "up-partial"], "all() enumerates every persisted ledger")
        let worklist = MultipartResumeLedger.expired(in: tmp, ttl: 3600, now: created.addingTimeInterval(7200))
        check(worklist.count == 2 && worklist.allSatisfy { !$0.key.isEmpty && !$0.uploadId.isEmpty },
              "expired() returns (key, uploadId) for each stale upload — what abort needs")
        check(MultipartResumeLedger.expired(in: tmp, ttl: 3600, now: created.addingTimeInterval(60)).isEmpty,
              "nothing expired while all uploads are fresh")

        MultipartResumeLedger.clear(uploadId: "up-123", in: tmp)
        check(MultipartResumeLedger.load(uploadId: "up-123", in: tmp) == nil, "clear removes the ledger (post-abort)")
        check(MultipartResumeLedger.all(in: tmp).map { $0.uploadId } == ["up-partial"], "all() reflects the clear")

        print("\n\(checks - failures)/\(checks) passed")
        exit(failures == 0 ? 0 : 1)
    }
}
