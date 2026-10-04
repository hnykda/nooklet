# Progress — QR pairing with one-time codes, device management under `admin` (B-655, B-603 follow-up)

Branch: this worktree's branch (based on main @ 72a2b12). Ports: 6470-6474 only. Not merged, not
pushed.

## Status

- [x] Server (`1a556a8`): `pairing_code` table (schema v8), ops `pairing.create` / `pairing.redeem`
      / `token.list` / `token.revoke`, rate limiter, socket close on revoke, `nooklet pair`
- [x] Web (`cfb9c19`): Settings → Devices, QR (lazy `uqr`), `/g/<id>/pair` landing page,
      `nooklet://connect?…&code=…`
- [x] e2e `e2e/tests/qr-pairing.spec.ts` (2 tests, green on port 6470)
- [x] QR decode probe `tools/probes/qr-decode/` (web QR and terminal QR both decode to the URL)
- [x] Simulator (private device, created and deleted): code link via the app, and the pairing page
      in Safari → "Open in the nooklet app" → app → Connect; screenshots in
      `tools/probes/pairing-link-ui/`. Found and fixed the same-tab stale-code bug (below)
- [x] Docs: security inventory, guide (security.md), sql-schema, mcp-tools, ADR 029
- [x] Full verification run (results below)

## Design as built

- **Code**: `nkp_` + 16 random bytes base64url (128 bits). Stored as sha256 only. Single use,
  10 min default (1–60 min), at most `write` scope (+sync by default). A new code from the same
  creator (same token, or the CLI) cancels that creator's earlier unused code ("regenerate").
- **Redeem** (`pairing.redeem`, the one `auth: "none"` op): claims the code with
  `UPDATE … WHERE code_hash=? AND used_at IS NULL AND expires_at > now`, mints the token in the same
  transaction. Unknown / expired / used / cancelled all answer the same 401. Two locks are needed
  for it to be public: the op's `auth: "none"` (else `buildOpCtx` refuses) and its route on
  `PUBLIC_ROUTES` (else the guard 401s first). `OpRegistry.register` refuses an `auth: "none"` op
  that is a plugin op, has scopes, or is MCP-exposed.
- **Rate limit** (`http/rate-limit.ts`): sliding 60 s window, 10 attempts per TCP peer, 60 in
  total, 429 + `Retry-After`. Peer = socket address, never `X-Forwarded-For`.
- **Admin ops**: `pairing.create`, `token.list` (label, scope, sync, created, last used, revoked,
  `current`; never the token or hash), `token.revoke` (closes the token's `/sync/live` and
  `/ui/live` sockets with 4401; MCP `requiresUserInteraction`). MCP lists them only for `admin`.
- **Revocation and sockets (B-676 H3, done)**: `auth/token-sockets.ts` tracks socket → token per
  graph driver. `token.revoke` closes at once. A CLI revoke (another process) is caught at the next
  poke: `sync/realtime.ts` re-reads `revoked_at` before sending and closes instead. `/ui/live` only
  closes on `token.revoke` (no poke there). H4 (hello timeout, caps) not done.
- **QR target**: `https://<server>/g/<id>/pair#code=…` — code in the fragment, so never in a request
  line or access log. The page (`apps/web/src/pair/PairLanding.tsx`) renders before the app boots
  and before the insecure-context check; it offers "Open in the nooklet app"
  (`nooklet://connect?url=…&code=…`) and, where the browser can run nooklet, "Use nooklet in this
  browser instead" (`<graph>/#pair=<code>` → the connect screen in the app). The fragment is
  removed from the address bar and history entry once read.
- **CLI**: `nooklet pair --link <public url> [--scope read|write] [--no-sync] [--minutes n]` prints
  a half-block terminal QR + the URL. Codes go to stdout only: never the server log (redeem logs
  label + token id), never `root.token`, never the DB in plain text.

## Decisions

- **Who holds `admin`** (B-655): (1) the loopback web-client auto-token, changed from `write` to
  `admin` — anything that can load the page as this machine can already read `graph.sqlite` and
  `root.token`, so `admin` adds nothing, and it is what lets the desktop app pair devices; it is off
  entirely with `--no-loopback-token` (containers). (2) The token `POST /graphs` returns (already
  `admin`; its caller holds the root token). (3) `token create --scope admin`. **Never** a token a
  pairing code produces (codes grant at most `write`), so a phone, or a leaked QR, can never manage
  devices. The root token does NOT act as a graph admin token: it is process-level, and making it
  one would be a second auth path into every graph.
- **Old token links (`token create --link`)**: kept working (app and CLI), not removed. They are
  less safe — the link *is* a long-lived credential wherever it travels (clipboard, Universal
  Clipboard, chat, screenshots, history) — so `--link` help now points to `nooklet pair` and the
  docs call it deprecated for phones. Recommend removing `--link` once the owner has paired with
  codes on a physical phone.
- **QR library: `uqr` 0.1.3** (unjs, MIT, zero dependencies, ESM, renders SVG *and* terminal
  half-blocks, so one dependency serves both the web and the CLI). `qrcode` 1.5.4 was the other
  candidate: three runtime deps (pngjs, yargs, dijkstrajs), larger, CommonJS. Size: npm unpacked
  79 KB; in the web build it is its own lazy chunk, **10.6 KB minified / 4.0 KB gzip**, loaded only
  when a code is shown. The pairing page is another lazy chunk, 1.8 KB / 0.9 KB gzip (+0.35 KB CSS).
  Exact version pinned (0.x).
- **Pair page in the SPA bundle, not a server-rendered HTML page**: the server's static fallback
  already serves the shell for `/g/<id>/pair`, and the PWA service worker's navigate fallback would
  serve the cached shell there anyway, so a separate server page would be shadowed for anyone who
  had used the web app on that origin. The landing is its own lazy chunk and boots nothing else.
- **Found on the Simulator, fixed**: the landing strips the fragment from the address bar, so a
  second pairing URL opened in the same Safari tab differed only by fragment → same-document hash
  change → the page kept the old, cancelled code. It now reloads on `hashchange`. e2e "a second
  pairing URL opened in the same tab shows the new code" is red without the fix.
- **`isPairPath` is anchored on `/g/<id>/pair`**, so a page named "pair" (`/g/<id>/page/pair`) is not
  swallowed. Found while writing the unit test.
- **The phone's address is a field** in Settings → Devices: the desktop app reaches its server at
  127.0.0.1, which means nothing to a phone. Prefilled with the page's own address when not
  loopback; remembered per graph in `localStorage`.

## Camera finding (iOS Camera and custom-scheme QR codes)

Apple documents only that the Camera "can quickly access websites, apps, tickets, and more"
(<https://support.apple.com/en-us/HT208843>) — nothing on custom schemes. Developer reports:
- InvenTree (issue opened 2026-09-04, <https://github.com/inventree/inventree-app/issues/877>): non-URL
  QR payloads "work in the InvenTree mobile scanner, but the iOS Camera app treats them as plain
  text"; web URLs work.
- Corona-Warn-App (2020-10-22, <https://github.com/corona-warn-app/cwa-wishlist/issues/224>): the
  camera "attempts to open the URL in a browser".
- Apple Developer Forums (2023, <https://developer.apple.com/forums/thread/733022>): a QR with an
  **https Universal Link** opens the installed app from the Camera.

Universal Links need an `apple-app-site-association` file on a domain listed in the app's
entitlements — impossible for a self-hosted server on each owner's own tailnet name. So the QR
encodes the https pairing page, which every camera opens, and the custom scheme is reached by a tap
on the page, which iOS routes to the installed app (with its "Open in nooklet?" prompt). That path
works whether or not the Camera handles custom schemes, and degrades to a readable page with
instructions when the app is not installed.

## Verification so far

- Server: `pnpm vitest run` in packages/server — 102 files / 833 tests pass (after commit 1).
  New: `ops/pairing.http.test.ts` (16: single use, hash-only storage, expiry, unknown vs malformed,
  regenerate cancels, the race — 8 concurrent redeems → 1 token, admin not requestable, rate limit
  429 + Retry-After, limiter window, write token 403 on all three admin ops, no-token 401, loopback
  web-client token is admin, list never leaks token/hash, revoke + 404, revoke closes WS with 4401,
  CLI-style revoke closes at next commit without a poke); `mcp/server.test.ts` (admin tools listed
  only for admin, redeem never); `auth/pairing-link.test.ts` (+3); `cli-first-run.test.ts` (+1:
  `nooklet pair` → real `serve` redeems once).
- Web: 185 files / 1632 tests pass. New: `data/pairing.test.ts`, `views/DevicesSection.test.tsx`,
  `PairingLinkPrompt.test.tsx` (+2), `connect-graph.test.ts` (+1).
- e2e (port 6470) `qr-pairing`: 2 passed.
- QR decode with Core Image (`tools/probes/qr-decode/decode.swift`): the Settings QR screenshot
  from the e2e decodes to exactly the shown URL; the `nooklet pair` terminal QR decodes too, in
  both dark- and light-terminal renderings.

## Still unverified

- A physical iPhone camera on the QR (the owner's test, steps below).
- Whether a phone camera reads the colour-inverted terminal QR a light-background terminal shows
  (Core Image does).

## Final verification (2026-10-04, branch head)

- `pnpm -r test`: core 25 files / 479, plugin-api 3 / 17, server 102 / 833, web 185 / 1632 — all pass.
- `pnpm -r typecheck`: clean. `pnpm exec biome check . --diagnostic-level=error`: clean.
- e2e on 6470 (`qr-pairing remote-device graph-switcher insecure-context appearance`, chromium):
  13 passed. Full e2e (port 6472, chromium + webkit projects): 789 passed, 2 skipped, 0 failed (23.5 min).
- `node tools/leak-check.mjs --tree`: clean.
- Simulator (iOS 26.5): both XCUITest flows passed (screenshots in `tools/probes/pairing-link-ui/`).

## Owner's physical-phone test

Needs: the server reachable from the phone over https (the tailnet name, e.g.
`https://nooklet.example.ts.net`), the nooklet iOS app built from this branch on the phone, and a
desktop session with `admin` (the desktop app, or a browser on the server's own machine).

1. Desktop: Settings → Devices → Add a device. Type the phone's address for the server
   (`https://<tailnet name>`), press "Show pairing code". A QR, the URL and a 10:00 countdown appear.
2. iPhone: open the **Camera** app and point it at the QR. Expect a yellow link chip naming the
   server. Tap it. **Record**: does Camera offer the link? (It should: it is an https URL.)
3. Safari shows "Pair this device with nooklet" with the server address. Tap
   **Open in the nooklet app**, then **Open** on iOS's "Open in “nooklet”?" prompt.
4. The app shows "Connect to this server?" with the address and "Name this device" (prefilled
   "iPhone"). Change the name if you like, tap **Connect**. Expect Today with both sync dots green.
5. Desktop: within a few seconds the Devices panel says "Paired: <name>", and the new row shows
   "write + sync". Edit a block on the phone and see it arrive on the desktop.
6. Reuse: scan the same QR again and go through to Connect. Expect "This pairing code is no longer
   valid". Press "New code" on the desktop, scan, and it works (and the old QR stays dead).
7. Revoke: Devices → Revoke on the phone's row → confirm. Expect the phone's sync dot to go red and
   "Token rejected" within seconds (the server closes its live connection), and edits made on the
   phone afterwards stay on the phone.
8. Optional, CLI: on the server, `nooklet pair --link https://<tailnet name>` and scan the terminal
   QR, once with a dark terminal theme and once with a light one. **Record** whether the Camera
   reads the light-theme (colour-inverted) one.
9. Optional, no app: delete the app, scan a new QR; the page should say what to do, and "Use
   nooklet in this browser instead" should pair Safari itself (https only).

## How to resume

Read this file, `git log --oneline 72a2b12..HEAD`, then continue at the first unchecked item.

## BUGS.md updates to fold in

- **B-655** → fixed (2026-10-04, commits on this branch). `admin` now gates `pairing.create`,
  `token.list`, `token.revoke`; the loopback web-client token is `admin`; pairing codes never grant
  `admin`. Plugin settings and gc/backup triggers have no ops yet, so nothing else to gate. Tests:
  `packages/server/src/ops/pairing.http.test.ts` "scope enforcement" (3), `mcp/server.test.ts`
  "B-655: lists the server-administration tools only for an admin token". ADR 029.
- **B-676** → H3 fixed (revocation closes the token's sockets, 4401; CLI revokes are caught at the
  next poke). Tests: `ops/pairing.http.test.ts` "token.revoke closes it at once with 4401", "a
  revoke from another process (the CLI) closes it at the next commit instead of poking it"; e2e
  `qr-pairing.spec.ts`. H4 (hello timeout, caps, maxPayload) still open → keep B-676 open for H4,
  or split it.
- **B-603** → follow-up done: QR pairing with one-time codes (the "No QR" note is obsolete). Token
  links still work; documented as less safe. Recommend deprecating `token create --link` once the
  owner has paired a physical phone with codes.
- **(new, fixed, found here)** The pairing page kept a cancelled code when a second pairing URL was
  opened in the same tab (fragment-only navigation after the page had stripped its fragment).
  Fixed in `apps/web/src/pair/PairLanding.tsx` (reload on `hashchange`). Test: e2e
  `qr-pairing.spec.ts` "a second pairing URL opened in the same tab shows the new code, not the
  cancelled one" (red without the fix). Found by `tools/probes/pairing-link-ui/`.
- **(new, fixed, found here, pre-ship)** `isPairPath` first matched any path ending in `/pair`,
  which would have turned a page named "pair" (`/g/<id>/page/pair`) into the pairing page. Anchored
  on `/g/<id>/pair`. Test: `apps/web/src/data/pairing.test.ts`.
- **(new, open, low)** The pairing confirm screen shows the server address twice (the read-only box
  and the editable "Server address" field) for both token and code links; pre-existing layout from
  B-603, visible in `tools/probes/pairing-link-ui/pair-code-confirm.png`.
- **(new, open, low, security)** Only `pairing.redeem` is rate-limited; behind a same-machine proxy
  every client shares one peer address, so a flood from one client can lock out pairing for a
  minute. Acceptable (pairing is rare, owner-initiated), noted.
- The guide's "Known gaps" no longer lists "`admin` means `write`" or "revoke does not close
  WebSockets".
