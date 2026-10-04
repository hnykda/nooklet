---
title: FAQ and troubleshooting
description: Fixes for the problems people hit in real testing, from secure-context errors and Host 403s to the iOS local-network prompt.
order: 11
---

# FAQ and troubleshooting

## The browser shows "needs a secure context" (or a blank page) over `http://`

Browsers give the APIs the client depends on (`crypto.randomUUID`, Web Locks, the origin-private
file system for the local database) only to secure contexts: `https://` pages and `localhost`. A
page at `http://<LAN-IP>:6100` is neither. Current builds show a page explaining this; older
builds showed a white page after you entered a token.

Fix: reach the server over HTTPS. `tailscale serve` gives you a certificate with no setup (see
[Getting started](getting-started.md#recommended-a-server-on-your-tailnet)). On the server machine
itself, `http://127.0.0.1:6100` works. An SSH tunnel to `localhost` also works.

The iOS app is not affected: its page is `capacitor://localhost`, a secure context.

## `403 Host "…" is not allowed`

The server checks the `Host` header against `localhost`, `127.0.0.1` and the names you passed with
`--allow-host`. With a non-loopback bind every other name gets 403; `/mcp` checks the list on every
bind. The message, and the server's terminal, name the flag to add:

```text
nooklet: refused a request for Host "notes.example.ts.net" (403). If that is the name devices or a
reverse proxy use, restart with --allow-host notes.example.ts.net
```

Restart with that `--allow-host`. Pass several names comma-separated. Do not try to allow every
name; the check is what stops DNS-rebinding attacks.

## The iOS app says "Load failed" on every request

Check the server answers the app's CORS preflight. From any machine that can reach it:

```sh
curl -si -X OPTIONS \
  -H 'Origin: capacitor://localhost' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type' \
  https://<server>/g/default/api/v1/graph.overview | grep -i access-control-allow-origin
```

It must print `access-control-allow-origin: capacitor://localhost`. If it prints nothing, the
server is a build from before CORS support; update it. Then open `https://<server>/healthz` in
Safari on the phone to check the phone can reach the server at all.

## iOS asks to "find and connect to devices on your local network"

The app asks the first time it talks to a server on your LAN. Tap **Allow**. If you tapped Don't
Allow, the connection times out; turn it on in Settings → Privacy & Security → Local Network →
nooklet. A server reached over Tailscale HTTPS does not trigger this prompt.

## On macOS, the phone cannot reach a server running on my Mac

macOS asks whether `node` may accept incoming connections the first time the server binds to
`0.0.0.0`. Allow it. Also check both devices are on the same network, and that it is not a guest
network that isolates devices.

## The app showed a white screen after I rebuilt the client

`nooklet serve` serves the web client from `apps/web/dist` as it is on disk. A build (including
`pnpm ios:sync`) deletes the old script files and writes new ones. A page that loads during the build
gets an `index.html` whose scripts no longer exist. Reload once the build finishes, and avoid
rebuilding while a server you are testing against serves that folder. This cause is suspected, not
confirmed; if it happens, open the developer console: 404s on `.js` files confirm it.

## The desktop app does not show my changes to the client

The desktop app uses whatever already answers on its port (6100 by default). If a `nooklet serve`
from a checkout is running there, the window shows that server's client, and rebuilding the `.app`
changes nothing. Rebuild the client that server serves, or stop it.

To run a second copy of the app side by side, give it its own port and data:
`NOOKLET_PORT=6420 NOOKLET_DATA=<copy> <app>/Contents/MacOS/nooklet-desktop`.

## The sync indicator says "Token rejected"

The server no longer accepts this device's token: it was revoked, or it belongs to another graph or
server. Click **Token rejected**, paste a new token (`nooklet token create … --sync`), and the device
pushes the edits it kept. A browser on the server machine that was open across a server restart
needs only a reload: the server mints a new local token per process.

## The device says "Offline" but the server is up

The client marks itself offline when a pull fails after the live socket closes. Check that the
address the device uses still resolves, that a proxy in between passes WebSocket upgrades on
`/g/<id>/sync/live`, and that you entered the address with or without `/g/<graph-id>` consistently.
A bare `https://host` means `https://host/g/default`.

## "Device clock is wrong" or pushes rejected

The device's clock is more than 60 seconds ahead of the server's. Fix the clock (turn on automatic
time); the push succeeds on the next try.

## Search finds words but not meanings

Semantic search needs an embedding model on the server, and it only switches on once every block
is embedded. Run `nooklet embed status`, or open Diagnostics from the sync indicator. A note under
the results says why the server answered with keywords only (not configured, still indexing,
provider unreachable, model missing). See
[Self-hosting](self-hosting.md#semantic-search-with-ollama).

## References say "Couldn't load references" offline

References come from the server today. Offline they show an error with Retry; on a local-only graph
they say they need a server. Work is under way to answer them from the device.

## A block shows `conflict_copy::`

You edited the same text in the same block on two devices before they synced, and the edits
overlapped. The later edit won; the property holds the other text. Copy what you need and delete the
property. This display is being replaced with readable blocks.

## A block appears under "Unplaced"

Two devices moved blocks into each other at the same time. The server picks a valid placement and
the block moves there on the next sync.

## `nooklet import` reports zero pages

`pnpm nooklet` runs with `packages/server` as its working directory, so a relative path resolves
there. Use an absolute path: `pnpm nooklet import "$PWD/my-graph"`. Import reads Logseq **file**
graphs, not the Logseq DB version's export.

## `nooklet gc` refuses to run

It will not trim the op log while any device holding a token has never pulled, because it cannot
know what that device still needs. Sync that device once, or revoke its token if it is gone.

## How do I remove or re-import a graph on the server?

Retire it, don't delete it. With the server running, send `DELETE /graphs/<id>` with the root
token. With it stopped, run `nooklet graph retire <id>`. Either way the folder moves to
`graphs-retired/` and `nooklet graph unretire` brings it back. To rebuild a graph from its Logseq
files, import into a scratch data dir and run `nooklet graph replace <id> --from <scratch>`, which
keeps every device's token. See
[Self-hosting](self-hosting.md#retiring-restoring-and-replacing-a-graph).

## The app says "The server has a different graph now"

The server now serves a different graph instance at this address: it was replaced (re-imported or
restored from elsewhere), or the server points at another data directory. After a replace this is
expected. Press **Discard the local copy and re-sync** (in the desktop app: **Re-sync from the
server**). It affects only this graph on this device, but edits on this device that never reached
the server are lost. If that might matter, choose **Keep as a device-only graph** (phone and
browser only), or point the server back at the old graph first (retire the replacement,
`nooklet graph unretire` the old one), let the device sync, then replace again.

## The sync indicator says "Graph retired"

The server's operator retired this graph (`DELETE /graphs/<id>` or `nooklet graph retire`). The
device stops trying to sync it. Your local copy and any unsynced edits stay on the device. Ask the
operator to bring it back with `nooklet graph unretire`, then reload.

## Is my data safe if the server dies?

Each device has a full copy of each synced graph, and the markdown mirror is on the server's disk.
Neither is a backup. Run `nooklet backup` on a schedule and copy the archive somewhere else. See
[Self-hosting](self-hosting.md#backups-and-restore).

## Can I edit the markdown files directly?

No. The mirror is one-way: nooklet writes the files and never reads them back. Your edit will be
overwritten the next time that page changes. Edit through the app or the API.

## Can I use nooklet without a server?

Yes. The desktop app runs its own server on your Mac, and the iOS app has "Just this device". Both
keep everything local.

## Where are known bugs?

[docs/BUGS.md](../BUGS.md) lists every open and fixed bug, with the test that covers each fix.
