# Proposal 005: one graph list on desktop, one way to add a graph

**Status:** accepted 2026-10-04 by the owner ("yes, try that"); built as ADR 032, see `docs/progress/desktop-graphs.md` · **Prompted by:** the owner, after
using the desktop app against the production server: "the graph behaviour on desktop is still super
confusing … 'This computer' or 'Sync with server' and add new somehow which then gets you back and
then just token. Is this really the best we can do?"

## What is there now (mapped 2026-10-04, file references as of `25e3e7fc`)

A desktop user meets graphs in five places, built at different times for different hosts:

| Place | Shows | Adds by |
|---|---|---|
| Launcher (`apps/desktop/launcher/index.html`) | This Mac, This Mac's other graphs, servers from `desktop.json` | "Add a server": address only, `/healthz` ping, restart |
| Native menu "Switch Server…" (`main.rs`) | opens the launcher, after a restart | — |
| In-app graph menu (`shell/GraphSwitcher.tsx`) | the *current origin's* client list, grouped "On this device" / "On this Mac" / "On a server", plus This Mac graphs | "Add a graph" → "New graph on this Mac" / "Sync with a server" → address (+ token only if same origin) |
| ConnectView (`views/ConnectView.tsx`) | on a server page with no token | "Just this device" / "Sync with a server" → token only |
| Mismatch screen (`views/GraphMismatchView.tsx`) | after the server's graph changed | "Keep as a device-only graph" / open another / discard |

The confusions, each verified in the code:

1. **Two lists that never meet.** The launcher reads `desktop.json`; the in-app menu reads a list
   kept in each origin's localStorage. A server added in one is invisible in the other.
2. **The add loop.** In-app "Add a graph" → "Sync with a server" → address → restart → the server's
   page asks "Just this device / Sync with a server" *again* → a token-only field. The address and
   the token are asked for on two different screens, a restart apart.
3. **Concepts from the phone that mean nothing on a Mac.** "Just this device" on desktop is an
   in-memory flag on a remote origin (`App.tsx#skip`), unsaved, back on next launch. "On this
   device" sits next to "On this Mac". "Add a server for this graph" (promote) can never be enabled
   on desktop. ADR 028 rejected device-only graphs on desktop, yet the mismatch screen makes one.
4. **One concept, many names.** "Switch Server…" opens "Switch graph"; adding is "Add a server",
   "Add a graph", "Sync with a server", "Open a different graph instead"; This Mac has a phone icon
   in one place and a laptop in another.
5. **Restarts everywhere.** Creating, adding or switching restarts the app, because the shell
   decides once per launch whether to start the bundled server.

## Proposal

One model, one list, one entry point. In words a person would use:

> nooklet shows one graph at a time. Each graph lives either **on this Mac** or **on a server**.
> The graph menu lists them all; **Add a graph** either creates one on this Mac or connects to one
> on a server.

Concretely:

1. **The shell owns the list on desktop.** `desktop.json` is the single list: This Mac's graphs and
   server graphs (address + label; the device token in the macOS Keychain, not in the file). The
   in-app menu reads and changes it through the shell; the per-origin localStorage list is not used
   on desktop. The launcher's list view goes away.
2. **One menu.** The sidebar graph menu is the only place to pick, add, rename and remove. Two
   groups: **On this Mac** and **On servers** (by host). The native menu item becomes **Graphs…**
   and opens the same menu. No phone-only words (no "device", no "Just this device").
3. **One add dialog, one screen.** "Add a graph" offers:
   - **Create on this Mac**: a name. Done.
   - **Connect to a server**: address, token (or "Pair with a code/QR" from ADR 029), one button.
     The *shell* checks it (a request from Rust has no CORS problem, which is what forced B-704's
     hand-off), stores it, and opens it. A wrong token is reported right there, on the same form.
   No ConnectView on desktop: the shell already has the token when it opens a server page and hands
   it to that page (the way it hands `__NOOKLET_DESKTOP__` today).
4. **No restarts.** The bundled server always runs (it is small and idle when unused); switching is
   the window navigating to another graph's address.
5. **The launcher becomes only "Connecting…"** with, on failure, "Couldn't reach <server>.
   [Try again] [Open a graph on this Mac]".
6. **Mismatch on desktop** offers "Re-sync from the server" (the current Discard) and "Open another
   graph"; it never creates a device-only graph (ADR 028).
7. **Putting a This-Mac graph on a server** (promote) is a separate, later action in the graph's
   row menu, done by the server CLI/API (`nooklet import` or a push). Out of scope here.

The phone keeps its own flows for now, but uses the same words: **On this phone** / **On servers**,
and the same single add form (it already has the address field, Capacitor being CORS-allowlisted).

## What it costs

- A Rust HTTP check and Keychain storage in the shell (`security-framework` or `keyring` crate).
- The in-app menu gets a desktop data source (shell commands) next to the existing client list:
  `GraphSwitcher` branches on `shell`, as it already does in several places.
- Removing code: launcher list/add views, ConnectView's desktop paths, `DesktopServerSwitch`,
  "Just this device" on desktop, promote on desktop.
- An ADR amending 028 (single shell-owned list, always-on bundled server, token in Keychain).
- e2e: the desktop specs drive the page with a faked shell today; the add/verify path moves into
  Rust, so it needs Rust tests plus one real-window smoke check by the owner.

## Alternatives considered

- **Polish the wording only.** Cheap, but leaves the two lists, the restarts and the
  address-then-token split, which are the actual confusion.
- **Make the launcher the only switcher (in-app menu read-only on desktop).** One list, but every
  switch would leave the app for a separate page and restart; the in-app menu is where people look.
- **Keep the per-origin client list and sync it into `desktop.json`.** Two sources of truth to keep
  consistent; the bug class that produced confusion 1.

## Still unverified

- That WKWebView can be handed a token per origin without a page round-trip (expected via the
  existing initialization script, which already runs on every document of every origin).
- The memory and CPU cost of keeping the bundled server running when a remote graph is open.
