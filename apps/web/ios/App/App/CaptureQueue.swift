import Foundation

/// ADR 033: the native capture queue. The "Add to nooklet" App Intent runs without the web view
/// (and so without the SQLite replica), so it cannot write a block itself. It leaves one JSON file
/// per capture here instead, and the web app drains the folder through its ordinary quick-capture
/// write on launch and on every resume (`apps/web/src/capture/capture-queue.ts`), deleting a file
/// only after its block committed.
///
/// Plain Foundation and nothing else, so it can be compiled and exercised on its own outside the
/// app (`tools/probes/phone-capture/capture-queue-probe.swift`).
///
/// File format, one capture per `<uuid>.json` (lower-case uuid):
///     {"text": "…", "url": "…", "title": "…", "created_at": "2026-10-04T08:15:30.123Z"}
/// `text`, `url` and `title` are each optional; `created_at` is ISO 8601 UTC with milliseconds.
struct CaptureQueue {
    let directory: URL

    /// `Application Support/captures/` in the app's own container. Not an App Group: the intent
    /// runs in the app's process, so nothing outside the app needs to see these files.
    static func appDefault() throws -> CaptureQueue {
        let support = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return CaptureQueue(directory: support.appendingPathComponent("captures", isDirectory: true))
    }

    enum QueueError: Error, Equatable {
        case badId(String)
        case empty
    }

    /// Ids are the uuids this type writes and nothing else. The web layer names files through the
    /// plugin, so an id is checked before it becomes a path: no `../`, no other file.
    static func isValidId(_ id: String) -> Bool {
        guard id.count == 36, let parsed = UUID(uuidString: id) else { return false }
        return parsed.uuidString.lowercased() == id
    }

    private func fileURL(_ id: String) throws -> URL {
        guard Self.isValidId(id) else { throw QueueError.badId(id) }
        return directory.appendingPathComponent("\(id).json", isDirectory: false)
    }

    private static func timestamp(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: date)
    }

    /// Writes one capture and returns its id. Throws `.empty` when there is nothing to keep.
    ///
    /// `.atomic` writes a temporary file and renames it into place, so the drain never sees half a
    /// file. The protection class is the iOS default for app files, spelled out because the Action
    /// Button can run the intent on a locked phone: it lets a write succeed while locked, after the
    /// first unlock since boot.
    @discardableResult
    func enqueue(text: String?, url: String? = nil, title: String? = nil,
                 now: Date = Date(), id: UUID = UUID()) throws -> String {
        func nonEmpty(_ s: String?) -> String? {
            guard let s, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return s
        }
        var body: [String: String] = ["created_at": Self.timestamp(now)]
        if let v = nonEmpty(text) { body["text"] = v }
        if let v = nonEmpty(url) { body["url"] = v }
        if let v = nonEmpty(title) { body["title"] = v }
        guard body.count > 1 else { throw QueueError.empty }

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let key = id.uuidString.lowercased()
        let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        #if os(iOS)
        try data.write(to: try fileURL(key),
                       options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: try fileURL(key), options: [.atomic])
        #endif
        return key
    }

    /// Ids of every queued capture. Anything in the folder that is not `<uuid>.json` (a temporary
    /// file mid-rename, a stray) is ignored.
    func list() throws -> [String] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .compactMap { name -> String? in
                guard name.hasSuffix(".json") else { return nil }
                let id = String(name.dropLast(5))
                return Self.isValidId(id) ? id : nil
            }
            .sorted()
    }

    func read(_ id: String) throws -> String {
        let data = try Data(contentsOf: try fileURL(id))
        return String(decoding: data, as: UTF8.self)
    }

    /// Deleting a file that is already gone succeeds: two drains may race to the same delete.
    func remove(_ id: String) throws {
        let url = try fileURL(id)
        do {
            try FileManager.default.removeItem(at: url)
        } catch CocoaError.fileNoSuchFile {
            return
        }
    }
}
