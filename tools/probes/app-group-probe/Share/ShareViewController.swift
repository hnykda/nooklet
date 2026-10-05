// The extension side of the App Group probe: when invoked from any share sheet it writes one file
// into the shared container and closes. The app (or `devicectl device info files`) reads it back.
import UIKit

final class ShareViewController: UIViewController {
	override func viewDidLoad() {
		super.viewDidLoad()
		view.backgroundColor = .systemBackground
		let label = UILabel()
		label.numberOfLines = 0
		label.textAlignment = .center
		label.text = "App Group Probe\n" + writeMarker()
		label.translatesAutoresizingMaskIntoConstraints = false
		view.addSubview(label)
		NSLayoutConstraint.activate([
			label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
			label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
			label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 16),
		])
		// Leave the result on screen long enough to read, then dismiss the sheet.
		DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
			self?.extensionContext?.completeRequest(returningItems: nil)
		}
	}

	private func writeMarker() -> String {
		guard
			let dir = FileManager.default.containerURL(
				forSecurityApplicationGroupIdentifier: "group.sh.nooklet.probe")
		else {
			NSLog("PROBE share: containerURL=nil")
			return "containerURL = nil\n(the extension cannot see the group)"
		}
		let stamp = ISO8601DateFormatter().string(from: Date())
		let types = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
			.flatMap { $0.attachments ?? [] }
			.flatMap { $0.registeredTypeIdentifiers }
		do {
			try "written by the share extension at \(stamp); shared types: \(types)\n"
				.write(to: dir.appendingPathComponent("share-\(stamp).txt"), atomically: true, encoding: .utf8)
			NSLog("PROBE share: write ok")
			return "wrote share-\(stamp).txt\ninto the shared container"
		} catch {
			NSLog("PROBE share: write FAILED %@", "\(error)")
			return "write FAILED: \(error)"
		}
	}
}
