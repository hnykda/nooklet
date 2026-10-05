// Proposal 006 Phase 2 gate: can a free Personal Team give an app and its extension one App Group
// container? On every launch this app resolves the group container, writes a marker file into it,
// and prints what is there, including anything the Share Extension wrote earlier.
import SwiftUI

let appGroup = "group.sh.nooklet.probe"

enum Probe {
	static func run() -> String {
		var lines: [String] = []
		func say(_ s: String) {
			lines.append(s)
			// stdout reaches `devicectl device process launch --console`; NSLog reaches the
			// device log in case the console is not attached.
			print("PROBE \(s)")
			NSLog("PROBE %@", s)
		}
		guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
			say("containerURL=nil (App Group not granted to the app)")
			return lines.joined(separator: "\n")
		}
		say("containerURL=non-nil path=\(dir.lastPathComponent)")
		let stamp = ISO8601DateFormatter().string(from: Date())
		let marker = dir.appendingPathComponent("app-\(stamp).txt")
		do {
			try "written by the app at \(stamp)\n".write(to: marker, atomically: true, encoding: .utf8)
			say("app write ok: \(marker.lastPathComponent)")
		} catch {
			say("app write FAILED: \(error)")
		}
		let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
		for name in names.sorted() where name.hasSuffix(".txt") {
			let body = (try? String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)) ?? "?"
			say("file \(name): \(body.trimmingCharacters(in: .whitespacesAndNewlines))")
		}
		let fromShare = names.filter { $0.hasPrefix("share-") }.count
		say("files from the share extension: \(fromShare)")
		return lines.joined(separator: "\n")
	}
}

@main
struct ProbeApp: App {
	@State private var report = Probe.run()
	@Environment(\.scenePhase) private var phase

	var body: some Scene {
		WindowGroup {
			ScrollView {
				Text(report).font(.system(.footnote, design: .monospaced)).padding()
			}
			.onChange(of: phase) { _, now in
				if now == .active { report = Probe.run() }
			}
		}
	}
}
