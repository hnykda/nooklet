---
title: Build and install nooklet on your iPhone
description: Build nooklet with Xcode and install it on your own iPhone with a free Apple ID, connect it to your server, and debug it with Safari's Web Inspector.
order: 7
---

# Build and install nooklet on your iPhone

nooklet has no App Store build. You build the app with Xcode on a Mac and install it on your own
phone. A free Apple ID is enough. Plan on 30 to 60 minutes the first time, most of it Xcode
downloading things and the phone restarting once.

The order of the steps matters. Connect and trust the phone **before** you set up signing: a free
account can only sign for a phone Xcode has already seen, and the phone's Developer Mode switch
appears only after that.

## What you need

- A Mac with [Xcode](https://apps.apple.com/app/xcode/id497799835) from the App Store (the full
  app; the Command Line Tools alone cannot build for a phone). Open it once and let it install its
  components. Last checked with Xcode 27.0.
- An Apple ID. A free one works, with limits described [below](#the-7-day-limit).
- An iPhone on iOS 15 or later, and a cable that carries data.
- Node 24 or newer, pnpm 12 and git. See [Building from source](building.md#prerequisites).
- Somewhere to sync with, or nothing: the app also runs as a local-only graph on the phone.

## 1. Build the web client into the Xcode project

```sh
git clone https://github.com/hnykda/nooklet.git
cd nooklet
pnpm install --frozen-lockfile
pnpm ios:sync     # builds the client, copies it into apps/web/ios/App/App/public
pnpm ios:open     # opens apps/web/ios/App/App.xcodeproj in Xcode
```

The app is a native shell (Capacitor) around the same client the browser runs. `ios:sync` builds
that client and copies it into the Xcode project; Xcode packages whatever it finds there. The first
time you open the project, Xcode fetches the Swift packages the plugins need from GitHub. Wait
until the "Resolving packages" progress in the toolbar finishes.

## 2. Connect the phone first

1. Plug the iPhone into the Mac and unlock it.
2. The phone asks **Trust This Computer?** Tap **Trust** and enter the phone's passcode.
3. In Xcode's toolbar, open the run destination menu (next to the **App** scheme at the top) and
   pick your iPhone under *iOS Device*.
4. If Xcode shows "Preparing iPhone" or "Copying shared cache", wait for it to finish. It can take
   several minutes the first time.

If the phone is missing from the list, unlock it, check the cable, and look in
**Window → Devices and Simulators**, which shows why Xcode cannot use a connected device.

## 3. Turn on Developer Mode on the phone

1. On the iPhone, open **Settings → Privacy & Security** and scroll to the bottom.
2. Tap **Developer Mode** and switch it on. If the entry is not there, Xcode has not seen the phone
   yet: go back to step 2.
3. The phone asks to restart. Tap **Restart**.
4. After the restart, unlock the phone. It asks whether to turn on Developer Mode; tap
   **Turn On** and enter your passcode.

## 4. Set up signing

1. In Xcode, open **Xcode → Settings → Accounts**, click **+**, choose **Apple Account** and sign in.
2. In the project navigator on the left, click the blue **App** project at the top. Under
   *TARGETS*, select **App**, then open the **Signing & Capabilities** tab.
3. Tick **Automatically manage signing**.
4. Set your signing team. The checked-out project names no team; it reads one from
   `apps/web/ios/signing.local.xcconfig`, a gitignored file you create once:

   ```sh
   echo 'DEVELOPMENT_TEAM = <your 10-character team id>' > apps/web/ios/signing.local.xcconfig
   ```

   Find your team id in Xcode → Settings → Accounts → your account → the team's details, or pick
   **Team** in the Signing & Capabilities tab once (a free account appears as *Your Name
   (Personal Team)*) and copy the id Xcode writes into `project.pbxproj` into that file, then
   `git checkout apps/web/ios/App/App.xcodeproj/project.pbxproj`. The repo's leak check refuses a
   commit that puts a team id in the project file.
5. Change **Bundle Identifier** from `sh.nooklet.app` to something unique to you, such as
   `com.<yourname>.nooklet`. Apple allows each identifier to only one team, so the default is taken.

Xcode now creates a signing certificate and a provisioning profile for that phone. When the
**Signing Certificate** row shows *Apple Development* and no red error remains, you are done.

Keep the bundle identifier once you have chosen it. iOS keeps an app's data under its identifier,
so a different one installs a second app with empty storage.

These edits change `apps/web/ios/App/App.xcodeproj/project.pbxproj`. Leave them out of your
commits: `git restore` that file before you commit, or commit with it unstaged.

## 5. Run the app

1. Press **⌘R** (Product → Run). Xcode builds, installs the app, and tries to launch it.
2. The first launch fails: the phone shows **Untrusted Developer**, or Xcode reports it could not
   launch the app. On the phone open **Settings → General → VPN & Device Management**, tap your
   Apple ID under *Developer App*, tap **Trust "<your Apple ID>"**, and confirm.
3. Press **⌘R** again. nooklet opens on the phone.

The app asks how to start: **Just this device** keeps a local-only graph on the phone; **Sync
with a server** connects to one (section 7). You can add the other kind later from the graph
switcher.

To try the app without a phone, pick an iPhone simulator as the run destination instead. The
simulator needs no signing.

## 6. Updating the app

After every pull or code change:

```sh
pnpm install --frozen-lockfile    # if dependencies changed
pnpm ios:sync
```

Then **⌘R** in Xcode. Xcode bundles only what `ios:sync` last copied, so skipping it installs the
old client again. Installing over the existing app keeps its data.

Avoid running `ios:sync` while a `nooklet serve` from the same checkout serves pages you are
testing: the build replaces the files that server hands out, and a page that loads mid-build stays
white until you reload it ([Building from source](building.md#a-white-screen-after-a-rebuild)).

### The 7-day limit

A free account signs apps for 7 days. After that the app will not open. Connect the phone, open the
project, press **⌘R**, and it runs for another 7 days with its data intact. A free account can also
keep only a few self-signed apps installed on one phone at a time. A paid Apple Developer Program
membership makes the signature last a year.

After the first install you can rebuild without the cable: in **Window → Devices and Simulators**,
select the phone and tick **Connect via network**. The phone and the Mac must share a network.

Renewing needs your Apple account to still be signed in to Xcode (**Xcode → Settings →
Accounts**). If it is not, a build stops with "No Accounts" even though the old profile is on disk.

### Without opening Xcode

Once the phone has been paired and is reachable over the network, the whole update runs from a
terminal. The UDID comes from the first command; `-allowProvisioningUpdates` lets Xcode renew the
free 7-day profile, so this also restarts the 7-day clock.

```sh
xcrun devicectl list devices             # the phone shows as "connected"
pnpm ios:sync
cd apps/web/ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -destination 'id=<phone UDID>' -derivedDataPath /tmp/nooklet-ios \
  -allowProvisioningUpdates build
xcrun devicectl device install app --device <phone UDID> \
  /tmp/nooklet-ios/Build/Products/Debug-iphoneos/App.app
```

The app's data survives the reinstall.

## 7. Connect to a server

The app talks to a server over its HTTP API and a WebSocket. Its own page comes from
`capacitor://localhost`, which counts as a secure context, so unlike a browser tab it can reach a
server over plain `http://` on your LAN.

| Server | Address to type in the app | Notes |
|---|---|---|
| On your Mac, over Wi-Fi | `http://<your-mac-LAN-IP>:6100` | Phone and Mac on the same network. iOS asks for local network access. |
| On your tailnet with HTTPS | `https://<machine>.<your-tailnet>.ts.net` | The Tailscale app must be on and connected on the phone. No local network prompt. |
| Somewhere public behind TLS | `https://notes.example.com` | See [Self-hosting](self-hosting.md). |

A bare address is fine; the app adds `/g/default`. For another graph, type the full
`https://…/g/<graph>` address.

### A server on your Mac

Find the Mac's LAN address and start a server that listens on it:

```sh
ipconfig getifaddr en0    # Wi-Fi; prints something like 192.168.1.5
pnpm nooklet serve --data <absolute-data-dir> --host 0.0.0.0 \
  --allow-host <your-mac-LAN-IP> --loopback-token
```

- `--host 0.0.0.0` makes the server reachable from other devices. `--allow-host` names the address
  they will use; without it the server answers `403 Host "…" is not allowed`. The startup banner
  lists your Mac's addresses and the exact flag to add.
- `--loopback-token` lets programs on the Mac itself get a token without pasting one. The
  [desktop app](getting-started.md#the-desktop-app-macos) on the same Mac should connect to
  `http://127.0.0.1:6100`, never the LAN address: its window loads the client from the server, and
  a page from `http://<LAN-IP>` is not a secure context. The auto-token is off by default whenever
  the server binds a non-loopback address; this flag turns it back on.
- The first time, macOS asks whether `node` may accept incoming connections. Click **Allow**, or the
  phone times out.
- Guest and "isolated" Wi-Fi networks block traffic between devices. Use a normal one.

Check the server from the Mac before you touch the phone:

```sh
curl -s http://<your-mac-LAN-IP>:6100/healthz    # {"name":"nooklet","status":"ok"}
```

### Pair the phone

Mint a token for the phone on the machine that runs the server. `--link` also prints a pairing
link:

```sh
pnpm nooklet token create --data <absolute-data-dir> --label phone --scope write --sync \
  --link http://<your-mac-LAN-IP>:6100
```

**With the pairing link.** It looks like
`nooklet://connect?url=http%3A%2F%2F<your-mac-LAN-IP>%3A6100%2Fg%2Fdefault&token=nk_…`. Get it onto
the phone: AirDrop a note that contains it, or copy it on the Mac and paste it into Safari's
address bar on the phone (Universal Clipboard needs the same Apple ID and Handoff on). Safari asks
to open it in nooklet. The app shows **Connect to this server?** with the address; check it and
tap **Connect**. Nothing contacts the server before you tap.

**By hand.** In the app choose **Sync with a server**, enter the address and paste the token, then
tap **Connect**.

The link contains the token, and so does your clipboard. Anyone who sees either can use the graph
until you revoke the token. Delete the note afterwards. `pnpm nooklet token list` shows token ids
and `pnpm nooklet token revoke <id>` revokes one. Pairing with a QR code and a one-time code is in
progress and not merged yet.

**The local network prompt.** The first time the app reaches a server on your LAN, iOS asks
whether nooklet may find and connect to devices on your local network. Tap **Allow**. If you
tapped **Don't Allow**, turn it on in Settings → Privacy & Security → Local Network → nooklet.

When the connection works, the app reloads into today's journal and the sync indicator at the top
turns green. Type on one device and the text appears on the other within a few seconds.

## 8. Debug with Safari's Web Inspector

The app's JavaScript console is not visible in Xcode. Safari on the Mac can attach to it.

1. On the Mac: **Safari → Settings → Advanced → Show features for web developers**.
2. On the iPhone: **Settings → Apps → Safari → Advanced → Web Inspector** on.
3. Run the app from Xcode (debug builds are inspectable) with the phone connected.
4. In Safari's **Develop** menu, open your iPhone's submenu. It lists the nooklet page
   (`capacitor://localhost`) and, separately, its **Worker**.

Inspect both. The page shows UI errors. The sync engine and the SQLite replica run in the Worker,
so connection, sync and storage errors appear there. The Network tab shows each failed request
with its status. Copy the red lines when you report a bug.

Native crashes, and the app failing to launch at all, show in Xcode's debug console at the bottom
of the window.

## Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| "Your team has no devices from which to generate a provisioning profile" or "No profiles for '…' were found" | Signing ran before Xcode had seen the phone. | Connect, unlock and trust the phone, select it as the run destination (step 2), then let signing retry, or click **Try Again**. |
| No **Developer Mode** entry in Privacy & Security | Xcode has not seen the phone yet. | Do step 2, then look again. |
| "Failed to register bundle identifier" or "not available" | Someone else's team owns `sh.nooklet.app`. | Pick your own bundle identifier (step 4). |
| **Untrusted Developer** on the phone | First run with a new certificate. | Settings → General → VPN & Device Management → trust your Apple ID, then **⌘R** again. |
| The app stopped opening after a week | The free signature expired. | Connect the phone and **⌘R** again. Data stays. |
| The phone still shows old behaviour after a rebuild | `ios:sync` did not run, so Xcode bundled the old client. | `pnpm ios:sync`, then **⌘R**. |
| "Load failed" on every request | The server does not answer the app's CORS preflight, or the phone cannot reach it. | Run the curl check in [Building from source](building.md#the-ios-app-says-load-failed-on-every-request). On the phone, open `<address>/healthz` in Safari. |
| Connecting times out | Local network access was denied, macOS blocked `node`, or the Wi-Fi isolates devices. | Settings → Privacy & Security → Local Network → nooklet on; allow `node` in the macOS prompt or firewall settings; use a non-guest network. |
| `403 Host "…" is not allowed` | The server was not told the address the phone uses. | Restart `serve` with `--allow-host <that address>`. The server log names it. |
| "Token rejected" | The token was revoked, mistyped, or minted on another data directory. | Mint a new one with `token create … --scope write --sync`. |
| Sync indicator stays grey or offline, server is up | The phone is on another network, or Tailscale is off on the phone. | Check the address opens in Safari on the phone. |
| The desktop app on the same Mac shows a blank page | It was pointed at `http://<LAN-IP>`, which is not a secure context. | Point it at `http://127.0.0.1:6100`, with `--loopback-token` on the server. |
| White screen right after you ran `ios:sync` or another build | A page loaded while the build replaced the server's client files. | Reload once the build finishes. |
