# 16 — Can a free Personal Team use an App Group? (proposal 006, Phase 2 gate)

Dated record, 2026-10-05. Kept as written; a later run of the probe gets its own dated section
appended under "Runs" rather than edits above it.

**Question.** Can the owner's free Apple Personal Team sign and run an iOS app plus an app
extension that share data through an App Group? Proposal 006 Phase 2 (Share Extension, widgets)
depends on the answer; without a group, an extension cannot hand captures to the app offline.

**Answer so far: not settled on the device.** The probe is built and ready, but the first signed
build stopped before reaching Apple: **Xcode on this Mac has no Apple account signed in**, so
neither `xcodebuild -allowProvisioningUpdates` nor the Xcode GUI can register App IDs or create
profiles. Apple's own documentation says the free tier does **not** get App Groups; third-party
sideloading tools that sign through the same free-account developer services say it does. Only
the probe can decide between those, and it needs the owner to sign in to Xcode first (steps below).

## 1. What Apple and others say

| Source | Claim |
|---|---|
| Apple, *Supported capabilities (iOS)*, <https://developer.apple.com/help/account/reference/supported-capabilities-ios> (fetched 2026-10-05) | Table columns ADP / ADEP / Apple Developer: **"App groups ✓ ✓ ✗"**, i.e. not available without a paid membership. Keychain sharing, Associated domains, Siri, Push are ✓ for the free tier. |
| Apple, *Developer account overview*, <https://developer.apple.com/support/compare-memberships/> (fetched 2026-10-05) | Personal Team: "You can register up to 10 App IDs, which expire after 7 days. You can register up to 3 devices, which expire after 7 days. You can install up to 3 apps per device. Provisioning profiles … will expire 7 days from issuance." |
| Apple Developer Forums, <https://developer.apple.com/forums/thread/738054> (Sept 2023) | "Can I utilize App Groups without having the Apple Developer Program?" — unanswered. |
| altsign-cli README, <https://github.com/xhzq233/altsign-cli> (fetched 2026-10-05) | A re-signer built on AltSign "for a free Apple Developer account"; its capability table marks `app-groups` **Yes** for free accounts. |
| AltStore / SideStore | Installed with free Apple IDs and themselves use an App Group (`group.com.rileytestut.AltStore`, per SideStore's build instructions surfaced in search) shared with their extensions. Secondary evidence only; not checked against a running install here. |

So the first-party page and practice disagree. A plausible reconciliation (unverified): the
web portal's capability table describes what the *portal* offers, while Xcode/AltSign talk to the
developer services API that free teams use, which may still assign groups. That is exactly what
the probe tests.

The 10-App-ID figure in proposal 006 is now sourced (Apple's page above). Note Apple also caps a
free account at **3 apps per device**, which proposal 006 did not mention: the probe app plus
nooklet are 2 of those 3 (assuming an embedded extension does not count as a separate app;
unverified).

## 2. The probe

`tools/probes/app-group-probe/`: a hand-written Xcode project (XcodeGen is not installed; the
project uses Xcode 16+ synchronized folders, so it is ~300 lines). Two targets, both with
`com.apple.security.application-groups = [group.sh.nooklet.probe]`:

- **AppGroupProbe** (`sh.nooklet.probe.appgroup`), SwiftUI. On launch and on every return to the
  foreground it calls `FileManager.containerURL(forSecurityApplicationGroupIdentifier:)`, writes
  `app-<timestamp>.txt` into the container, and prints (stdout, `NSLog`, and on screen) whether the
  URL was non-nil, every `.txt` file in the container, and how many came from the extension.
- **AppGroupProbeShare** (`sh.nooklet.probe.appgroup.share`), a Share Extension for text and one
  web URL, shown as "App Group Probe" in share sheets. When invoked it writes
  `share-<timestamp>.txt` into the same container, shows the result for 2 s and closes.

`run.sh build|install|files|remove` wraps the commands. The team id is read from a gitignored
`signing.local.xcconfig` next to `run.sh` (or `apps/web/ios/signing.local.xcconfig`), never from a
tracked file. `run.sh files` reads the group container directly with
`xcrun devicectl device info files --domain-type appGroupDataContainer`, so the extension's write
can be checked from the Mac without opening the app.

An unsigned build (`CODE_SIGNING_ALLOWED=NO`, generic iOS) succeeds and embeds the extension at
`AppGroupProbe.app/PlugIns/AppGroupProbeShare.appex` with the expected `NSExtension` dictionary,
so the project itself is sound.

## 3. Runs

### 2026-10-05, Xcode 27.0 (27A266a), macOS 27 — blocked: no account in Xcode

`run.sh build` (`xcodebuild … -destination 'generic/platform=iOS' -allowProvisioningUpdates
DEVELOPMENT_TEAM=<team>`), both inside and outside the agent sandbox:

```
AppGroupProbe.xcodeproj: error: No Accounts: Add a new account in Accounts settings. (in target 'AppGroupProbeShare' from project 'AppGroupProbe')
AppGroupProbe.xcodeproj: error: No profiles for 'sh.nooklet.probe.appgroup.share' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'sh.nooklet.probe.appgroup.share'. (in target 'AppGroupProbeShare' from project 'AppGroupProbe')
AppGroupProbe.xcodeproj: error: No Accounts: Add a new account in Accounts settings. (in target 'AppGroupProbe' from project 'AppGroupProbe')
AppGroupProbe.xcodeproj: error: No profiles for 'sh.nooklet.probe.appgroup' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'sh.nooklet.probe.appgroup'.
** BUILD FAILED **
```

The same project built from the Xcode GUI (opened with `open -a Xcode`, built through Xcode's
AppleScript `build` on "Any iOS Device") failed with the identical four errors, so this is not a
command-line or sandbox restriction. Evidence that no account is signed in: `defaults read
com.apple.dt.Xcode DVTDeveloperAccountManagerAppleIDLists` is `{ "IDE.Identifiers.Prod" = (); }`
(empty), while `IDEProvisioningTeamByIdentifier` still caches the Personal Team from an earlier
sign-in.

Why the main app still builds: `xcodebuild` for `apps/web/ios/App` succeeds right now because the
`sh.nooklet.app` profile is already on disk (created 2026-10-04, expires 2026-10-11) and needs no
account. A **new** bundle id needs Apple, hence the probe fails. Consequence beyond this probe:
on 2026-10-11 the main app's profile expires, and renewing it (`docs/guide/ios-from-source.md`,
"Without opening Xcode") needs the account too. Logged as B-920.

**Cost of this run on the free account: nothing.** Signing stopped before any request to Apple:
no App ID registered, no profile created (still exactly one profile on disk, the main app's),
nothing installed on the phone.

## 4. How to finish it

Owner, once, on the Mac: **Xcode → Settings → Accounts → + → Apple Account**, sign in with the
Apple ID the Personal Team belongs to. Then (agent or owner):

```sh
tools/probes/app-group-probe/run.sh build
DEVICE=<phone UDID> tools/probes/app-group-probe/run.sh install   # installs, launches with --console
```

Read the build output first; it is the main result:

- **Signing fails** with an App Groups / capability error (e.g. "Personal development teams … do
  not support the App Groups capability"): the answer is *no*. Record the exact text here.
- **Signing succeeds**: check the profiles carry the group (`security cms -D -i <profile> | grep
  -A3 application-groups`). Then the console line `PROBE containerURL=non-nil` settles the app side.

First launch may show **Untrusted Developer**: Settings → General → VPN & Device Management →
the Apple ID under *Developer App* → Trust. (Already trusted for nooklet, so probably not.)

Extension side, owner on the phone: open **Safari**, any page → **Share** (square with arrow) →
scroll the app row to the end → **More** → enable **App Group Probe** if it is listed but off →
tap **App Group Probe**. A sheet shows "wrote share-….txt into the shared container" (or
"containerURL = nil") and closes after 2 s. Then from the Mac:

```sh
DEVICE=<phone UDID> tools/probes/app-group-probe/run.sh files    # expect share-*.txt next to app-*.txt
```

or open App Group Probe on the phone: it lists the file and "files from the share extension: 1".
No interaction-free way to start a share extension was found; a widget would need the owner to
place it on the Home Screen, which is no less interactive, so the probe does not ship one.

**Cost when it runs:** 2 App IDs of the 10 per 7 days (app + extension; an App Group is a
separate identifier, not an App ID — unverified for the free tier), 2 profiles, 1 of 3 app slots
on the phone. The App IDs expire on their own after 7 days.

**Remove afterwards:** `DEVICE=<udid> tools/probes/app-group-probe/run.sh remove`, or long-press
"App Group Probe" on the phone → Remove App → Delete App. Removing the app removes the extension;
the group container goes when no installed app uses the group.

## 5. Still unverified

- **The question itself**: whether Xcode's automatic provisioning grants `group.sh.nooklet.probe`
  to a Personal Team, and whether an extension signed that way sees the container. Blocked on the
  Xcode sign-in above.
- Whether, if Xcode refuses, the group could be registered some other way (AltSign-style direct
  calls to the developer services API). Not worth pursuing for nooklet: a build the owner cannot
  reproduce from Xcode is not a build we can ship instructions for.
- Whether an App Group counts against the 10-App-ID limit on a free team.
- Why the Xcode account disappeared between 2026-10-04 (when the main app's profile was created)
  and 2026-10-05: signed out by hand, an expired session, or the Xcode 27 update. Not investigated.
