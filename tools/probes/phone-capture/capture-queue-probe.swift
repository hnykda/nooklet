// Exercises the App Intent's queue writer (`apps/web/ios/App/App/CaptureQueue.swift`) on macOS,
// outside the app, against a temporary directory: the "unit-testable Swift function" half of
// ADR 033's verification. The app target has no XCTest target; this keeps the claim re-runnable.
//
// Run from the repo root:
//   swiftc -parse-as-library -o /tmp/capture-queue-probe apps/web/ios/App/App/CaptureQueue.swift \
//     tools/probes/phone-capture/capture-queue-probe.swift && /tmp/capture-queue-probe
// Prints one line per check and exits non-zero on the first failure. Last run 2026-10-04: all
// pass (output in docs/progress/phone-capture.md).
import Foundation

@main
enum CaptureQueueProbe {
    static func main() throws {
        var failures = 0
        func check(_ ok: Bool, _ what: String) {
            print("\(ok ? "PASS" : "FAIL")  \(what)")
            if !ok { failures += 1 }
        }

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("capture-queue-probe-\(UUID().uuidString)", isDirectory: true)
        let q = CaptureQueue(directory: dir)

        check((try? q.list()) == [], "an absent folder lists as empty")

        let t0 = Date(timeIntervalSince1970: 1_791_100_000.123)
        let idA = UUID(uuidString: "BBBBBBBB-1111-4111-8111-111111111111")!
        let idB = UUID(uuidString: "AAAAAAAA-2222-4222-8222-222222222222")!
        let a = try q.enqueue(text: "Plánování zahradních úprav\nřádek dva", now: t0, id: idA)
        let b = try q.enqueue(text: nil, url: "https://example.com/a", title: "An article",
                              now: t0.addingTimeInterval(1), id: idB)
        check(a == "bbbbbbbb-1111-4111-8111-111111111111", "ids are lower-case uuids")
        check((try? q.list()) == [b, a], "list returns both, sorted by name (the web side orders by created_at)")

        let jsonA = try q.read(a)
        let objA = try JSONSerialization.jsonObject(with: Data(jsonA.utf8)) as? [String: String]
        check(objA?["text"] == "Plánování zahradních úprav\nřádek dva", "text round-trips with diacritics and a newline")
        check(objA?["created_at"] == "2026-10-04T07:46:40.123Z", "created_at is ISO 8601 UTC with milliseconds: \(objA?["created_at"] ?? "nil")")
        check(objA?["url"] == nil && objA?["title"] == nil, "absent fields are omitted, not null")
        print("      sample file: \(jsonA)")

        let objB = try JSONSerialization.jsonObject(with: Data(try q.read(b).utf8)) as? [String: String]
        check(objB?["url"] == "https://example.com/a" && objB?["title"] == "An article" && objB?["text"] == nil,
              "a link capture keeps url and title")

        do {
            try q.enqueue(text: "   \n ")
            check(false, "blank text is refused")
        } catch CaptureQueue.QueueError.empty {
            check(true, "blank text is refused")
        }

        for bad in ["../secrets", "BBBBBBBB-1111-4111-8111-111111111111", "x.json", ""] {
            do {
                _ = try q.read(bad)
                check(false, "id \(bad.debugDescription) is refused")
            } catch CaptureQueue.QueueError.badId {
                check(true, "id \(bad.debugDescription) is refused before it becomes a path")
            } catch {
                check(false, "id \(bad.debugDescription): unexpected \(error)")
            }
        }

        try "stray".write(to: dir.appendingPathComponent("notes.txt"), atomically: true, encoding: .utf8)
        try "{}".write(to: dir.appendingPathComponent("not-a-uuid.json"), atomically: true, encoding: .utf8)
        check((try? q.list()) == [b, a], "stray files in the folder are not listed")

        try q.remove(a)
        try q.remove(a)
        check((try? q.list()) == [b], "remove deletes, and removing again is not an error (two drains racing)")

        try? FileManager.default.removeItem(at: dir)
        print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
        exit(failures == 0 ? 0 : 1)
    }
}
