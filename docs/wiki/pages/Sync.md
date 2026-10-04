type:: guide
summary:: Optional. The op log in one paragraph, how to run a server other devices can reach, and what a second device does.
tags:: guide

- Sync is optional. One machine running the desktop app or `nooklet serve` is a complete setup, and nothing prompts you to pair anything.
- ## How it works, in one paragraph
  - Every client holds a full SQLite replica of the graph. Every write — a keystroke settling, an indent, a task ticked, an agent's edit — becomes one or more ops in an append-only log, each on one field of one entity and stamped with a hybrid logical clock. Clients push their pending ops to the server and pull everyone else's. Fields merge last-writer-wins by clock; sibling order is a fractional index, so two devices inserting into the same list need no lock; and the server is the one validator of tree shape — it numbers every op and, if two devices moved blocks into a cycle, picks a winner and emits a corrective op that every device converges on within one round trip. Offline edits queue in the local database, in the same transaction as the local change, and go out when the network is back. State is a pure function of the log, which is what `nooklet verify` checks by replaying it (ADR 003).
  - Two devices editing the same block's text at once are merged word by word when the edits touch different parts of it. When they overlap — both rewrote the same words — the newer text stays in the block and the other device's text becomes a new block right after it, with a small "sync conflict" badge. Keep it, merge it by hand, or delete it; to drop the badge but keep the block, delete the `sync-conflict:: true` line in the editor (ADR 027).
  - Assets (images, files) are not in the op log: the server stores them and clients fetch on view. Embeddings never sync either.
- ## Running a server other devices can reach
  - `nooklet serve` binds `127.0.0.1` by default. Reaching it from another device takes both `--host` and an `--allow-host` list, plus a URL that a browser treats as a secure context:
  - ```sh
    nooklet serve --host 0.0.0.0 --allow-host my-machine.tailnet-name.ts.net
    ```
  - The allowlist: a request whose `Host` header names anything else gets a 403, on every route. That is what stops a DNS-rebinding page in your own browser from reaching the server (B-25, B-26). The startup message says exactly what is accepted.
  - Secure context: a plain `http://192.168.1.5:6100` is not one, and the client needs one to open its local database (OPFS) and elect a writer tab (`navigator.locks`) — at a plain LAN IP the client cannot start at all (B-27). Put the server behind a reverse proxy with TLS, or reach it over a tailnet such as Tailscale. There is no TLS built in.
  - Keep it alive with whatever you already use — `launchd`, `systemd --user`, `tmux`. Ctrl-C or SIGTERM shuts it down cleanly. Set `NODE_ENV=production` once you trust the setup to skip the op-log replay check on every start (`docs/OPERATIONS.md` §1).
- ## What a second device does
  - Open the server's URL on the phone or the other laptop. A browser on the same machine as the server is handed a token automatically — decided from the connection's peer address, not a forgeable header. Any other device lands on **Connect this device** and needs one.
  - On the machine running nooklet: `nooklet token create --label phone --scope write --sync`. The token is printed once. Paste it into the Connect screen; the client checks it against the server before storing it, then reloads. "Continue without syncing" runs the app on a local replica with no server connection.
  - The device bootstraps from a full snapshot into its local replica, follows the op stream from there, and from then on works offline and syncs when it can. The top-bar indicator reads `synced`, `syncing (n)` while n ops are pending, or `offline`; `Sync now` in the palette forces a round trip.
  - The phone gets the same client as a PWA, with a keyboard toolbar (outdent, indent, move up/down, `[[`, `#`, `((`, `/`, checkbox, undo, redo, hide keyboard) while a block is being edited, and a `/capture` route that appends to today's journal without loading the whole graph.
  - Pairing by link or QR code (`docs/PLAN.md` §2) is not built; pasting a token is the exchange, and a QR would only be a front-end for the same tokens.
- ## Operating it
  - `nooklet token list` and `nooklet token revoke <id>`: a lost device is revoked, not chased. A revoked device token can no longer push or pull, and stops holding the op-log garbage-collection floor.
  - `nooklet backup`, `nooklet restore`, `nooklet gc`, `nooklet verify` — `docs/OPERATIONS.md` is the runbook; [[Command line]] lists the flags.
  - "device clock is wrong": the device's clock is more than 60 s ahead of the server's, so its push is refused rather than letting it win every conflict forever (ADR 003). Fix the clock.
  - A block briefly under an "Unplaced" node: two devices made a cycle at the same moment and the server is correcting it. Expected, not a bug.
- ## Two tabs on one device
  - The first tab holds the local database; a second tab of the same graph runs as a follower on an in-memory replica, fully usable, its writes reaching the first through the server. Its indicator says `synced via another tab` (B-81).
- Related: [[Architecture]], [[Troubleshooting]].
