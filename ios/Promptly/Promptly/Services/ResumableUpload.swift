import Foundation

// Item 7b — resumable multipart upload on a BACKGROUND URLSession, built against
// SERVER_CONTRACTS_226 Contract 2 (init / complete / abort; live, no flag).
//
// This file holds the CONTRACT-FREE, device-independent pieces of 7b:
//
//   1. MultipartChunker — the part planner + `writePart`, which materializes one
//      part to its own file. A background URLSession can only upload `fromFile:`
//      (not a byte-range view of a shared handle), so every part must exist as a
//      standalone file on disk. That is the delta over the dead FOREGROUND
//      multipart path (APIService.uploadFileToS3Multipart), which streams ranges
//      over a foreground session and dies on suspension. The planner GUARANTEES
//      the S3 size rule — every part except the last is ≥5 MiB — so a short
//      middle part (which passes the PUT and fails only at *complete*) is
//      impossible: it is sized right at chunk time.
//
//   2. MultipartResumeLedger — the durable {uploadId, key, partNumber->ETag}
//      record with lifecycle (createdAt / expiry). It lets a relaunch/retry SKIP
//      the parts S3 already has instead of restarting from byte 0, and it drives
//      the ABORT lifecycle: cancel, give-up, and expiry each abort the S3 upload
//      (abandoned parts bill forever) and then clear the ledger.
//
// What is deliberately NOT here, and why:
//   • The /api/upload-multipart-init | -complete | -abort network calls — the
//     wire shapes exist as APIService.Multipart{Init,Complete}Response /
//     MultipartPart; the orchestration that issues them is the wiring step.
//   • The background-URLSession orchestration + suspend/relaunch resume loop —
//     DEVICE-VALIDATION-GATED, provable only on a real device over a dropping
//     network (the reason 7b moved out of 225).
//
// Keeping both out means this file is pure Foundation and is fully unit-tested by
// Tests/ResumableUploadTests.swift with zero device and zero server. It is NOT
// yet in the app target — nothing references it, so it cannot affect the 226
// binary. The commit that wires it adds it to the target with the orchestration.

// MARK: - Part plan

/// One part of a multipart upload: a contiguous byte range of the source file.
/// `partNumber` is 1-based to match the S3 / server contract (parts[].PartNumber).
struct MultipartPartRange: Equatable {
    let partNumber: Int   // 1-based
    let offset: Int64
    let length: Int64
}

enum MultipartError: Error, Equatable {
    /// The source file was shorter than the plan declared — we read fewer bytes
    /// than `expected` for a part. Surfaced rather than uploading a truncated
    /// part (which S3 accepts and the render then chokes on).
    case shortRead(expected: Int64, got: Int64)
}

enum MultipartChunker {
    /// S3's floor for every part except the last (5 MiB). A shorter MIDDLE part is
    /// accepted at PUT time and fails only at complete [Contract 2], so the planner
    /// never emits one.
    static let s3MinPartSize: Int64 = 5 * 1024 * 1024        // 5,242,880 bytes
    /// Default part size — matches the dead foreground path; amortizes per-part
    /// overhead while staying well above the floor.
    static let defaultPartSize: Int64 = 16 * 1024 * 1024
    /// Server cap on part count [Contract 2] (S3's own limit is 10,000; ours is lower).
    static let maxParts = 1000

    /// Pick a part size that (a) is ≥5 MiB so no middle part is short, and (b) keeps
    /// the part count ≤ `maxParts`. Grows the part size for very large files so the
    /// count stays under the cap; never goes below the 16 MiB default.
    static func chosenPartSize(fileSize: Int64) -> Int64 {
        guard fileSize > 0 else { return defaultPartSize }
        let neededForCap = (fileSize + Int64(maxParts) - 1) / Int64(maxParts)   // ceil(fileSize / maxParts)
        return max(defaultPartSize, max(s3MinPartSize, neededForCap))
    }

    /// Split a file of `fileSize` bytes into parts of `partSize` bytes, the final
    /// part carrying the remainder. Returns [] for a non-positive file.
    ///
    /// The part size is clamped UP to `s3MinPartSize` whenever the split would
    /// produce more than one part, so a caller can never accidentally emit a short
    /// middle part. A file smaller than the (clamped) part size yields a single
    /// part — the last part, which may be any size ≥ 1 byte.
    static func partPlan(fileSize: Int64, partSize: Int64) -> [MultipartPartRange] {
        guard fileSize > 0 else { return [] }
        let requested = partSize > 0 ? partSize : fileSize
        let effective = max(requested, s3MinPartSize)   // clamp so no MIDDLE part is short
        var ranges: [MultipartPartRange] = []
        var offset: Int64 = 0
        var number = 1
        while offset < fileSize {
            let length = min(effective, fileSize - offset)
            ranges.append(MultipartPartRange(partNumber: number, offset: offset, length: length))
            offset += length
            number += 1
        }
        return ranges
    }

    /// How many parts a file of `fileSize` splits into at `partSize`.
    static func partCount(fileSize: Int64, partSize: Int64) -> Int {
        partPlan(fileSize: fileSize, partSize: partSize).count
    }

    /// True iff every part except the last is ≥ `s3MinPartSize` — the S3 rule a
    /// multipart complete enforces. A plan from `partPlan` always satisfies this;
    /// this exists as a guard/assertion at the call site.
    static func partsSatisfyS3SizeRule(_ plan: [MultipartPartRange]) -> Bool {
        guard plan.count > 1 else { return true }   // single (last-only) part: any size ok
        return plan.dropLast().allSatisfy { $0.length >= s3MinPartSize }
    }

    /// Materialize ONE part to its own file at `destination`, copying exactly
    /// `range.length` bytes from `range.offset` of `source`. Reads in bounded
    /// chunks so a 16 MiB part never loads more than `ioChunk` into memory.
    /// Overwrites `destination` if it exists. Throws `.shortRead` if the source
    /// runs out before `range.length` bytes are copied.
    static func writePart(from source: URL, range: MultipartPartRange, to destination: URL) throws {
        let reader = try FileHandle(forReadingFrom: source)
        defer { try? reader.close() }
        try reader.seek(toOffset: UInt64(range.offset))

        FileManager.default.createFile(atPath: destination.path, contents: nil)
        let writer = try FileHandle(forWritingTo: destination)
        defer { try? writer.close() }

        let ioChunk: Int64 = 1 * 1024 * 1024   // 1 MiB read granularity
        var remaining = range.length
        while remaining > 0 {
            let want = Int(min(ioChunk, remaining))
            let data = try reader.read(upToCount: want) ?? Data()
            if data.isEmpty { break }   // source shorter than declared
            try writer.write(contentsOf: data)
            remaining -= Int64(data.count)
        }
        if remaining != 0 {
            throw MultipartError.shortRead(expected: range.length, got: range.length - remaining)
        }
    }
}

// MARK: - Resume ledger

/// One uploaded part's completion record — the pair the complete call needs.
struct MultipartUploadedPart: Codable, Equatable {
    let partNumber: Int   // 1-based
    let eTag: String      // stored VERBATIM, quotes included — S3 compares it exactly
}

/// The durable, resumable record of one multipart upload. Persisted as JSON so a
/// relaunch/retry can skip already-uploaded parts and so a sweep can abort stale
/// uploads. Keyed on disk by uploadId.
struct MultipartResumeLedger: Codable, Equatable {
    let uploadId: String
    let key: String
    let publicUrl: String
    let fileSize: Int64
    let partSize: Int64
    let partCount: Int
    /// When this upload was initialised. Drives expiry — an abandoned multipart
    /// keeps billing until aborted, so a stale ledger is swept and aborted.
    let createdAt: Date
    /// partNumber -> ETag (verbatim, quotes included) for every part S3 has
    /// confirmed. Written on each part completion so a crash loses at most the
    /// single in-flight part.
    private(set) var completed: [Int: String]

    init(uploadId: String, key: String, publicUrl: String,
         fileSize: Int64, partSize: Int64, createdAt: Date = Date()) {
        self.uploadId = uploadId
        self.key = key
        self.publicUrl = publicUrl
        self.fileSize = fileSize
        self.partSize = partSize
        self.partCount = MultipartChunker.partCount(fileSize: fileSize, partSize: partSize)
        self.createdAt = createdAt
        self.completed = [:]
    }

    /// Mark a part uploaded. The ETag is stored EXACTLY as S3 returned it (a quoted
    /// string) — do not strip quotes; complete compares it verbatim. Idempotent: a
    /// retried part just overwrites its ETag (last write wins), never double-counts.
    mutating func record(partNumber: Int, eTag: String) {
        completed[partNumber] = eTag
    }

    /// The 1-based part numbers still needing upload, ascending. A resume iterates
    /// this — completed parts are skipped, so a dropped upload continues from where
    /// it stopped instead of restarting from byte 0.
    func remainingPartNumbers() -> [Int] {
        guard partCount > 0 else { return [] }
        return (1...partCount).filter { completed[$0] == nil }
    }

    /// Every part confirmed by S3?
    var isComplete: Bool {
        partCount > 0 && completed.count == partCount
    }

    /// The completed parts in the ascending PartNumber order the complete call
    /// requires, ETags verbatim. Non-nil only when every part is present.
    func orderedParts() -> [MultipartUploadedPart]? {
        guard isComplete else { return nil }
        return (1...partCount).map { MultipartUploadedPart(partNumber: $0, eTag: completed[$0] ?? "") }
    }

    /// This upload has outlived `ttl` and should be aborted + cleared. The part
    /// URLs presign for 3600s [Contract 2], so a ttl at/under that bounds the
    /// window in which resume is even possible; past it the parts are dead weight
    /// that keep billing until aborted.
    func isExpired(ttl: TimeInterval, now: Date) -> Bool {
        now.timeIntervalSince(createdAt) > ttl
    }
}

extension MultipartResumeLedger {
    /// Where a ledger lives. The directory is injected so tests use a temp dir and
    /// the app passes Application Support — this type never reaches for a global
    /// path, which is what keeps it pure and testable.
    static func fileURL(uploadId: String, in dir: URL) -> URL {
        dir.appendingPathComponent("multipart-\(uploadId).json")
    }

    /// Persist atomically. Creates `dir` if needed.
    func save(in dir: URL) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(self)
        try data.write(to: Self.fileURL(uploadId: uploadId, in: dir), options: .atomic)
    }

    /// Load a ledger for `uploadId`, or nil if none is on disk (a fresh upload) or
    /// the file is unreadable/corrupt (treat as fresh — restart is safe).
    static func load(uploadId: String, in dir: URL) -> MultipartResumeLedger? {
        guard let data = try? Data(contentsOf: fileURL(uploadId: uploadId, in: dir)) else { return nil }
        return try? JSONDecoder().decode(MultipartResumeLedger.self, from: data)
    }

    /// Remove the ledger once the upload has completed or been aborted, so a future
    /// upload never resumes a stale record.
    static func clear(uploadId: String, in dir: URL) {
        try? FileManager.default.removeItem(at: fileURL(uploadId: uploadId, in: dir))
    }

    /// Every persisted ledger in `dir` (unreadable/corrupt files are skipped). The
    /// abort sweep reads this, filters by `isExpired`, aborts each expired upload's
    /// S3 multipart (via /api/upload-multipart-abort with its key + uploadId), then
    /// clears it. Ledgers for a live upload are left untouched.
    static func all(in dir: URL) -> [MultipartResumeLedger] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return [] }
        return names
            .filter { $0.hasPrefix("multipart-") && $0.hasSuffix(".json") }
            .compactMap { name -> MultipartResumeLedger? in
                guard let data = try? Data(contentsOf: dir.appendingPathComponent(name)) else { return nil }
                return try? JSONDecoder().decode(MultipartResumeLedger.self, from: data)
            }
    }

    /// The uploads in `dir` that have outlived `ttl` as of `now` — the abort-sweep
    /// worklist. Each returns the (key, uploadId) pair the abort call needs.
    static func expired(in dir: URL, ttl: TimeInterval, now: Date) -> [(key: String, uploadId: String)] {
        all(in: dir)
            .filter { $0.isExpired(ttl: ttl, now: now) }
            .map { (key: $0.key, uploadId: $0.uploadId) }
    }
}
