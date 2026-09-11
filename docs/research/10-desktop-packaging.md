# 10 — Desktop packaging: Tauri vs Electron, and what a native app would cost

Dated record, 2026-09-11. Like the other files in `docs/research/`, this is kept as written rather
than updated in place; the decision it feeds is ADR 016.

Status: the Tauri/sidecar research is complete and is summarised below. An equivalent Electron
brief was commissioned at the same time and had not returned when this was written — the
comparison table's Electron column comes from official `releases.electronjs.org` assets and
`@electron/packager`'s own sizing statement, not from that brief.

---

## 1. The finding that changed the answer

The strongest argument against Tauri for nooklet was that the client stores its SQLite replica in
OPFS, and WebKit applies a much tighter storage policy to *apps that embed web content* than to
browsers: 15% of disk per origin / 20% overall, versus 60%/80% for a browser
([webkit.org/blog/14403](https://webkit.org/blog/14403/updates-to-storage-policy/)). On top of
that, the widely-cited [opfs-checker](https://github.com/wendylabsinc/opfs-checker) README claims
*"each file in the OPFS in a WKWebView is limited to 10MB"*. If true, the client replica simply
would not fit and the whole frontend storage design would be invalid under Tauri on macOS.

**Tested directly rather than trusted.** `tools/probes/wkwebview-opfs.swift` builds a WKWebView
that serves its content through a `WKURLSchemeHandler` on a custom scheme — the same mechanism
wry uses for `tauri://localhost`, so the origin under test is the real one, not `file://` or
`http://localhost`. Run it with `swiftc -O tools/probes/wkwebview-opfs.swift -o /tmp/opfsprobe &&
TARGET_MB=1200 /tmp/opfsprobe`.

Result on macOS 26.6.2 (build 25G83), Apple Swift 6.3.3, arm64:

```
origin=nooklet://localhost
isSecureContext=true            <- page
worker isSecureContext=true     <- and worker
hasStorageManager=true  hasGetDirectory=true  hasLocks=true
estimate.quota=20615843021 (19661 MiB)
final file size = 1200.0 MiB
post-write estimate.usage=1280.0 MiB quota=19661 MiB
DONE wrote=1200 MiB of 1200 MiB requested
```

So, on current macOS:

- The custom scheme **is** a secure context, in both page and worker. This confirms a reading of
  WebKit's `SecurityOrigin.cpp`, where `shouldTreatAsPotentiallyTrustworthy` returns true both for
  a `localhost` host and for any scheme handled by a `WKURLSchemeHandler` — two independent
  clauses, either sufficient. OPFS and `navigator.locks` are both secure-context-gated, so this
  was load-bearing.
- `navigator.locks` is present — the sync client's writer election works.
- The embedded-app quota is **~19.2 GiB**, consistent with the 15%-of-disk rule on this machine.
- **There is no 10 MB per-file cap.** 1.2 GB went into a single file via
  `createSyncAccessHandle` without error.

For scale: importing the real 127-page/825-journal graph produces a **46 MB** `graph.sqlite`, and
the client replica is smaller still, since `ref`/`path_ref`/`block_fts`/`page_fts`/`embedding*` are
server-only derived tables (sql-schema.md rule 1). That is ~0.2% of the quota.

**Caveats, stated plainly.** This is macOS 26.6 with a current WebKit; the HN report that
originally raised the alarm concerned the Safari 16/17 era, so older machines may genuinely
differ. It says nothing about **WebKitGTK on Linux**, which remains unverified and is the
open question now. And it exercises a raw OPFS file, not sqlite-wasm's `opfs-sahpool` VFS, which
spreads data over a pool of files — but the per-file cap was the claim under test, and the quota
figure governs both.

---

## 2. Sizes, measured

A standalone Node runtime is ~80% the size of Electron's whole prebuilt bundle, because Electron
ships Chromium **and** Node together. So the moment a JS runtime is in the bundle, Tauri's size
multiplier collapses to roughly 1.

| | Tauri shell | + Node sidecar (SEA) | **Total** | Electron 44.3.0 |
|---|---:|---:|---:|---:|
| macOS arm64 | ~5 MB | 116.5 MiB | **~122 MiB** | **123.8 MiB** |
| Linux x64 | ~4 MB | 120.7 MiB | **~125 MiB** | **117.1 MiB** |
| Windows x64 | ~3 MB | 89.2 MiB | **~92 MiB** | **150.8 MiB** |

Measured SEA artifacts (official Node tarballs, built and run):

| Artifact | MiB |
|---|---:|
| `node` v24.21.0 darwin-arm64 | 116.5 |
| SEA hello-world, Node 24.21.0 darwin-arm64 | 115.6 |
| `node` v26.8.2 darwin-arm64 | 139.1 |
| SEA + ESM + embedded sqlite-vec, Node 26.8.2 | 137.4 |

The SEA is the Node binary ±1% — application code is rounding error. Node 26 is ~19% larger than
Node 24.

**Conclusion: a wash on macOS, Tauri slightly worse on Linux, Tauri ~39% smaller on Windows.**

> The widely-circulated "Tauri 3.2 MB vs Electron 85 MB / 96% smaller" figures all trace to SEO
> content farms with no published methodology. Do not cite them. The one reproducible harness
> ([Elanis/web-to-desktop-framework-comparison](https://github.com/Elanis/web-to-desktop-framework-comparison))
> gives Tauri 95 MB vs Electron 369 MB RSS on macOS-arm64 — but **317 vs 278 MB on Windows, i.e.
> Tauri worse** — and shows Tauri cold-starting *slower* on every platform. Treat direction as
> signal, magnitudes as noise; it publishes neither framework versions nor run date.

---

## 3. Node SEA: the constraints that bite

- **Stability is still `1.1 – Active development`** and has not graduated. (`node:sqlite`, by
  contrast, is now `1.2 – Release candidate`.)
- **ESM requires Node 25.7+.** `mainFormat: "module"` landed in v25.7.0 and the one-shot
  `node --build-sea` in v25.5.0; **neither was backported to v24**. Worse, v24 *silently accepts
  and ignores* `mainFormat: "module"`, producing a blob then interpreted as CJS. On Node 24 you
  must bundle to CommonJS and use `--experimental-sea-config` + `postject`.
- **Extension loading works.** Official Node 24 and 26 builds are compiled with SQLite extension
  loading enabled (both bundle SQLite 3.53.4). An ESM SEA embedding sqlite-vec v0.1.9's
  `vec0.dylib` as a SEA asset, extracted at runtime and loaded through `node:sqlite`, was verified
  end-to-end: `vec_version: v0.1.9`, `vec0` table created, KNN query returned.
- **Module loading does not read the filesystem** inside a SEA. Escape hatches:
  `require = createRequire(__filename)` (and `__dirname === dirname(process.execPath)`, so sibling
  files *do* resolve), or embed as `assets` and read back with `sea.getRawAsset()`.
- **esbuild is the awkward one.** It is not a `.node` addon — the Node API spawns a per-platform
  *executable*, resolved from an `@esbuild/<platform>` optionalDependency that does not exist
  inside a SEA. You must embed that executable as an asset, write it out with the exec bit, and
  point at it via `ESBUILD_BINARY_PATH`. `esbuild-wasm` avoids this but is ~10× slower.
  **If esbuild is only needed at build time, drop it from the runtime bundle and this evaporates.**
- Platform support: macOS **arm64 only** (x64 skipped in Node's own tests); Linux except Alpine and
  s390x; postject-built Linux-arm64-in-Docker binaries crash on `process.dlopen()`
  ([postject#105](https://github.com/nodejs/postject/issues/105)). macOS/Windows binaries must be
  **re-signed after injection**. Homebrew's Node rejects SEA entirely
  (`Single executable application is disabled`) — a real CI hazard.

**Bun** (`bun build --compile`) is about half the size (~57–63 MB darwin-arm64) and genuinely
cross-compiles, but has a hard macOS blocker for this stack: Bun uses the *system* `libsqlite3.dylib`
on macOS, which Apple builds without `SQLITE_ENABLE_LOAD_EXTENSION`, so `loadExtension` fails and
sqlite-vec cannot load. This is exactly the trap ADR 014 already recorded.

---

## 4. Signing, notarization, updates

- **macOS**: Apple Developer Program $99/yr. Tauri notarizes implicitly once the env vars are set
  (`xcrun notarytool submit --wait` then `stapler staple`). Sidecars *are* signed automatically
  (inside-out, app last). Two structural gotchas: `bundle.resources` contents are **not** in the
  signing target list — the root cause of recurring *"code object is not signed at all"* failures,
  fixed by moving dylibs to `macOS.frameworks` — and **one entitlements file applies to every
  target**, so granting the Node sidecar `com.apple.security.cs.allow-jit` grants it to the main
  binary too. A V8-bearing sidecar needs that entitlement or it crashes under hardened runtime,
  plus `disable-library-validation` if it `dlopen`s anything signed by another Team ID (i.e. a
  prebuilt sqlite-vec or esbuild binary).
- 🔴 **[tauri#11992](https://github.com/tauri-apps/tauri/issues/11992) is open and untriaged**
  (filed 2024-12-17): with `externalBin` present, notarization fails *"The signature of the binary
  is invalid"* pointing at the **main app binary**; remove `externalBin` and it succeeds. No
  maintainer response. Prototype `tauri build --bundles dmg` with a real sidecar through real
  notarization before committing to this architecture.
- **Windows**: hardware/HSM key storage mandatory for OV *and* EV since 2023-06-01 (CA/B Forum).
  Azure Artifact Signing ~$9.99/mo, no hardware token, but no EV and geography-gated. **Tauri's
  own docs are stale in claiming EV grants instant SmartScreen reputation** — Microsoft says that
  behaviour ended in 2024 and reputation now builds identically for OV and EV over weeks.
- **Linux**: thin. AppImage GPG signing exists but Tauri notes the format does not validate it.
  `.deb` signing is undocumented. AppImage is the only friction-free Linux self-update path;
  deb/rpm updates need a privilege prompt.
- **Updater**: minisign/Ed25519, verification cannot be disabled. This is a **separate trust chain
  from OS code signing** — two private keys to escrow, and losing the minisign key permanently
  orphans every installed copy.

Floor budget, signed on both desktop OSes: **~$220/yr**.

---

## 5. Avoiding a Node runtime entirely

- **Deno compile** — `node:sqlite` supported since 2.2, and critically Deno *statically links its
  own SQLite* (rusqlite `bundled`), so it escapes Apple's extension-disabled build that breaks Bun.
  `--self-extracting` exists precisely for `dlopen`. ~64 MB. Unverified: nobody has documented
  loading a real sqlite-vec dylib through `node:sqlite` inside a compiled self-extracting binary,
  and the analogous FFI path is broken on Windows. **Moderate lift, spike required.**
- **Rust storage layer inside Tauri** — the one option where Tauri's size advantage survives,
  because nothing but the Tauri binary ships. sqlite-vec has an **official Rust crate that embeds
  the C source and links it statically** (`sqlite3_auto_extension` + rusqlite `bundled`), so every
  extension-loading problem above — Apple's OMIT_LOAD_EXTENSION, virtual-FS `dlopen`, per-platform
  dylib shipping and signing — disappears at once. Porting map: `hono`→`axum`, `ws`→
  `tokio-tungstenite`, `chokidar`→`notify`, MCP→`rmcp` (official Rust SDK). **esbuild has no Rust
  answer**: you would shell out to it, swap to a Rolldown/SWC bundler and rewrite plugin semantics,
  or keep a JS runtime just for plugin builds. Budget that separately from "rewrite storage".
  Note `tauri-plugin-sql` is the *wrong* vehicle (frontend→DB bridge over sqlx, no extension
  loading); the shape is rusqlite behind `#[tauri::command]`.
- **Embedded Node as a Rust library — not credible in 2026.** Node still has no supported C FFI
  for embedders ([nodejs/node#52289](https://github.com/nodejs/node/issues/52289), open since
  2024). `deno_core`/`rusty_v8` give V8 + ops, not Node compatibility. No known example of anyone
  shipping embedded full Node in a Rust desktop app.

---

## 6. Other Tauri facts worth keeping

- Latest stable `tauri` **2.11.5** (2026-07-01). No Tauri 3.
- Sidecar path resolution is `dirname(current_exe) + name`; the target triple is stripped at bundle
  time. `externalBin` lands in `Contents/MacOS/`, while `bundle.resources` lands in
  `Contents/Resources/` — a different directory, *and* unsigned (see §4).
- Spawning a sidecar needs an explicit scoped `shell:allow-execute` / `shell:allow-spawn` grant;
  `shell:default` only grants `allow-open`.
- **Do not set `useHttpsScheme: true`.** On macOS a secure origin cannot connect to
  `localhost`/`127.0.0.1` at all ([WebKit bug 171934](https://bugs.webkit.org/show_bug.cgi?id=171934),
  open since 2017), and `ws://` from an https page is blocked as mixed content. With the v2
  defaults, `ws://127.0.0.1:PORT` to the sidecar should work — verify on macOS. Fallback is
  `tauri-plugin-websocket`, which opens the socket in Rust.
- Service workers **cannot** register on `tauri://` on macOS
  ([tauri#13031](https://github.com/tauri-apps/tauri/issues/13031), closed as not planned). nooklet
  uses one for PWA precaching; inside Tauri that simply would not apply.
- **No meaningful cross-compilation** — a per-OS CI matrix is required. The Node sidecar *can*
  cross-build, but since the matrix exists anyway, build it in the same job.
- WebKitGTK lags less than its reputation: Ubuntu 24.04/26.04 both carry 2.52.3. Debian stable and
  older LTS are still a concern.
- Android WebView does **not** treat `http://tauri.localhost` as secure
  ([wry#1709](https://github.com/tauri-apps/wry/issues/1709), open), breaking service workers,
  SubtleCrypto and `navigator.locks` — relevant if Tauri mobile is ever considered instead of
  Capacitor.

---

## 7. Native apps: what a Swift/Kotlin rewrite would actually cost

Measured over `apps/web/src` + `packages/core/src`, classifying a file as platform-bound if it
imports Solid/CodeMirror or touches `document`/`window`/`navigator`/`HTMLElement`:

| | lines | what |
|---|---:|---|
| Platform-bound | ~7,200 | Solid components, CodeMirror integration, DOM/gesture handling |
| Portable pure TS | ~11,600 | parser, tokenizer, op log, HLC, fractional index, `applyOps`, sync client, command registry, keymap, trigger matching |

Two supporting facts: `@nooklet/core` has **exactly one** file with a Node dependency
(`sync/node-sqlite-driver.ts`, one implementation behind the `SqlDriver` seam) and otherwise
depends only on `date-fns` and `fractional-indexing`; and in `apps/web/src/commands`, **6 of 46**
source files import Solid. That is ADR 006's keys→ops seam paying off.

So a native app rewrites the **editor**, not the model — ~7k lines, of which `editor/` is 4k and is
the hard part. Four paths:

1. **Thin native client over the HTTP API.** Cheapest; reuses nothing, rewrites nothing, because
   the logic stays server-side. Cost: no offline, on the device most likely to be offline.
2. **Run the TS core on-device in a JS engine.** iOS ships JavaScriptCore as a system framework;
   Android can embed QuickJS/Hermes. Core, sync client and command registry run unmodified — the
   ~11,600 lines. SwiftUI/Compose does rendering and input only. Caveat to verify: third-party apps
   get interpreter-only JSC (no JIT).
3. **Port the core to Rust.** WASM for web, FFI for iOS, JNI for Android — one core, three UIs.
   Biggest lift: 11,600 tested lines, *plus* migrating the web client onto it.
4. **Kotlin Multiplatform.** Shares iOS+Android, not web.

Recommendation stands with ADR 005: Capacitor first, since an outliner is mostly text and lists and
the widget gap is small. The one thing that would justify (2) is **text input** — caret behaviour,
autocorrect, dictation, selection handles and IME in a webview on iOS, which matters more than
average for mixed Czech/English typing. If Capacitor's editing feel disappoints on a real device,
that is the signal, and (2) is cheap *because* the seam is already pure.

---

## 8. Still unverified

1. **WebKitGTK on Linux**: is `tauri://localhost` a secure context there, and does OPFS behave?
   The WebKit source reading is shared-WebCore and should hold, but WebKitGTK has historically
   gated features behind build flags. `isSecureContext` is a one-line check — do it.
2. **Older macOS.** §1's result is macOS 26.6. The Safari 16/17-era reports may still be accurate
   for those versions.
3. **`opfs-sahpool` specifically**, as opposed to the raw OPFS file §1 tested.
4. **Whether Bun's `Database.setCustomSQLite()` governs the `node:sqlite` path** as well as
   `bun:sqlite`.
5. **Azure Artifact Signing eligibility** ("3 years of org tax history") — widely repeated, not on
   any first-party page.
6. The Electron brief commissioned alongside this one (`utilityProcess` vs main-process hosting,
   asar unpacking of native deps, whether Electron's bundled Node enables SQLite extension
   loading). An early empirical probe did reproduce the asar gotcha: a packaged app failed with
   `Cannot find module 'sqlite-vec'` until unpacked.
