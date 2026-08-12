import Foundation

// Item 7b — resumable multipart upload on a BACKGROUND URLSession.
//
// This file holds the two CONTRACT-FREE, device-independent pieces of 7b:
//
//   1. MultipartChunker — turns a file into an ordered list of byte-range parts
//      and materializes any single part to its own temp FILE. A background
//      URLSession can only upload `fromFile:` (not in-memory Data, not a
//      byte-range view of a shared handle), so every part must exist as a
//      standalone file on disk. That is the delta over the dead FOREGROUND
//      multipart path (APIService.uploadFileToS3Multipart), which streams byte
//      ranges from the one source file over a foreground session and therefore
//      dies on suspension.
//
//   2. MultipartResumeLedger — the durable, on-disk record of {uploadId, key,
//      which parts already have an ETag}. It lets a relaunch/retry SKIP the
//      parts S3 already has instead of restarting the whole object from byte 0
//      — the exact stall the honest remedy copy describes ("the connection was
//      likely too slow for this clip").
//
// What is deliberately NOT here, and why:
//   • The /api/upload-multipart-init | -complete | -abort network calls — that
//     is the SERVER CONTRACT. Wire it the moment it publishes; the wire shapes
//     already exist as APIService.Multipart{Init,Complete}Response /
//     MultipartPart, and this ledger maps straight onto them.
//   • The background-URLSession orchestration and the suspend/relaunch resume
//     loop — that is DEVICE-VALIDATION-GATED. It can only be proven on a real
//     device over a real dropping network, which is the entire reason 7b moved
//     out of 225.
//
// Keeping both of those out means this file is pure Foundation and is fully
// unit-tested by Tests/ResumableUploadTests.swift with zero device and zero
// server. It is intentionally NOT yet in the app target — nothing references it,
// so it cannot affect the 226 binary. The commit that wires it (when the
// contract lands) adds it to the target alongside the background orchestration.

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
    /// than `expected` for a part. Surfaced rather than silently uploading a
    /// truncated part (which S3 would accept and the render would then choke on).
    case shortRead(expected: Int64, got: Int64)
}

enum MultipartChunker {
    /// Split a file of `fileSize` bytes into parts of at most `partSize` bytes,
    /// the final part carrying the remainder. Returns [] for a non-positive file
    /// (nothing to upload). A non-positive `partSize` is clamped to the whole
    /// file (one part) rather than dividing by zero.
    static func partPlan(fileSize: Int64, partSize: Int64) -> [MultipartPartRange] {
        guard fileSize > 0 else { return [] }
        let effective = partSize > 0 ? partSize : fileSize
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

    /// Materialize ONE part to its own file at `destination`, copying exactly
    /// `range.length` bytes from `range.offset` of `source`. Reads in bounded
    /// chunks so a 16MB part never loads more than `ioChunk` into memory at
    /// once. Overwrites `destination` if it exists. Throws `.shortRead` if the
    /// source runs out before `range.length` bytes are copied.
    static func writePart(from source: URL, range: MultipartPartRange, to destination: URL) throws {
        let reader = try FileHandle(forReadingFrom: source)
        defer { try? reader.close() }
        try reader.seek(toOffset: UInt64(range.offset))

        FileManager.default.createFile(atPath: destination.path, contents: nil)
        let writer = try FileHandle(forWritingTo: destination)
        defer { try? writer.close() }

        let ioChunk: Int64 = 1 * 1024 * 1024   // 1MB read granularity
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
    let eTag: String
}

/// The durable, resumable record of one multipart upload. Persisted as JSON so
/// a relaunch/retry can skip already-uploaded parts. Keyed on disk by uploadId.
struct MultipartResumeLedger: Codable, Equatable {
    let uploadId: String
    let key: String
    let publicUrl: String
    let fileSize: Int64
    let partSize: Int64
    let partCount: Int
    /// partNumber -> ETag for every part S3 has confirmed. Written on each part
    /// completion so a crash loses at most the single in-flight part.
    private(set) var completed: [Int: String]

    init(uploadId: String, key: String, publicUrl: String, fileSize: Int64, partSize: Int64) {
        self.uploadId = uploadId
        self.key = key
        self.publicUrl = publicUrl
        self.fileSize = fileSize
        self.partSize = partSize
        self.partCount = MultipartChunker.partCount(fileSize: fileSize, partSize: partSize)
        self.completed = [:]
    }

    /// Mark a part uploaded. Idempotent: re-recording a retried part just
    /// overwrites its ETag (last write wins), so a re-upload never double-counts.
    mutating func record(partNumber: Int, eTag: String) {
        completed[partNumber] = eTag
    }

    /// The 1-based part numbers still needing upload, ascending. This is what a
    /// resume iterates — completed parts are skipped, so a dropped upload
    /// continues from where it stopped instead of restarting from byte 0.
    func remainingPartNumbers() -> [Int] {
        guard partCount > 0 else { return [] }
        return (1...partCount).filter { completed[$0] == nil }
    }

    /// Every part confirmed by S3?
    var isComplete: Bool {
        partCount > 0 && completed.count == partCount
    }

    /// The completed parts in the ascending PartNumber order the complete call
    /// requires. Non-nil only when every part is present.
    func orderedParts() -> [MultipartUploadedPart]? {
        guard isComplete else { return nil }
        return (1...partCount).map { MultipartUploadedPart(partNumber: $0, eTag: completed[$0] ?? "") }
    }
}

extension MultipartResumeLedger {
    /// Where a ledger lives. The directory is injected so tests use a temp dir
    /// and the app passes Application Support — this type never reaches for a
    /// global path, which is what keeps it pure and testable.
    static func fileURL(uploadId: String, in dir: URL) -> URL {
        dir.appendingPathComponent("multipart-\(uploadId).json")
    }

    /// Persist atomically. Creates `dir` if needed.
    func save(in dir: URL) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(self)
        try data.write(to: Self.fileURL(uploadId: uploadId, in: dir), options: .atomic)
    }

    /// Load a ledger for `uploadId`, or nil if none is on disk (a fresh upload)
    /// or the file is unreadable/corrupt (treat as fresh — restart is safe).
    static func load(uploadId: String, in dir: URL) -> MultipartResumeLedger? {
        guard let data = try? Data(contentsOf: fileURL(uploadId: uploadId, in: dir)) else { return nil }
        return try? JSONDecoder().decode(MultipartResumeLedger.self, from: data)
    }

    /// Remove the ledger once the upload has completed (or been abandoned) so a
    /// future upload with a recycled id never resumes a stale record.
    static func clear(uploadId: String, in dir: URL) {
        try? FileManager.default.removeItem(at: fileURL(uploadId: uploadId, in: dir))
    }
}
