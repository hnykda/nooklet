---
title: Sync, offline and conflicts
description: What happens when a device goes offline, what the sync indicator means, how conflicts resolve, and how local-only and multiple graphs work.
order: 4
---

# Sync, offline and conflicts

## Offline is normal

Every device has the whole graph in its own database. Reading, writing, journals, tasks, queries
and keyword search all work with no network. Each edit lands in a local outbox in the same
transaction as the change itself. When the device reaches the server again, it pushes the outbox
and pulls whatever it missed.

You do not need to do anything to sync. The client pushes about 300 ms after you stop typing,
pulls when the server pokes it over a WebSocket, and also pulls when the app comes back to the
foreground or the network returns.

What needs the server today:

- semantic (embedding) search; the device still answers keyword searches
- linked references and the graph view (**being improved**: they should work from the device)
- uploading a pasted image; viewing an image the device has not cached yet

## The sync indicator

The cloud icon in the top bar shows the sync state. Its tooltip (and its accessible name, for
screen readers) carries the sentence below. Click it to open Diagnostics.

| You see | It means | What to do |
|---|---|---|
| Synced | Everything on this device is on the server. | Nothing. |
| N changes waiting to sync | The outbox is not empty. Routine edits clear in under a second; the dot only changes if this lasts longer than 2 seconds. | Wait. If it stays, check the network. |
| Offline: changes are kept and sent when back online | The device cannot reach the server. | Keep working. Edits are safe in the outbox. |
| Token rejected: changes stay on this device until you enter a new token | The server refused this device's token (revoked, or never valid). Waiting will not fix it. | Click the red "Token rejected" button and paste a new token. Queued edits are kept and pushed afterwards. |
| Sync stopped on an error | Something failed that a retry did not fix. | Click for Diagnostics, and check the server's log. |
| Local only: not syncing to any server | This graph lives on this device only, by choice. | Nothing, or promote it to a server (below). |
| Synced via another tab | Another tab of the same graph holds the local database; this tab works through it. | Nothing. |
| Not saved locally | This browser cannot keep a database (no OPFS, often a private window). Edits reach the server but nothing stays on the device. | Use a normal window, or the app. |

A short WebSocket blip does not change the indicator. When the socket closes, the client waits 1.5
seconds and then tries a pull; only a failed pull shows Offline.

## Conflicts

Most "conflicts" are not conflicts. Each field of each block merges on its own, so these all keep
both changes:

- you edit a block's text on the phone while the laptop moves it
- you mark a task DONE on one device and add a tag to it on another
- two devices add blocks to the same page

When two devices change the **same field**, the later edit (by hybrid logical clock) wins on every
device.

**Text of the same block.** If you edit one block's text on two devices before either has synced,
the device that pulls second runs a three-way merge. Changes to different parts of the text both
survive. If the changes overlap, the later one wins, and the losing text is kept on the block as a
`conflict_copy::` property, so you can copy back what you need. **Being improved:** the losing text
will appear as readable blocks instead of a property.

**Structure.** If two offline devices move blocks into a cycle (A under B, B under A), the server
picks a valid placement and sends a correction. For one round trip a block may appear under an
"Unplaced" heading. Nothing is lost.

**A device clock far ahead.** The server refuses pushes from a device whose clock runs more than
60 seconds ahead. Fix the clock and the push goes through.

## Local-only graphs

A graph can live on one device with no server: the iOS app's "Just this device" option, or a local
graph in the switcher. It never syncs, and its sync indicator says "Local only". (In the desktop app
a graph "on this Mac" is different: it lives on the app's own bundled server, with a Markdown mirror
on disk, and the page syncs with that server like any other.)

A local-only graph has one risk a synced one does not: if the device loses it, there is no server
copy to restore from. The iOS app asks the system to keep its storage and also checkpoints the
database into app storage, but no one has tested recovery from a real eviction. Back up anything
you care about by promoting it to a server.

## More than one graph

A server can host many graphs, each at `/g/<graph-id>/`, each with its own database, mirror,
assets and tokens. A token for one graph does not work on another.

On a device, the graph switcher (next to the sync indicator) lists your graphs. Switching reloads
the app on the other graph. Three moves exist:

1. **Add a local-only graph.** Empty, unsynced.
2. **Promote a local-only graph to a server.** Creates a new, empty graph on the server (this needs
   the server's root token) and pushes this device's history into it.
3. **Add an existing graph from a server.** The device joins as a new replica and downloads it.
   With the root token, the add form can list the graphs a server hosts.

nooklet never merges two graphs that both already have content. Two histories that never shared an
origin cannot be combined safely, so the switcher keeps them side by side instead.

Renaming a graph in the switcher changes only this device's label. Removing it from the switcher
removes it from this device only; the server keeps it.

## When sync looks wrong

1. Click the sync indicator and open Diagnostics. It shows whether the device reached the API, what
   sync is doing, and whether search and embeddings work.
2. On the server, run `nooklet verify --graph <id>`. It replays the op log and reports any row
   where live state differs from the replay. After `nooklet gc` it will mention that some
   difference is expected.
3. If one device seems stuck behind, remove the graph from that device and add it again. It will
   download a fresh snapshot. Do this only once its outbox is empty, or the queued edits go with it.

More operator detail is in [Self-hosting](self-hosting.md) and [FAQ](faq.md).
