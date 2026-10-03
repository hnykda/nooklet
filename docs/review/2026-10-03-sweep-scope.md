# Scope sweep: PLAN v1 against the code, 2026-10-03

Agent: sweep-scope (coordinator.md "In flight"). Base: `main` at `c322269`. This is a reading
pass plus one probe. No code was changed. "e2e" means a spec in `e2e/tests/`, which runs real
Chromium against a real `nooklet serve` and a production build. "unit" means vitest only. Per
CLAUDE.md, anything backed only by unit tests counts as *believed* to work.

Method: read PLAN.md §2/§8/§12/§14–16, README, OPERATIONS.md, `docs/wiki/pages/Sync.md`, the
coordinator's top section, and BUGS.md's Open section. Then grepped the code and the e2e specs
for each feature. One probe was run against a scratch server on port 6377
(`tools/probes/cors-preflight.sh`).

---

## 1. The owner's real test: Mac app, own server behind Tailscale, physical iPhone

| Piece | Status | Evidence / gap |
|---|---|---|
| Server deployability | **partial** | Runs only from source (`pnpm nooklet serve`, Node ≥24, tsx). There is no container, no systemd or launchd unit, and no release artifact. Remote access needs `--host` plus `--allow-host` (`packages/server/src/cli.ts:107`). `OPERATIONS.md` §1 says "no supervisor/systemd unit shipped". |
| Data dir | done, docs stale | Each graph lives at `<data>/graphs/<id>/graph.sqlite` (`graphs/paths.ts`). `OPERATIONS.md` §2 still describes `<data>/graph.sqlite`. |
| Backup | done, unit only | `nooklet backup`/`restore`/`gc`/`verify` (`backup/`, `gc.ts`, `verify.ts`; server unit tests). Nothing schedules them: backups are manual. The mirror (`mirror/live.ts`, e2e `mirror-live.spec.ts`) is a second copy, on by default. |
| Token for a new device | done, e2e | `nooklet token create --label phone --scope write --sync [--graph id]`, paste-a-token (`views/ConnectView.tsx`). e2e: `remote-device.spec.ts` "a device with no token gets the connect screen, and pairing works". **Typing a 51-char token on an iPhone is the whole pairing UX**: the PLAN's link/QR pairing does not exist. |
| Connect UX, Mac app | done, unverified by hand | The desktop picker holds remote graphs (ADR 025 M6), and its webview navigates to the server's own origin, so it has no CORS issue. `multi-graph-hosting.md`: "no GUI interaction was exercised at all". e2e `desktop-launcher.spec.ts` stubs the Rust commands. |
| Connect UX, iPhone **Capacitor app** | **likely broken** | The app runs at `capacitor://localhost` and calls the server at an absolute URL (`data/bootstrap.ts` `apiBaseUrl`), so every fetch that carries `Authorization` is cross-origin. The server has **no CORS handling at all**: grepping `packages/server/src` for `cors\|Access-Control` finds nothing. Probe on `c322269`: `OPTIONS /g/default/sync/pull` with `Origin: capacitor://localhost` → `404`, no `Access-Control-*`. A GET with the token → 200 but no `Access-Control-Allow-Origin`. Capacitor's docs (https://capacitorjs.com/docs/apis/http) treat CORS as the server's job unless `CapacitorHttp` is enabled. It is not enabled (`apps/web/capacitor.config.ts`), and that patch would not reach the sync Worker anyway. **Not run on a device.** The sweep-devices agent has a Simulator probe for exactly this (`tools/probes/capacitor-network/` in worktree `agent-aaca187…`). |
| Connect UX, iPhone **Safari PWA** | plausible, unverified | Same-origin, so no CORS. It needs HTTPS: OPFS and `navigator.locks` need a secure context (wiki Sync.md). A plain `http://host.tailnet.ts.net:6100` is not a secure context, so the PWA needs `tailscale serve` (research/12 §10), and no doc says so. **Still unverified**: whether `tailscale serve`, proxying to 127.0.0.1, presents a loopback peer *and* a loopback `Host`. If it does, `isLoopbackRequest` (`http/app.ts:83`) hands every tailnet device a token automatically. If it forwards the `ts.net` Host, the guard holds. |
| Sync | done, e2e | `sync/sync-client.ts`, core property tests, `apps/web/src/sync/e2e.test.ts`. Two browser contexts sync in `ref-pages`, `remote-rewrite`, `page-delete`, `journal-agenda` and `ref-label-flash` specs. B-587 (rebuild-parity divergence) is open and not investigated. |
| Offline | done, thin e2e | One e2e: `sync-indicator.spec.ts` "offline shows the offline state…" (type offline, reconnect, the server has it). No e2e covers an offline cold start of the PWA, i.e. reload with the network off. The only offline reload is in the unmerged `mermaid-lazy-cache.spec.ts`. |
| Conflict merge | done, unit only | 3-way text merge: `core/sync/text-merge.ts`, wired in `sync-client.ts:511`, unit tests only. The editor side (another device rewrites the row being edited) is e2e: `remote-rewrite.spec.ts`. No e2e covers two devices editing one block's text at the same time. The wiki says the merge is still "planned" (stale). |
| Mobile editing: keyboard toolbar | done, emulated e2e | `commands/toolbar/MobileToolbar.tsx`. e2e `phone.spec.ts` uses an iPhone 13 descriptor in Chromium, not iOS WebKit. `@capacitor/keyboard` inset handling has never reached a native bridge (PLAN M5). |
| Mobile editing: gestures | done, unit only | `editor/gestures/swipe*.ts`, `longPressDrag*.ts`. No e2e touches either. `longPressDragAttach.ts` says "NOT unit tested… manual-verification list". Long-press drag only moves a block up or down; it cannot reparent. |
| Quick capture | done, unit only | `/capture` (`routes/CaptureRoute.tsx`, `capture/quickCaptureService.ts`), component and unit tests, **no e2e**. On iOS the PWA `share_target` and `shortcuts` do not work, and the Capacitor shell has no share extension (`apps/web/ios/App/App` holds only AppDelegate/SceneDelegate). The `nooklet://` handler (`platform/capacitor.ts:147`) has never fired natively. So on the phone, quick capture is "open the app". |
| Mirror / backup | done | See above. The mirror is DB → files only. |
| MCP / agent | done, e2e | `/g/<id>/mcp`. Bare `/mcp` and `/api/v1` answer **307** to `/g/default/…` (probe). README and OPERATIONS still print the bare URLs. The stdio bridge opens the SQLite file in-process (`mcp/stdio.ts`), so it only works on the server machine, not from the Mac against a remote server. e2e: `agent-ops.spec.ts` (incl. `ui_run`), `history-later-edits`, `replace`. |
| Desktop dialogs | **broken in the app** | B-491: `window.confirm`/`alert` are dead in WKWebView. They are still used in `views/HistoryView.tsx:165,189` ("restore this version" can never be confirmed in the Mac app), `views/PageView.tsx:134`, `app/refactor-host.tsx:198` and `views/GraphMismatchView.tsx:36` (the errors are invisible). |

## 2. PLAN v1 coverage

| Class | Count | Notable items |
|---|---|---|
| Done, e2e-tested | 15 | outliner keys/selection/collapse/zoom/numbered/headings/fences/tables; refs/embeds/aliases/linked+unlinked; namespaces; journal stream + calendar; tasks, scheduled/deadline, agenda, Tasks view; FTS + fuzzy switcher; palette + slash; HTTP/OpenAPI/MCP, audit, `batch_undo`, `asset_upload`; live UI control; mirror; assets/images; plugins (mermaid, word-count, daily-summary); M7's ten items; multi-graph switcher; token/connect on web |
| Done, unit/manual only | 8 | semantic + hybrid search (e2e only exercises the "not set up" fallback; real Ollama only via `embeddings/manual-verify-real-ollama.ts`; coordinator: "embeddings were never configured on the owner's graph"); incremental embeddings + model switch; 3-way merge; gestures; quick capture; backup/restore/gc; Logseq import (server tests + the real 952-page graph); Capacitor storage durability |
| Partial | 6 | typed properties (every type is edited as text: `PageProperties.tsx` header); keybindings (the `keybindings.json` engine exists, but nothing loads user rows: `setKeybindings` has no caller, and there is no settings UI, conflict view or chord recorder); drag by bullet (long-press up/down only, no mouse drag-and-drop, no e2e); "related pages/blocks" (`ops/related.ts` server/MCP only, no UI); Mobile/Capacitor (Simulator only; no physical device, no native plugin call, no completed server connect, no Android); empty journal day (B-595, in flight) |
| Missing | 3 | device pairing by link/QR; tag-page property `template::` (PLAN §8; `template::` now means ADR 019 templates instead); share-sheet receiving / Shortcuts / quick actions (PLAN §14) |
| Contradicted by an open bug | 3 | client-side ref-page creation loses keystrokes (B-585, high); desktop confirm/alert dead (B-491, high); `[[` popup drops focus in the desktop app (B-42, high, waiting on the owner's focus log) |

Milestone exit criteria. **M1** met: real graph imported, MCP from Claude Code. **M2 not met**:
"replaces Logseq for daily journaling on … phone" has never run on a phone. **M3 unverified**:
the Czech/English claim rests on a manual script with no recorded result, and embeddings are off
on the owner's graph. **M4** met: three built-ins through the public API.

## 3. Agents in flight (not merged, not counted above)

| Slug | Branch state | Closes |
|---|---|---|
| b585 | `7784d54` committed | B-585 (contradicted → done if the e2e goes green); B-587 re-check pending |
| keys-small | progress file says "one commit", but the branch tip is still `fd779f4` (on main): uncommitted | B-450, B-594, B-592 (test fix): no gap on the device path |
| top-menu | nothing committed | discoverability only |
| mermaid-lazy | `ce99b82` | precache 8 MB → 3 MB (faster first PWA load on the phone); B-401 confirmed |
| refs-count | in progress | cosmetic |
| empty-journal | in progress | B-595 (partial → done) |
| real-device-test | **no progress file found** in any worktree at sweep time | the runbook this test needs |
| journal-headings, tag-autocomplete | merged (`9f41585`, `c6fe3bc`) | B-560, B-380 |

None of them touches CORS, QR pairing, the share extension, B-491's remaining `confirm()` calls,
keybinding customization or typed property editors.

## 4. Open bugs likely to bite during the test, ranked

1. **(not in BUGS.md) no CORS**: the Capacitor app probably cannot connect at all. Log it.
2. **B-585**: silent keystroke loss while linking pages. The fix is on a branch.
3. **B-491**: the Mac app cannot confirm a history restore, and errors go unseen.
4. **B-42**: `[[` popup focus loss in the Mac app.
5. **B-400**: a worker start failure (quota, corrupt replica, iOS eviction) means "Loading…" forever with no reset.
6. **B-587**: rebuild-parity divergence after a name-collision race. Multi-device is exactly where it happens.
7. **B-302 / B-416**: the replica stays busy for most of a second at a time on mid-sized pages, and blocks flicker after Enter/Escape. Worse on a phone CPU.
8. **B-443 / B-579**: name collisions across devices, and junk pages that are never cleaned.
9. **B-460**: a property changed on another device stays stale in the editor.
10. **B-538**: the Mac app shows "synced via another tab" after a navigation.

## 5. Stale lines in PLAN.md

- Line 3: "Status: all milestones implemented." M5 is partial, and M2's exit criterion (phone) is unmet.
- §3: "`packages/core` … Exists today (46 tests)." Core now has 423.
- §3: "`plugins/*` — built-in plugins … (Ollama provider, mermaid, tweet/video embeds, Logseq importer)." The shipped built-ins are mermaid, word-count and daily-summary.
- §5: "`$DATA/` `nooklet.sqlite` `pages/<Page Name>.md` …" The layout is now `<data>/graphs/<id>/graph.sqlite` plus a per-graph mirror (ADR 025).
- §2 Sync: "device pairing by link/QR". Not built (wiki Sync.md says so). Mark it deferred.
- §6: "v1.1 adds a 3-way text merge". Already shipped (M6 row, `text-merge.ts`). wiki Sync.md still says "planned".
- §8: "A tag page (kind `tag`) may declare `template::` listing property keys". Not built, and the key now collides with ADR 019 templates.
- §12: "with a settings UI that lists all commands, shows conflicts, and records chords". Not built. Only the read-only shortcut list in `HelpMenu` exists.
- §15 M7: "Not done, logged: B-85 …, B-86 …, B-88 …, B-94 …, B-108 …". All five are fixed in BUGS.md.
- §15 M5: add that the Capacitor app has no CORS path to a remote server (pending the Simulator probe).

Also stale outside PLAN: OPERATIONS.md §1/§2/§9 (bare `/mcp` URLs, single-graph layout); the
README's MCP config URL (it now 307-redirects); and `apps/web/capacitor.config.ts`'s header
("This repo does NOT check in generated `ios/`"), while `apps/web/ios/` is committed.

## Still unverified

- That WKWebView under `capacitor://` blocks these requests on a device. The inference comes from the missing headers plus Capacitor's docs. The sweep-devices probe should settle it.
- How `tailscale serve` sets `Host` and the peer address when it proxies to `127.0.0.1`, and with it, whether loopback token auto-issue leaks to tailnet devices.
- An offline cold start of the PWA on iOS Safari.
