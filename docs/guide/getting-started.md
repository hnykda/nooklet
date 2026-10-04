---
title: Getting started
description: Download or build nooklet, run a server, open the web, desktop, iOS and experimental Android apps, and pair devices with tokens or a pairing link.
order: 5
---

# Getting started

## Pick a setup

| Setup | Use it when | Devices |
|---|---|---|
| **Recommended: a server on your tailnet** | You want more than one device. | Every device on your Tailscale network, over HTTPS. |
| **One machine** | You want to try nooklet, or you only use one computer. | The machine itself. |
| Public server behind a TLS proxy | You cannot use Tailscale. | Anything; read the checklist in [Self-hosting](self-hosting.md#tier-2-public-behind-a-tls-reverse-proxy) first. |

Plain `http://` to another machine does not work: browsers only grant the APIs the client needs to
`https://` pages and `localhost`. See [Security](security.md) for why the tailnet setup is the
default.

## Download a release

Each tagged version is on the [Releases page](https://github.com/hnykda/nooklet/releases): the
desktop app for macOS, Linux and Windows, an experimental Android APK, release notes, and a
`SHA256SUMS` file. The server is a container image, `ghcr.io/hnykda/nooklet:<version>` (for
example `0.1.0`, or `latest`); see [Docker](self-hosting.md#docker). iOS has no download: build it
from source (below).

Not every build gets the same testing. The macOS app and the server are used daily; the Linux and
Windows apps are built in CI and not yet tested by the maintainer; Android is experimental and has
never been run by the maintainer. The README's
[platform table](https://github.com/hnykda/nooklet#platform-support) has the details.

To check a download: `shasum -a 256 -c SHA256SUMS --ignore-missing` in the folder holding both
(`sha256sum -c` on Linux, `Get-FileHash` on Windows).

## Install from source

You need Node 24 or newer, pnpm 12, and git.

```sh
git clone https://github.com/hnykda/nooklet.git
cd nooklet
pnpm install
pnpm --filter @nooklet/web build     # the web client the server serves
```

`pnpm nooklet <command>` runs the CLI from source. It runs with `packages/server` as its working
directory, so pass absolute paths to `import`, `--data` and similar flags.

`pnpm nooklet --help` lists every command.

[Building from source](building.md) covers every build target, the tests and the toolchain.

## One machine

```sh
pnpm nooklet serve
```

Open <http://127.0.0.1:6100>. The server redirects to `/g/default/`, the default graph, and the app
opens on today's journal. A browser on the same machine gets a token automatically, so there is no
login.

The data lives in `~/.nooklet/default` unless you pass `--data <dir>` or set `NOOKLET_DATA`. The
graph is `graphs/default/graph.sqlite` inside it, with the markdown mirror next to it in `pages/`
and `journals/`. On first start the server prints a **root token**; save it. You need it to create
graphs or list them from another device. `pnpm nooklet token root` prints it again.

To bring a Logseq file graph:

```sh
pnpm nooklet import ~/notes/my-logseq-graph
```

Importing before the first `serve` works too. Running it again skips pages that already exist.

## Recommended: a server on your tailnet

This puts the server on a machine that stays on (a home server, a small VPS, a Mac mini), reachable
only from devices on your [Tailscale](https://tailscale.com) network, over HTTPS with a real
certificate. Every device gets its own token.

1. In the Tailscale admin console, turn on **MagicDNS** and **HTTPS certificates**.
2. On the server machine, start nooklet on loopback, allow the tailnet name, and turn off the
   automatic local token (Tailscale's proxy connects from loopback, so without this flag every
   tailnet device could look like "this machine"):

   ```sh
   pnpm nooklet serve --data ~/nooklet-data \
     --allow-host <machine>.<your-tailnet>.ts.net \
     --no-loopback-token
   ```

3. Put Tailscale's HTTPS proxy in front of it:

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:6100
   ```

   Flags differ between Tailscale versions; check `tailscale serve --help`. Do not use
   `tailscale funnel`, which publishes the server to the internet.

4. From another tailnet device, check it:

   ```sh
   curl https://<machine>.<your-tailnet>.ts.net/healthz
   # {"name":"nooklet","status":"ok"}
   ```

   A `403` that says `Host "…" is not allowed` names the exact `--allow-host` value to add.

5. Mint one token per device (next section) and connect each device to
   `https://<machine>.<your-tailnet>.ts.net`.

To run it in Docker or Kubernetes instead, see [Self-hosting](self-hosting.md).

## Tokens

Every device and every agent gets its own token. The server prints it once and stores only a hash.

```sh
# a phone or laptop that syncs
pnpm nooklet token create --label phone --scope write --sync

# an agent that reads and writes over MCP or HTTP, no sync
pnpm nooklet token create --label claude --scope write

pnpm nooklet token list
pnpm nooklet token revoke <token-id>
```

Add `--data <dir>` if the server does not use the default data directory, and `--graph <id>` for a
graph other than `default`. A device needs `--scope write --sync` to edit and sync. See
[Security](security.md#tokens-and-scopes) for what each scope allows.

### Pairing link

`--link <address>` also prints a link that sets up the iOS app in one tap:

```sh
pnpm nooklet token create --label phone --scope write --sync \
  --link https://<machine>.<your-tailnet>.ts.net
```

```text
nooklet://connect?url=https%3A%2F%2F<machine>.<your-tailnet>.ts.net%2Fg%2Fdefault&token=nk_…
```

Open it on the phone (AirDrop it in a note, or paste it into Safari's address bar). The app shows a
"Connect to this server?" screen with the address and connects only when you tap **Connect**. It
adds the server graph to the list and keeps any local-only graphs.

The link contains the token. Anyone who sees it can use the graph until you revoke it, and it lingers
in clipboards, notes, chat and screenshots. Delete it after use. There is no QR code yet.

## The web app

Open the server's address in a browser. On a device other than the server, the app asks for a
token: paste one minted with `--scope write --sync`.

The address must be `https://…`, or `http://127.0.0.1` / `http://localhost` on the server machine
itself. Over plain `http://` to another machine the app shows a page explaining that it needs a
secure context, and stops.

The web app can be installed as a PWA from the browser's menu.

## The desktop app

Download it from the [Releases page](https://github.com/hnykda/nooklet/releases), or build it
from source. None of the downloads is code-signed yet, so each OS warns the first time:

- **macOS** (`nooklet-<version>-macos-arm64.dmg` for Apple Silicon, `-macos-x64.dmg` for Intel).
  Open the `.dmg` and drag nooklet to Applications. Because the app is not signed or notarized,
  macOS says it "is damaged and can't be opened" or "cannot be verified". Clear the download
  quarantine once:

  ```sh
  xattr -dr com.apple.quarantine /Applications/nooklet.app
  ```

  On some macOS versions right-click → **Open** → **Open** works instead, or System Settings →
  Privacy & Security → **Open Anyway** after the first refused launch. The Intel build is untested.
- **Linux** (`-linux-x64.AppImage` or `.deb`). Built in CI, not yet tested by the maintainer.
  AppImage: `chmod +x nooklet-*.AppImage && ./nooklet-*.AppImage`. Debian/Ubuntu:
  `sudo apt install ./nooklet-*.deb`. Both need WebKitGTK 4.1, which current Ubuntu and Debian
  ship.
- **Windows** (`-windows-x64-setup.exe`). Built in CI, not yet tested by the maintainer. SmartScreen
  shows "Windows protected your PC": **More info** → **Run anyway**. It installs for the current
  user, no administrator needed.

To build it yourself you need Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
in addition to the above:

```sh
pnpm desktop            # development run
pnpm desktop:build      # build nooklet.app and a .dmg under apps/desktop/src-tauri/target/
```

The app does not update itself yet. The version is at the bottom of the `?` menu, which links to the
Releases page; download the newer build and replace the app. Your data stays where it is.

- **Local mode ("This Mac").** The app starts its own bundled server on `127.0.0.1:6100`, using
  `~/.nooklet/default` (or `$NOOKLET_DATA`). If something already answers on 6100, the app uses that
  server instead. `NOOKLET_PORT` moves it to another port.
- **A remote server.** Menu → **Switch Server…** → **Add a server** → the server's `https://`
  address. The window then loads the app from that server and asks for a token.

## The iOS app

There is no App Store build. You build it with Xcode on a Mac and install it on your own phone. A
free Apple ID works; apps it signs expire after 7 days and need a rebuild.
[Build and install nooklet on your iPhone](ios-from-source.md) has the full walkthrough and fixes for
the usual signing errors.

```sh
pnpm ios:sync     # builds the web client and copies it into the Xcode project
pnpm ios:open     # opens apps/web/ios/App/App.xcodeproj
```

In Xcode:

1. Settings → Accounts: add your Apple ID.
2. The **App** target → Signing & Capabilities → tick *Automatically manage signing*, pick your
   team. If Xcode says the bundle id is taken, change it to something unique.
3. Connect the iPhone, choose it as the run destination, and turn on Developer Mode on the phone
   (Settings → Privacy & Security).
4. Run. The first time, trust your developer certificate on the phone (Settings → General → VPN &
   Device Management), then run again.

After a code change, run `pnpm ios:sync` again before building; Xcode only bundles what that step
copied.

In the app, choose **Just this device** for a local-only graph, or **Sync with a server** and enter
the server address and a token, or open a pairing link. The server address can be bare
(`https://host`); the app adds `/g/default`.

If the phone reaches the server over the local network instead of Tailscale, iOS asks once whether
nooklet may find devices on your local network. Allow it, or the connection times out. You can
change it later in Settings → Privacy & Security → Local Network.

## Android (experimental)

**The Android app has never been run on a device or an emulator by the maintainer.** It is
generated from the same Capacitor project as the iOS app and the release workflow builds it, so
it should work in principle, but nobody has checked. If you try it, please send a
[platform report](https://github.com/hnykda/nooklet/issues/new?template=platform-report.yml),
whether it works or not.

### Install the APK

1. Download `nooklet-<version>-android-experimental.apk` from the
   [Releases page](https://github.com/hnykda/nooklet/releases) on the phone. (A file ending in
   `-debug.apk` means the release was built without the signing key: it installs the same way,
   but a later signed APK cannot update it in place. Uninstall it first, which deletes its local
   data.)
2. Open it. Android asks to allow installs from that app (your browser or file manager): allow
   it, then **Install**. Play Protect may warn about an app from an unknown developer; **Install
   anyway**.
3. Optionally compare the file against `SHA256SUMS` from the same release first.

### What should work

The same web client as iOS and the desktop apps, so in principle everything the
[features page](features.md) lists:

- **Just this device**: a local-only graph stored in the app.
- **Sync with a server**: enter the server address and a token, as on iOS. Prefer an `https://`
  address (Tailscale or a TLS proxy). Plain `http://192.168.x.x:6100` is allowed by this build for
  home-network servers, but the token and your notes then cross that network unencrypted.
- **`nooklet://` links**, including pairing links (`token create --link`).

### What is likely rough

- **The keyboard toolbar** and the space above the keyboard. The iOS insets were tuned on iOS;
  Android reports keyboard height differently.
- **The back button.** Nothing handles it yet; it probably closes the app instead of going back.
- **Storage durability.** The work that keeps a local-only graph safe when the app is backgrounded
  or storage is evicted (B-573: reopen on resume, a native-filesystem checkpoint) lives in the shared
  Capacitor code, so it runs on Android too, but it was designed around iOS's behaviour and only
  ever tested there. Keep anything important synced to a server.
- **Background and resume**, which on iOS needed several fixes.
- **Cleartext HTTP** to a LAN server relies on two settings that have never been exercised on a
  device (`network_security_config.xml`, `allowMixedContent`); live sync over `ws://` may fail
  even where page loads work.

### Report what you find

Use the [platform report](https://github.com/hnykda/nooklet/issues/new?template=platform-report.yml)
template. Its checklist covers the same checks the iOS app was tested with. The most useful extra
detail is the WebView console: enable USB debugging, connect the phone, open `chrome://inspect` in
desktop Chrome, and inspect the nooklet WebView. The sync engine runs in a Worker, listed
separately.

### Build it from source

You need Android Studio (or JDK 21 and the Android SDK) in addition to the above.

```sh
pnpm android:sync     # builds the web client and copies it into apps/web/android
pnpm android:open     # opens the project in Android Studio
```

Run it on a device or emulator from Android Studio, or build an APK on the command line with
`cd apps/web/android && ./gradlew assembleDebug` (output in `app/build/outputs/apk/debug/`).

## Check it works

- Type on one device; it appears on the other within a few seconds.
- Turn one device's network off, edit, turn it back on; the edits arrive.
- `pnpm nooklet verify --data <dir>` on the server replays the op log and should print `OK`.

Next: [Self-hosting](self-hosting.md) for Docker, Kubernetes, proxies and backups, or
[For AI agents](agents.md) to connect Claude Code.
