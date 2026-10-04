import AppIntents
import Foundation

/// "Add to nooklet" (proposal 006 Phase 1, ADR 033): text from Shortcuts, Siri, Spotlight or the
/// Action Button lands as a block at the end of today's journal, WITHOUT opening the app.
///
/// It runs in the app's process but not in the web view, so it cannot reach the replica. It writes
/// the capture to the native queue (`CaptureQueue`) and returns; the web app turns the file into a
/// block the next time it launches or comes to the foreground. In the app target on purpose, not
/// an App Intents extension: the free Apple account limits App IDs, and an extension would also
/// need an App Group to share the queue (unverified on a Personal Team; proposal 006).
@available(iOS 16.0, *)
struct AddToNookletIntent: AppIntent {
    static let title: LocalizedStringResource = "Add to nooklet"
    static let description = IntentDescription(
        "Adds text to today's journal in nooklet without opening the app. It appears in the journal the next time nooklet opens.")
    static let openAppWhenRun = false

    @Parameter(title: "Text", inputOptions: String.IntentInputOptions(multiline: true),
               requestValueDialog: "What do you want to add?")
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$text) to nooklet")
    }

    /// The whole job, outside `perform()` so the DEBUG launch argument in `AppDelegate` runs the
    /// exact code the intent runs.
    static func enqueue(_ text: String) throws {
        try CaptureQueue.appDefault().enqueue(text: text)
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            try Self.enqueue(text)
        } catch CaptureQueue.QueueError.empty {
            return .result(dialog: "Nothing to add.")
        }
        return .result(dialog: "Added to nooklet.")
    }
}

/// The "open the app first" variant: shows the capture screen pre-filled, so the text can be
/// edited before it is saved. Nothing is written until the person taps Save.
@available(iOS 16.0, *)
struct OpenNookletToAddIntent: AppIntent {
    static let title: LocalizedStringResource = "Open nooklet to add"
    static let description = IntentDescription(
        "Opens nooklet's capture screen, pre-filled with the text, to edit and save.")
    static let openAppWhenRun = true

    @Parameter(title: "Text", inputOptions: String.IntentInputOptions(multiline: true))
    var text: String?

    @MainActor
    func perform() async throws -> some IntentResult {
        AppLinkForwarder.open(AppLinkForwarder.captureURL(text: text))
        return .result()
    }
}

/// Makes both intents appear in Shortcuts and Spotlight, and answer to Siri, with no setup. Each
/// phrase must name the app; a free-text parameter cannot be spoken inline, so Siri asks for it.
@available(iOS 16.0, *)
struct NookletShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddToNookletIntent(),
            phrases: [
                "Add to \(.applicationName)",
                "Add a note to \(.applicationName)",
                "Capture in \(.applicationName)",
            ],
            shortTitle: "Add to nooklet",
            systemImageName: "square.and.pencil")
        AppShortcut(
            intent: OpenNookletToAddIntent(),
            phrases: ["Open \(.applicationName) to add"],
            shortTitle: "Open nooklet to add",
            systemImageName: "note.text.badge.plus")
    }
}
