# 001 — Porting the core to Rust: one core for web, iOS, and Android

Proposal, 2026-09-11, against tree `76bedd8`. Status: **recommended against for now**, with a
named trigger condition in §9. Like the files in `docs/research/`, this is a dated record kept as
written rather than updated in place. No ADR follows it, because the recommendation is "not yet".

The question it answers: should `packages/core` (and some of what surrounds it) be rewritten in
Rust so that one compiled core serves the web client via WASM, an iOS app via FFI, and an Android
app via JNI — the architecture Automerge uses? `docs/research/10-desktop-packaging.md` §7 listed
this as path 3 of four ways to get a native app and did not cost it. This costs it.

---

## 0. The short answer

The port is technically more feasible than it was a year ago — §3 documents a real change in the
Rust/SQLite/WASM ecosystem that removes what used to be the blocking problem — and it is still
the wrong thing to do now, for a reason that has nothing to do with feasibility:

**Every benefit the port delivers is conditional on building native, non-webview UIs on iOS and
Android. Nothing else in the plan is waiting on it.** ADR 005 chose Capacitor; research/10 §7
measured that a native app rewrites the *editor* (~7,200 lines), not the model, and that the model
is already portable because `packages/core` has exactly one Node dependency behind a seam. So the
port's competition is not "do nothing" — it is research/10 §7's path 2, *run the TypeScript core
you already have inside JavaScriptCore or QuickJS on the device*, which costs approximately zero
and shares the same ~11,600 lines.

Against that, the port costs 3–6 months, adds a second toolchain and a cross-compilation CI
matrix to a repo whose entire setup is currently `pnpm install`, and produces no user-visible
change. The performance argument that usually justifies such a port does not survive contact with
this codebase's own measurements (§8).

There are two honest caveats to that "no". First, one sub-step — a Rust parser checked against the
existing 48-case corpus — has standalone value as a *conformance oracle* for the grammar, and it
is cheap. Second, the migration design in §4 and §5 is genuinely safe, so if the trigger in §9
fires, this document is the plan; it is not a "here be dragons" write-off. The objection is to the
sequencing, not to the engineering.

---

## 1. Scope boundary: what would actually move

### 1.1 Tier 1 — moves cleanly

These are pure functions over plain data with no I/O, no clock, no DOM. Every one has tests that
already run without a browser.

| File | lines | notes |
|---|---:|---|
| `packages/core/src/ids.ts` | 58 | `crypto.getRandomValues` → `getrandom`; process-global `lastMs`/`lastRand` becomes a `Mutex`/`Cell` |
| `packages/core/src/hlc.ts` | 112 | `Date.now()` already injectable (`new Hlc(id, undefined, now)`); fixed-width string format |
| `packages/core/src/model.ts` | 74 | enums and constants |
| `packages/core/src/blocks.ts` | 78 | |
| `packages/core/src/ops.ts` | 104 | discriminated union → Rust enum; this is the one place Rust is strictly nicer |
| `packages/core/src/sync/apply-ops.ts` | 638 | the write path; talks only to `SqlDriver` |
| `packages/core/src/sync/queries.ts` | 166 | |
| `packages/core/src/sync/schema.ts` | 111 | DDL string constants |
| `packages/core/src/sync/gc.ts` | 68 | |
| `packages/core/src/sync/types.ts` | 102 | |
| `packages/core/src/sync/text-merge.ts` | 239 | hand-rolled diff3, algorithmic, zero platform surface — the single lowest-risk file in the package |

`text-merge.ts` deserves a note: it is the most self-contained thing in the repo (pure, no
dependencies, its own tests, and per ADR 003 it is a v1.1 feature not on the critical path). If
you wanted a throwaway "can we even do this" exercise before committing to anything, that is the
file — but it is not the right *first* step, for reasons in §4.1.

### 1.2 Tier 2 — moves, but drags a platform assumption with it

This is where the brief's prior is too optimistic. These files look pure and are not.

**`packages/core/src/tokens.ts` (888 lines) and `refs.ts` (197) emit UTF-16 offsets.**
`tokens.ts` says so in its own type: *"0-based, half-open, UTF-16 code unit offset into the string
that was tokenized."* Those offsets are not decorative. `apps/web/src/editor/livePreview.ts` feeds
`token.start`/`token.end` straight into CodeMirror's `RangeSetBuilder`, and CodeMirror 6 document
positions are UTF-16 code units. Rust strings are UTF-8; the three natural Rust conventions are
byte offsets, `char` (scalar value) indices, or `encode_utf16()` indices — and only the last one
matches.

Corpus case 47 already contains the trap, which is a stroke of luck worth naming. Its content is:

```
Emoji tag #🎉party and text 😀 after, Czech: Příliš žluťoučký kůň, RTL: שלום #tag בעברית
```

and its expectation puts the `#🎉party` tag at `start: 10, end: 18`. That is UTF-16: `#` (1) +
🎉 (2, surrogate pair) + `party` (5) = 8. In UTF-8 bytes the same token is `10..20`; in Rust
`chars()` it is `10..17`. A Rust tokenizer gets this wrong by default and case 47 fails
immediately — good, but it means the Rust tokenizer must carry an un-idiomatic offset discipline
throughout, or convert at every boundary at a cost proportional to string length. This is a real
tax on the largest file in the package, and it is exactly the kind of thing that reads as a
detail in a proposal and becomes a month in practice.

**`packages/core/src/journal.ts` (93 lines) depends on `date-fns` for a reason that is not
cosmetic.** `DEFAULT_JOURNAL_TITLE_FORMAT = "MMM do, yyyy"` — the `do` token is an English
ordinal day ("10th"), which neither `chrono` nor `time` provides. Worse, the format string is
*user data*: `packages/server/src/importer/logseq.ts` reads `:journal/page-title-format` out of
the user's `config.edn` and treats it as a date-fns pattern. So the set of tokens you must
support is date-fns's vocabulary, not one of your choosing. Porting this means reimplementing a
subset of date-fns's formatter in Rust and then discovering which subset real Logseq configs use.
The pragmatic answer is to leave journal title *formatting* in TypeScript and move only
`dateToJournalDay`/`journalDayToDate`/`journalDayFromFileName`, which are plain arithmetic — but
that splits a 93-line file across two languages, which is its own kind of bad.

**`packages/core/src/page-name.ts` (65 lines) is 65 lines of Unicode identity.**

```ts
return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
```

This computes the page *key* — the thing that decides whether `[[Příliš]]` and `[[příliš]]` are
the same page. Rust's `unicode-normalization` and `str::to_lowercase` implement the same UAX
standards as V8, so they should agree, but "should agree" is not the standard for a function whose
divergence silently splits a user's page in two and produces two sets of backlinks. Additional
hazards: `\s` in JavaScript regex and `char::is_whitespace` in Rust do not cover identical sets;
`pageNameToFileName` uses `charCodeAt`, UTF-16 again. This file is 65 lines and deserves more
differential-testing attention than the 888-line tokenizer.

**Two regexes use lookahead** — `outline.ts:42-43`'s `MARKER_RE` and `PRIORITY_RE` both end in
`(?=\s|$)`. Rust's `regex` crate has no lookaround. Both are trivially rewritable as "match, then
check the following byte", and there are only two of them (I checked the whole package: no
backreferences, no lookbehind). But 86 regex call sites in non-test core code means 86 small
opportunities for silent semantic drift, and rewriting a regex is precisely where that hides.

### 1.3 Where I disagree with the brief

**The SQLite access layer is not a natural part of the core to port — it is the part where the
port is hardest and the payoff is least clear.** `packages/core/src/sync/driver.ts` is a 60-line
interface that exists *because* core must run on two runtimes with different SQLite bindings. Its
doc comment says so. Under a Rust core, `rusqlite` is the single implementation on server, iOS,
and Android, so the seam is deleted on three targets — and then has to be *recreated* on the
fourth (web), which is the one target where getting it wrong destroys data that is expensive to
recover. You do not "port `SqlDriver`"; you delete it three times and rebuild it once.

The load-bearing property of `SqlDriver` is that it is **synchronous**, and the whole client
architecture is built on that. `apps/web/src/db/worker-core.ts`'s header states the design
explicitly: `applyOps`/`rebuild` run inside the DB worker against a genuinely synchronous driver,
and *"core's sync contract is honored because it never crosses a `postMessage` boundary"*. Any
Rust design that makes the driver async — and several of the options in §3 do — forces
`applyOps` to become async, which is a change to the shape of the core, not a translation of it.

**The command registry and keymap should not move, and I do not think it is a close call — with
one exception.** `apps/web/src/commands/` is 4,300 lines and `apps/web/src/editor/commands.ts` +
`keydown.ts` + `tree.ts` is another ~750. They are genuinely pure and genuinely DOM-free (a real
achievement of ADR 006's keys→ops seam; `keydown.ts`'s header brags about it correctly). But:

1. Their inputs are shaped by a UI. `KeyDescriptor` is a normalized `KeyboardEvent`; `DispatchCtx`
   is a snapshot of `Surface.geometry()`. `commands/when/` (471 lines) is an expression compiler
   whose entire vocabulary is UI state. Pure is not the same as portable.
2. On the Capacitor path they buy nothing: the TypeScript already runs on the device.
3. `Command.run` closes over the UI. You would move resolution and not execution, and end up
   maintaining two registries that must agree — the exact failure mode ADR 009 exists to prevent.

The exception: **if you build native SwiftUI/Compose editors, keys→ops is the first thing you want
shared after the core.** So the rule is that this moves in the same decision that adopts native
UIs, never speculatively ahead of it.

### 1.4 What never moves

`packages/server/src/ops/` (4,245 lines — `defineOp`, Zod, Hono, OpenAPI, MCP), `plugins/` (1,902
— esbuild), `embeddings/` (1,598 — Ollama HTTP, sqlite-vec), the whole of `apps/web/src/editor/`,
`views/`, `app/`, `live/`, `shell/`. §7 explains why `ops/` in particular cannot move even in
principle, and what that costs.

### 1.5 The count, honestly

`packages/core/src` is 3,646 non-test lines, of which `node-sqlite-driver.ts` (136) is deleted
rather than ported. So the first-order target is **~3,510 lines of TypeScript**, not the 11,600
that research/10 §7 counted as "portable" — that larger figure includes the command registry and
sync client, which §1.3 argues stay. Equivalent Rust for this kind of code (explicit enums,
`match` arms, real error types, `serde` derives) typically runs 1.3–2× the line count, so
**~4,500–7,000 lines of Rust**, plus binding crates and the conformance harness of §5.

Note what that means for tests. `pnpm -r test` at `76bedd8` on 2026-09-11 passes **1,185 tests
across 117 files**: `packages/core` 260 in 14 files (3.08 s), `packages/plugin-api` 17 in 3,
`packages/server` 311 in 38, `apps/web` 597 in 62. The port puts **260 of those 1,185 directly at
risk** and indirectly threatens the rest, since everything else depends on core. §5 is about not
losing them.

---

## 2. Crate layout and how each target consumes it

### 2.1 Layout

```
crates/
  nooklet-core/           # ids, hlc, order, page-name, model, blocks, ops, outline,
                          # tokens, refs, text-merge, gc. No I/O. No binding attributes.
  nooklet-store/          # applyOps, rebuild, queries, schema — over a `Store` trait
  nooklet-store-rusqlite/ # the `Store` impl for native, and (option a, §3.3) for wasm
  nooklet-store-jsbridge/ # the `Store` impl over a synchronous JS callback (option d, §3.3)
  nooklet-wasm/           # #[wasm_bindgen] surface for the browser
  nooklet-ffi/            # #[uniffi::export] surface for Swift + Kotlin
  nooklet-node/           # napi-rs surface for the Node server — see §2.4
  nooklet-conformance/    # the differential harness of §5
```

The rule that matters: **no `#[wasm_bindgen]` and no `#[uniffi::export]` in `nooklet-core` or
`nooklet-store`.** Both macro systems constrain the type system in ways that would propagate —
UniFFI requires exported error types to be enums implementing `std::error::Error`
([UniFFI: Throwing errors](https://mozilla.github.io/uniffi-rs/latest/types/errors.html): *"your
error type (`E`) must be an `enum` and implement `std::error::Error` (thiserror works!)"*), and
wasm-bindgen pushes toward `JsValue` in signatures. Keeping the core attribute-free means it can
be tested with plain `cargo test`, fuzzed, and benchmarked without any binding toolchain present.

`Store` as a trait rather than a concrete `rusqlite::Connection` is worth keeping even though §1.3
notes the seam is deleted on three targets, for exactly one reason: the conformance harness in §5
wants an in-memory implementation it can dump and diff.

### 2.2 Web: wasm-bindgen

`wasm-bindgen` 0.2.128 (2026-09-04, [crates.io](https://crates.io/crates/wasm-bindgen)) is the
only real option and is not in question — 521 M total downloads, 5,204 dependent crates, and it is
what Automerge, Leptos, Dioxus, Yew and Bevy all sit on. Governance note worth knowing: the
rustwasm GitHub org was
[sunset in 2025](https://blog.rust-lang.org/inside-rust/2025/07/21/sunsetting-the-rustwasm-github-org/)
and wasm-bindgen moved to its own community-governed org rather than being archived with it. It is
still 0.2.x with roughly monthly releases, each carrying small breaking changes — plan on tracking
it, not pinning it forever.

`wasm-pack` v0.15.0 (2026-05-15) is fine but was revived rather than steadily maintained: it went
**15 months without a release** between 0.13.1 (2024-10-29) and 0.14.0 (2026-01-20), and moved
into the wasm-bindgen org under a single maintainer. `wasm-pack build --target bundler` producing
a workspace package that `apps/web` depends on is the conventional path; invoking
`wasm-bindgen-cli` directly from a build script is the escape hatch.

**The Vite integration is not free.** Automerge's own
[library-initialization docs](https://automerge.org/docs/reference/library-initialization/) tell
Vite users to add `vite-plugin-wasm` *and* `vite-plugin-top-level-await`, Webpack users to enable
`experiments.asyncWebAssembly`, and React Native users to set `unstable_enablePackageExports`.
Vite 8 does now document native `.wasm` ESM integration, but the docs never mention wasm-bindgen
and a directly-imported `.wasm` *"behaves as an async module and requires top-level `await`
support"* — whether that handles wasm-bindgen `--target bundler` output (with its circular
glue↔wasm imports) unaided is unverified (§10).

Either way this introduces a **build step in front of the innermost package**, which ADR 001
deliberately does not have today ("Package exports point at TypeScript source; consumers
transpile. A build step is added only when publishing"). See §6.3.

### 2.3 iOS and Android: UniFFI

**UniFFI 0.32.1** (2026-09-09, [crates.io](https://crates.io/crates/uniffi), Mozilla) is the right
choice over hand-written `swift-bridge` + `jni`. It has *"full support for Kotlin, Swift and
Python"*, and the alternatives thin out fast: `swift-bridge` is Swift-only (and had 14 commits in
the trailing year), `diplomat` is healthy and ICU4X-proven but **has no Swift backend** (open since
2022), `cxx` gets you to C++ not Swift, and the `jni` crate is a hand-written glue layer, not a
generator — still 0.2x, with 0.22.0 and 0.22.1 both yanked after a three-year gap.

One correction to the brief's framing: **proc-macros have not replaced UDL.** The guide says
*"UniFFI allows you to define your object model using both Procedural Macros and via stand-alone
UDL files. Each library can choose to use either or both"*, the tutorial is still UDL-shaped, and
the proc-macro chapter still carries *"This facility is relatively new, so things may change
often."* What is deprecated is UDL-*only* bindgen invocation; the supported path is library mode
(`uniffi-bindgen generate --library target/release/libfoo.so --language kotlin`). Use proc-macros,
but do not expect UDL to disappear.

- **Errors.** A Rust `Result<T, E>` becomes a Swift `throws` and a Kotlin exception directly.
  [The docs](https://mozilla.github.io/uniffi-rs/latest/types/errors.html): *"On the other side
  (Kotlin, Swift etc.), a proper exception will be thrown if `Result::is_err()` is `true`."*
  `thiserror` works. `anyhow::Error` does **not** work directly — *"You can't yet use `anyhow`
  directly in your exposed functions - you need a wrapper."* Practically: define one
  `#[derive(uniffi::Error, thiserror::Error)] pub enum NookletError` at the `nooklet-ffi` boundary
  and map internal errors into it. This is fine, and it is a second error type to maintain.
- **Async.** UniFFI converts `async fn` to native futures:
  [futures.md](https://mozilla.github.io/uniffi-rs/latest/futures.html) — Swift `async`/`await`,
  Kotlin `suspend fun`, and notably *"There's no requirement for a Rust event loop... the foreign
  bindings supply the executor"*, so no tokio is forced on you. The caveat that matters:
  *"We don't directly support cancellation in UniFFI even when the underlying platforms do."*
  For this app that is close to irrelevant — the core's operations are synchronous SQLite writes
  measured in microseconds, not cancellable network work — which is itself an argument for keeping
  the FFI surface synchronous and doing async (sync push/pull, Ollama calls) in Swift/Kotlin.
- **The JS exception mapping**, for symmetry: a `Result::Err` returned from a `#[wasm_bindgen]`
  function becomes a thrown JS exception when the error type implements `Into<JsValue>`. So the
  same `NookletError` enum needs a third representation for the web binding. Three bindings, three
  error mappings, one source of truth — workable, but it is not free and it is not generated.
- **The boundary serialises, and Mozilla says so.** UniFFI's founding
  [ADR-0002](https://github.com/mozilla/uniffi-rs/blob/main/docs/adr/0002-serialize-complex-datatypes.md):
  *"Serializing complex datatypes into a bytebuffer makes it easier for us to pass the data safely
  across the FFI… **This choice comes with non-trivial performance costs, but that's acceptable
  for MVP.**"* Integers, floats, bools and interface handles cross directly; **Strings, records,
  enums, `Option`, sequences and maps are serialised into a `RustBuffer`** in an ad-hoc
  big-endian format. The load-bearing sentence for API design:
  [*"When exposing traits for Records and Enums, the entire object copies across the FFI boundary
  on each method call—a significant performance consideration compared to Interfaces, which only
  copy a pointer."*](https://github.com/mozilla/uniffi-rs/blob/main/docs/manual/src/types/uniffi_traits.md)

  → **The single highest-leverage API-shape decision: model the graph handle, the store, and the
  editor state as UniFFI *Interfaces* (opaque, pointer-crossing), and let only small leaf values
  be Records.** A naive design that returns a page's whole block tree as a nested record
  serialises the entire tree on every call.
- **Pre-1.0, and the flagship consumer is on a git rev.** UniFFI's own docs describe *"frequent
  releases and non-trivial API churn"*, 0.29/0.31/0.32 each shipped breaking changes, and
  matrix-rust-sdk's `Cargo.toml` pins `uniffi = { git = "https://github.com/mozilla/uniffi-rs.git",
  rev = "e5f4821…", version = "0.31.0" }` rather than a crates.io release. They did that partly to
  carry [a patch disabling UniFFI checksums](https://github.com/matrix-org/matrix-rust-sdk/pull/6764),
  because those checksums *"consistently fail on Android in ARM 32bit devices"* — a bug that
  shipped as a black screen to Element X Android users. Budget for this.
- **Other constraints that shape the API:** no generics; all interfaces must be `Send + Sync` (so
  no `&mut self` methods, no `RefCell`); Android requires JNA ≥ 5.12; and **Kotlin object
  lifetimes are manual** — generated wrappers implement `Disposable`/`AutoCloseable` and
  *"must be explicitly called"*, with lists and maps **not** auto-closing their elements.
- **Who actually ships this.** Confirmed UniFFI users: the **Matrix Rust SDK / Element X** (whose
  `bindings/matrix-sdk-ffi/Cargo.toml` declares `crate-type = ["cdylib", "staticlib", "lib"]` with
  comments naming Android, iOS and JS/Wasm respectively — the same three-target shape this
  proposal describes), Mozilla application-services, Bitwarden (`sdk-internal`), and Firezone.
  **Signal's `libsignal` does not** — it hand-writes `rust/bridge/{ffi,jni,node}`.

**Automerge, the reference implementation in the brief, does not actually do "one interface, all
platforms" — and its binding layers visibly rot.** Its Rust workspace contains `automerge-wasm`
(wasm-bindgen, pinned to `wasm-bindgen = "= 0.2.127"`) *and* `automerge-c`. `automerge-swift` is
UniFFI: *"This package is implemented by wrapping the Rust library using the Uniffi framework from
Mozilla."* `automerge-java`, which the Android AAR is built from, is **JNI, not UniFFI**, and says
why — *"FFM is only available in Java 18 and later and this library targets Java 8 up"*. Four
binding layers, not one.

Three concrete costs visible from those repos, all of which would land on this project too:

- **The mobile artifacts are big.** automerge-swift 0.7.2's published
  `automergeFFI.xcframework.zip` is **54,278,033 bytes**; the static libs inside it are
  `libuniffi_automerge.a` at 15,612,960 B and a threaded variant at 15,765,774 B.
- **Cross-compilation is a matrix, not a step.** automerge-java's `HACKING.md` describes needing
  toolchains for **11 platforms** (Windows x86/x64, Linux x86/ARM, macOS x86/ARM, Android ABIs)
  plus a Docker image to cross-compile them, plus per-target CI workflows.
- **Bindings lag the core, badly.** The Rust `automerge` crate is at 0.11.0 (2026-08-12) and the
  core repo was pushed 2026-09-10; automerge-swift's latest release is **0.7.2, 2025-12-20**, with
  the repo last touched 2026-04-02, and automerge-java 2026-04-22. automerge-swift's own
  CONTRIBUTING warns that *"the binary in the generated XCFramework and the code in
  ./AutomergeUniffi are **tightly** coupled"*, so every core change forces a regenerate-and-retest
  cycle. That is what "one core, many bindings" actually looks like maintained by a funded team.

### 2.4 The fourth binding nobody asked for

This is the consequence I think the framing of the question misses.

ADR 008's entire value is that `defineOp` is *one* definition that emits HTTP routes, OpenAPI, MCP
tools, **and a typed client** — and the typed client is TypeScript type inference over Zod
schemas. Rust cannot produce that. Which means `packages/server/src/ops/` stays TypeScript. Which
means the op handlers stay TypeScript. Which means the server calls the Rust core *from Node*.

So "one core, three targets" is really **one core, four bindings**: wasm-bindgen (web), UniFFI
(iOS), UniFFI or JNI (Android), and `napi-rs` or WASI (Node). There are three ways out and none is
free:

1. **napi-rs.** A fourth binding crate, a fourth error mapping, and prebuilt native binaries per
   platform in the npm package — reintroducing exactly the native-module build pain that ADR 001
   cites `node:sqlite` as having removed.
2. **Run the same WASM artifact under Node.** One fewer binding, but the server then loses
   `rusqlite` and therefore loses the statically-linked `sqlite-vec` that research/10 §5 identified
   as the main native prize in the first place.
3. **`uniffi-bindgen-react-native`** ([jhugman](https://github.com/jhugman/uniffi-bindgen-react-native),
   Mozilla-co-funded, 0.31.0-5 of 2026-08-21) is the only tool that would genuinely collapse this:
   it generates **TypeScript** over a UniFFI interface for React Native (JSI), *plus* a WASM/web
   flavour *and* an N-API Node addon — one interface definition, a TypeScript surface on every
   target that needs one. It is also, in its own words, *"still in early development, and **should
   not yet be used in production**"*, pinned to UniFFI minor versions with bindings breaking
   across them. Worth tracking; not worth planning around today.

Note also that **UniFFI itself does not solve the web target.** Its
[WASM chapter](https://github.com/mozilla/uniffi-rs/blob/main/docs/manual/src/wasm/configuration.md)
is explicit: *"uniffi-rs does not come with bindings generators 'for WASM'. This is the job for
external uniffi-bindgen generators."* What it ships is a `wasm-unstable-single-threaded` feature
that *"opts out of the `Send` and `Sync` checks when building for `wasm32`"* — useful, but not a
binding generator. crates.io's "experimental WebAssembly compatibility" summary line refers to
this, and it is easy to misread as more than it is.

Pick any of the three and the "one core" story has a visible seam in it.

---

## 3. SQLite in each target

### 3.1 Server, iOS, Android

`rusqlite` 0.40.2 (2026-08-08, [crates.io](https://crates.io/crates/rusqlite)) with `bundled`,
which compiles SQLite from source and links it statically. `libsqlite3-sys`'s vendored
`sqlite3.h` on master declares `SQLITE_VERSION "3.53.4"`; the README text still says
*"3.53.2 (as of `rusqlite` 0.40.1 / `libsqlite3-sys` 0.38.1)"*, so pin the real number from your
own `Cargo.lock`. 3.53.4 is also what Node 26's `node:sqlite` bundles (research/10 §3), so the
server would not change SQLite versions at all — which is a genuinely nice property for a
migration whose oracle is "the two implementations produce identical tables".

This part is boring and that is the point. It is also where the port's one unambiguous technical
win lives: research/10 §5 already established that the `sqlite-vec` Rust crate embeds the C source
and registers via `sqlite3_auto_extension`, so Apple's `SQLITE_OMIT_LOAD_EXTENSION` build, dylib
shipping, per-platform signing and virtual-FS `dlopen` all evaporate at once. See §3.4.

### 3.2 Web: this got materially easier, and the brief's framing is out of date

The premise that "`rusqlite` cannot use OPFS" was true and is no longer the whole story.

**`rusqlite` builds for `wasm32-unknown-unknown` today, by default.** This landed in
[PR #1769](https://github.com/rusqlite/rusqlite/pull/1769), merged 2025-12-14 — *"The main diff is
to replace `libsqlite3-sys` with `sqlite-wasm-rs` on the wasm platform, while keeping everything
else unchanged"* — closing [#827](https://github.com/rusqlite/rusqlite/issues/827) ("Can't build
for wasm target"), which is the issue that made "rusqlite cannot do WASM" true until nine months
ago. The README: *"`ffi-sqlite-wasm-rs` switches to using the `sqlite-wasm-rs` crate (instead of
`libsqlite3-sys`) on `wasm32-unknown-unknown` builds. This is enabled by default."* rusqlite's own
`Connection` docs state the caveat plainly: *"The database is stored in memory by default.
Persistent VFS (Virtual File Systems) is optional."*

**`sqlite-wasm-rs` 0.5.5** ([crates.io](https://crates.io/crates/sqlite-wasm-rs), 2026-05-25;
[repo](https://github.com/Spxg/sqlite-wasm-rs)) provides three VFS backends: `memory` (default),
`sahpool` (OPFS `SyncAccessHandle` pool) and `relaxed-idb` (IndexedDB). Its README's comparison
table says `sahpool` requires a **Dedicated Worker**, needs **no COOP/COEP headers**, offers
**full durability**, and — like all three backends — supports **one connection only**. The sahpool
implementation lives in `sqlite-wasm-vfs` 0.2.0 and
[its docs](https://docs.rs/sqlite-wasm-vfs/latest/sqlite_wasm_vfs/) describe it as
*"opfs-sahpool vfs implementation, ported from sqlite-wasm"* — it pre-acquires all its
`createSyncAccessHandle()` promises during an `async install()`, then serves `xRead`/`xWrite`
synchronously, which is exactly the trick the official JS VFS uses and the only one that works.

Read that constraint list against `apps/web/src/db/`: dedicated worker (`db.worker.ts`), no
COOP/COEP (the explicit reason `sqlite-wasm-driver.ts` chose sahpool over the `opfs` VFS), one
connection per DB enforced by `navigator.locks` leader election (`LEADER_LOCK_NAME =
"nooklet-db-writer"`). **It is the same set of constraints, arrived at independently.** The design
the client already has is precisely the design `sqlite-wasm-rs` assumes.

Two caveats on this good news, both real:

- **rusqlite's own WASM CI runs under Node, not a browser** (`wasm-pack test --node`), so no
  first-party CI covers the OPFS path at all. The browser story is tested by `sqlite-wasm-rs`
  itself, one layer down.
- **`sqlite-wasm-rs` bundles SQLite 3.53.0**, versus 3.53.4 native. A deliberate version skew
  between the client replica and the server is new — today both sides run 3.53.4.

### 3.3 The options, and what each costs

| Option | Sync driver preserved? | New SQLite risk | Verdict |
|---|---|---|---|
| **(a)** Rust owns SQLite via `rusqlite` + `sqlite-wasm-rs` `sahpool` | yes | the replica's VFS changes implementation | the endgame |
| **(b)** Rust implements its own OPFS VFS from scratch | yes | reimplements ~1.5k lines of subtle, battle-tested JS | no |
| **(c)** Rust calls out to wa-sqlite / JS SQLite asynchronously | **no** | forces `applyOps` async | no |
| **(d)** Keep `@sqlite.org/sqlite-wasm` in JS; Rust calls a *synchronous* JS closure | yes | none | the wedge |
| **(e)** JSPI — suspend the WASM fiber on a JS Promise, from sync Rust | yes | none | not yet; see below |

Option **(c)** is dead for a structural reason worth recording: **wasm-bindgen offers no Asyncify
or JSPI-free way to call an async JS function from synchronous Rust.** wa-sqlite's own maintainer
says so in [discussion #154](https://github.com/rhashimoto/wa-sqlite/discussions/154) —
*"wasm-bindgen doesn't seem to provide an Asyncify or JSPI feature, which means it's difficult to
call asynchronous functions synchronously."* Async is viral; taking this option means `applyOps`
becomes `async fn` on every target including the server, which is a redesign, not a port.

Option **(e)** is genuinely new and worth knowing about, and it is not usable here yet.
wasm-bindgen 0.2.128 shipped experimental
[JSPI support](https://github.com/wasm-bindgen/wasm-bindgen/blob/main/guide/src/reference/jspi.md)
— *"lets Rust functions suspend the WASM fiber while a JS `Promise` resolves, then resume …
you can call fully Promise-based browser APIs from ordinary Rust code, with no `async` call chain
required"* — and there is [an official JSPI + OPFS example](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/examples/jspi-opfs)
doing precisely the thing that makes OPFS hard. The blocker is the support matrix that same page
publishes: Chrome 137+, Firefox 153+, **Safari Technology Preview 238** — i.e. not shipping
Safari. For an app whose primary mobile target is an iOS Home Screen PWA (ADR 005), a feature that
exists only in Safari TP is not a feature. Revisit when it ships in Safari proper.

Option **(d)** is underrated and is what step 4 of §4 should actually ship. The OO1 API that
`sqlite-wasm-driver.ts` already uses (`db.exec({sql, bind, rowMode, resultRows})`) is synchronous
inside the worker. A `#[wasm_bindgen] extern "C"` import of that closure is therefore *also*
synchronous, so a Rust `Store` impl that calls it preserves the sync contract with **zero new
SQLite risk on the one target where the local replica is hardest to recover**. The cost is
marshalling: every query crosses WASM↔JS as `JsValue`, and `rebuild()` over a 17.5k-block log is
thousands of round trips. That cost is measurable, which is the point — you measure it before
deciding whether (a) is worth doing.

Option **(a)** is where you end up, and it has one migration hazard worth stating: switching the
browser's SQLite implementation means the existing OPFS pool must be readable by the new stack.
`sqlite-wasm-vfs` says "ported from sqlite-wasm", which suggests the pool layout matches, but I
could not verify that the on-disk format is byte-compatible (§10). It does not actually matter,
because ADR 005 already settled it: *"The local database on a phone is a cache plus an outbox; the
server is the truth."* The migration is "delete the local replica, re-bootstrap from
`GET /sync/snapshot`" — an already-implemented, already-tested path. That is a genuinely
comfortable position to be in and it is worth noticing that the sync design bought it.

### 3.4 sqlite-vec

The official Rust crate is `sqlite-vec` ([crates.io](https://crates.io/crates/sqlite-vec)),
described as *"FFI bindings to the sqlite-vec SQLite extension"* — stable 0.1.9 (2026-03-31),
with 0.1.10-alpha.4 (2026-05-18) as the current head. research/10 §5's claim checks out exactly:
`build.rs` is a three-line `cc::Build::new().file("sqlite-vec.c").define("SQLITE_CORE", None)
.compile("sqlite_vec0")`, and registration is `sqlite3_auto_extension(Some(transmute(
sqlite3_vec_init as *const ())))`. Static linking, no dylib, no `dlopen`, no per-platform signing.

**Under WASM this is a non-issue for nooklet, and that deserves to be said rather than hand-wrung
over.** ADR 010 is explicit: *"Embeddings never sync to devices; semantic search is an API/MCP
call."* The `vec0` tables are server-only, so the browser never needs the extension. For the
record, if it ever did: sqlite-vec's own docs state *"It's not possible to dynamically load a
SQLite extension into a WASM build of SQLite"* — it must be statically compiled in, which rules
it out under option (d) entirely. A crate for that exists (`sqlite-wasm-vec` 0.1.3) but at 337
downloads, last published 2025-12-17, with dev-deps pinned to `rusqlite 0.38`, it is not something
to plan around.

One thing this section *should* raise as a risk to the existing design rather than to the port:
**the `sqlite-vec` upstream repo has had no commits since 2026-05-18** and carries 204 open
issues, with 0.1.9 (2026-03-31) still the last non-prerelease. The server depends on it today
(`packages/server/package.json`: `"sqlite-vec": "^0.1.9"`). That is worth watching independently
of anything in this proposal.

### 3.5 Threading: a non-problem, for a specific reason

Rust→WASM threading is normally the hairiest part of shipping Rust to the browser, and the price
is steep. `std::thread::spawn` **panics** on `wasm32-unknown-unknown`
([platform support docs](https://doc.rust-lang.org/nightly/rustc/platform-support/wasm32-unknown-unknown.html)).
Enabling real threads requires `-C target-feature=+atomics,+bulk-memory,+mutable-globals`, a
**nightly** toolchain with unstable `-Zbuild-std` (Rust ships no threaded precompiled std for this
target), `-Clink-arg=--export=__heap_base` since wasm-bindgen 0.2.122, `--target web`/`no-modules`,
`SharedArrayBuffer` and therefore COOP/COEP cross-origin isolation — and `wasm-bindgen-rayon`,
the standard way to do it, has not had a release since **1.3.0 on 2024-12-21**.

**None of that applies here, and the reason is structural rather than lucky.** The client is
already **one writer worker, one SQLite connection, elected by `navigator.locks`**.
`sqlite-wasm-rs` states it is *"not thread-safe"* (compiled `-DSQLITE_THREADSAFE=0`; `JsValue` is
not cross-thread) — which is exactly the model the client has. So: no shared memory, no
cross-origin isolation, no COOP/COEP headers imposed on every self-hosted install, and **no
nightly Rust**. The same reasoning that made `opfs-sahpool` the right VFS (research/08 §1.3) makes
single-threaded stable WASM the right target. This is the one place where the port's constraints
and the existing design agree for free, and it should be protected: adopting threads later would
re-import the entire COOP/COEP problem that `opfs-sahpool` was chosen to avoid.

---

## 4. Migration: a strangler fig with an abandonment option at every step

1,185 tests pass today and every milestone M0–M6 is done. A migration that breaks that for a
month is not worth any amount of architectural purity. The sequence below has one governing rule:
**every step must be independently shippable *and* independently abandonable.** If you stop after
step 2, you have not wasted the work; you have a conformance oracle (§5) and a parser you can
delete.

### 4.1 Step 1 — the parser and tokenizer, as a conformance spike (not a replacement)

**The first wedge is `outline.ts` + `tokens.ts` + `refs.ts` (~1,505 lines) checked against
`docs/spec/corpus/`.** Nothing ships. The exit criterion is agreement, not deployment.

Why this is the right wedge, in order of importance:

1. **The corpus is already a language-neutral conformance suite.** `docs/spec/corpus/` holds 48
   `NN-slug.md` inputs paired with 48 `NN-slug.expected.json` expectations. `corpus.test.ts` reads
   them with `readFileSync`. A Rust test that reads the same two directories is ~80 lines of
   `serde_json` + `std::fs`. **Zero fixture work.** This is unusual and it is the single biggest
   reason the port is safer here than in most codebases — the spec was written as data.
2. It is pure: string in, tree out. No clock, no randomness, no I/O, no persistence.
3. It surfaces the UTF-16 problem (§1.2) on day one via case 47, which is the thing you most want
   to learn before committing.
4. It is bounded and it fails loudly. If Rust cannot match 48 hand-written cases plus the real
   graph, you learn that in weeks, for the price of weeks.

Exit criteria, both required:

- Rust `parse_outline`/`tokenize_content`/`classify_block_content` agrees with the 48
  `.expected.json` files, including the `tokens` field on cases 35–47 and `blockContent` on 48.
- A differential run over the user's real graphs (2,725 files at
  `~/notes-graph`, 1,202 at the DB mirror) produces zero mismatches between
  TS `parseOutline` and Rust, compared as canonical JSON.

A provenance constraint carries over from `markdown-grammar.md` §9, which was careful to state
that the real graphs were only ever counted, never read into the repo. A differential *run* copies
nothing; but a mismatch reproducer would. So the rule is: minimise any mismatch to a synthetic
case by hand before committing it as corpus case 49+.

### 4.2 Steps 2–5

**Step 2 — op-log primitives + the replay harness.** `ids.ts`, `hlc.ts`, `order.ts`,
`page-name.ts` (~250 lines), plus the record-and-replay machinery of §5.2. Small code, high
stakes: these four files decide whether two devices agree on identity and ordering. Deliverable is
the harness as much as the code.

Order keys need a specific callout: `order.ts` wraps the npm `fractional-indexing` package
(Greenspan's base-62 algorithm). Sibling ordering only converges if Rust generates **byte-identical**
keys. The `fractional_index` crate exists (2.0.2) but its crates.io metadata claims no JS
compatibility and I could not verify the algorithm matches (§10). Budget for reimplementing
`generateKeyBetween`/`generateNKeysBetween` against the npm package as the oracle, not for
adopting a crate.

**Step 3 — `applyOps`/`rebuild` over `rusqlite`, on the server only, behind a flag.** The server
is the right first home: it has backups (M6), it can dual-run both implementations and compare on
every request, and a bug there does not destroy anyone's only copy. The oracle is free: ADR 003
already requires `rebuild()` to reproduce state from the log, and the plan already runs that parity
check on server start in dev. Run it twice — once per implementation — and diff.

**Step 4 — the web client, via option (d).** Replace `@nooklet/core` inside `db.worker.ts` with
the WASM core, keeping `@sqlite.org/sqlite-wasm` as a synchronous JS callback. This is the step
that actually deletes TypeScript. Measure the marshalling cost here and decide about option (a).

**Step 5 — iOS/Android via UniFFI.** Only meaningful once the decision to build native UIs has
been made independently. Concretely, following what Mozilla and Element both do (§6.3): a separate
repo producing tagged artifacts — per-target staticlibs → `lipo` the simulator arches →
`uniffi-bindgen` Swift + `module.modulemap` → `xcodebuild -create-xcframework` → zip consumed via
an SPM `binaryTarget` with a pinned checksum; and `cargo ndk -o jniLibs build` → AAR → Maven.
Note that this step is the *small* part of a native app: research/10 §7 measured the editor at
~7,200 lines and `editor/` alone at 4,000, none of which this port touches.

### 4.3 The rule that keeps it honest

During the migration **TypeScript is the oracle**. If the two disagree, Rust is wrong — even when
Rust is arguably more correct. Any intentional behaviour change is made in TypeScript first and
the fixtures regenerated. This costs you: you cannot fix a TS bug by writing better Rust. It is
still the right rule, because the alternative is two implementations drifting by intent, which is
indistinguishable from drifting by accident.

---

## 5. Keeping the existing tests honest

This is the section that decides whether the port is safe, so it gets the most detail. The good
news is that two accidents of the existing design — the corpus being file-based data, and ops
being serialisable by construction — make cross-language conformance far cheaper here than it
usually is.

There is **no purpose-built tool** for Rust↔TypeScript differential testing. The established
pattern everywhere is the same: a language-neutral fixture corpus in the repo, one runner per
language. The three good models to copy from are
[CommonMark's spec tests](https://github.com/commonmark/commonmark-spec) (examples embedded in
`spec.txt`, `--dump-tests` emits JSON, any implementation runs as a subprocess), the
[JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) (a pure JSON
fixture tree consumed by implementations in a dozen languages), and
[tree-sitter's corpus tests](https://tree-sitter.github.io/tree-sitter/creating-parsers/5-writing-tests.html)
— whose `tree-sitter test -u` "re-bless the expected output after a deliberate grammar change"
affordance is the one feature this repo's corpus does not have and should acquire (§5.1).

And a cautionary one. **Automerge — the model this proposal is named after — does not have
automated cross-implementation conformance testing.** Its
[`interop/`](https://github.com/automerge/automerge/tree/main/interop) directory contains exactly
one binary fixture plus a README documenting the values it should decode to; a repo-wide search
for `exemplar` returns only that README. Whatever confidence Automerge has that its Rust core
behaves identically through four bindings, it does not come from a conformance suite. Do not
inherit that.

### 5.1 The corpus is already the conformance suite

No new fixture format. `crates/nooklet-core/tests/corpus.rs` resolves
`CARGO_MANIFEST_DIR/../../docs/spec/corpus`, globs `*.md`, and for each one parses and compares
against the sibling `.expected.json`.

Compare **structurally, not textually**. Define one Rust type with both `Serialize` and
`Deserialize`, deserialise the expectation into it, serialise the Rust parse output into it, and
compare the values:

```rust
#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct ExpectedBlock {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    content: String,
    marker: Option<TaskMarker>,
    priority: Option<Priority>,
    properties: BTreeMap<String, String>,
    collapsed: bool,
    children: Vec<ExpectedBlock>,
}
```

That sidesteps every JSON-representation question at once — `id?: string` absent-vs-null, key
ordering in `properties` (vitest's `toEqual` is order-insensitive; a string comparison would not
be), and number formatting. `BTreeMap` rather than `HashMap` so failure output is deterministic.

The `tokens` field (cases 35–47) and `blockContent` (case 48) must be checked too, not skipped —
they are where the UTF-16 discipline of §1.2 is actually enforced. Note that `corpus.test.ts`
currently skips them, deferring to when `tokens.ts` landed; it has since landed, so **the TS
corpus test is itself behind its own spec** and should be brought up to check `tokens`/
`blockContent` *before* a Rust implementation is compared against it. Fixing that is worth doing
whether or not the port happens.

Both suites must also run the round-trip idempotence check the corpus test already does
(`parse(serialize(parse(x))) == parse(x)`), which catches a whole class of serializer drift for
free.

One addition worth making to the corpus *before* any Rust exists: a **`--bless` mode**, following
tree-sitter's `test -u`. Today, changing the grammar means hand-editing 48 `.expected.json` files;
with two implementations it means hand-editing them and then convincing yourself the other side
agrees. `UPDATE_CORPUS=1 pnpm --filter @nooklet/core test` regenerating the expectations from the
TypeScript implementation, with the diff reviewed in the PR, makes the corpus maintainable at two
implementations instead of merely survivable at one. It is also a load-bearing part of §4.3's
"TypeScript is the oracle" rule: blessing must only ever be possible from the oracle side.

### 5.2 The property tests: one generator, two evaluators

`packages/core/src/sync/sync.property.test.ts` is 1,009 lines and is the crown jewel. It is also
the hard case, because its generator does not produce static data: `fast-check` produces *seeds*
(`blockSeed`, `parentSeed`, …) which `runScenarioBody` resolves against each simulated device's
live state. There is no fixture to hand to Rust.

The tempting answer — reimplement the generator in `proptest` 1.11.0 — is wrong, and it is wrong
in a way that is easy to miss. Two independently written generators explore two different spaces,
so "both implementations pass their own property tests" proves nothing about equivalence. You
would have built a very expensive way to feel safe.

It is also wrong for a second, more mechanical reason. Both frameworks replay from a **seed**:
`fast-check` reports `seed` + `path` for manual replay, and `proptest` goes further by
[persisting failures automatically](https://proptest-rs.github.io/proptest/proptest/failure-persistence.html)
into a `proptest-regressions/` file that *"should be checked into version control"* — but it
persists *"the **seed** that was used to produce the failing test case"*, not the case itself.
Seeds are meaningless across implementations. So even proptest's best feature gives you nothing
at the boundary; the artifact that crosses languages has to be the concrete data.

**The right answer is: one generator, two evaluators.** And the existing test already contains the
insight that makes it cheap — assertion (b):

```ts
// (b) rebuild() from each device's own op log, into a *fresh* database, reproduces that
// device's converged state
const fresh = newDriver();
rebuild(fresh, [...d.log.values()]);
expect(dumpState(fresh)).toEqual(dumpState(d.driver));
```

Because the converged state is already proven to be a pure function of the merged op log, **Rust
never has to simulate devices, partitions, HLC receipt, or the drift guard.** It needs exactly one
entry point: `rebuild(store, ops) -> state`. All the multi-device machinery stays in TypeScript,
where it works.

Concretely:

1. Add a recording mode to `runScenarioBody`, gated on an env var so the normal test run is
   unchanged. After the final `syncAll`, write one JSON file per scenario:

   ```json
   {
     "seed": "<fast-check seed + path, for replaying the TS side exactly>",
     "deviceCount": 3,
     "ops": [ /* every Op any device authored, in authored order */ ],
     "expected": {
       "pages": [...], "blocks": [...], "blockProps": [...], "pageProps": [...],
       "opStatus": [{ "id": "...", "status": "applied" }, ...]
     }
   }
   ```

   `ops` is exactly `[...merged.values()]`; `expected` is `dumpState()` plus the `op` table's
   status column (assertion (c) already reads it). Ops are plain JSON by construction — ADR 003's
   "ops are data" pays off here in a way it was not designed for.

2. `crates/nooklet-conformance/tests/sync_replay.rs` reads each file, calls `rebuild`, dumps state
   in the same canonical shape, and asserts equality. ~80 lines.

3. **Two corpora, two jobs.** A frozen set (a few hundred scenarios under
   `crates/nooklet-conformance/fixtures/`) is the checked-in regression suite, regenerated only by
   a deliberate `pnpm regen:conformance` whose diff is reviewed. A freshly generated set, produced
   by the TS job in CI and handed to the Rust job as an artifact, is the fuzzing layer — new
   scenarios every run, so coverage keeps growing without the repo growing.

4. **Canonicalisation is the whole game.** `dumpState()` is `SELECT * FROM page ORDER BY id` and
   three siblings — already deterministic, already the right shape. The hazards are numeric:
   SQLite `INTEGER` arrives in JS as `number` and in Rust as `i64`; `RunResult.lastInsertRowid` is
   typed `number | bigint`; epoch-millisecond timestamps are exact in `f64` but will not survive a
   naive `serde_json` float round-trip if anything casts. Serialise integers as JSON integers on
   both sides and assert on `serde_json::Value`, not on formatted strings.

5. **Shrinking across the boundary.** When Rust disagrees you hold a concrete op list, not a seed,
   and `proptest`'s shrinker cannot help — it only shrinks values it generated. Write a greedy
   delta-debugger over the op list (~100 lines): repeatedly drop an op or a contiguous run and
   re-check whether the disagreement persists. One caveat makes it non-trivial: ops have
   referential dependencies, so a minimiser must never drop an op whose entity is referenced by a
   retained op's `place.pageId`/`parentId`, or it will "minimise" into a scenario that means
   something else. Write this before you need it; you will need it at 3 a.m.

6. Once Rust is primary, flip the polarity: `proptest` becomes the generator and the recorded
   scenarios feed the TypeScript side, until the TypeScript side is retired.

### 5.3 `rebuild()` as a free production-data oracle

The best conformance test in this design costs almost nothing and uses real data. ADR 003 already
mandates that state tables are a pure function of the op log, and the plan already runs a
`rebuild()` parity check on server start in dev. Run it against both implementations from the
*same* real op log and diff the dumps. This exercises the user's actual 17.5k-block graph, with
its actual Czech page names and actual emoji, on every dev server start, with no fixture, no
generator, and no maintenance. It is strictly better evidence than any synthetic corpus and it
should be wired up in step 3.

### 5.4 What differential testing cannot cover, stated plainly

- **`newId()`** calls `crypto.getRandomValues` and is nondeterministic by design. Test the format,
  the 45-bit time prefix, and the same-millisecond monotonic bump — never equality.
- **`Hlc`** reads `Date.now()`. The TS tests already inject a clock (`new Hlc(id, undefined, now)`);
  the Rust API must offer the same injection or it is untestable in this scheme.
- **`journal.ts`'s date-fns formatting** (§1.2) has no Rust counterpart to diff against. It needs
  its own hand-written table of (pattern, date) → expected string, seeded from real Logseq
  `config.edn` values.
- **`normalizePageName`'s `toLowerCase()`** (§1.2) has no fixture that will find the disagreements
  that matter. The only real test is running both over every page name in both real graphs and
  asserting the key sets are identical — which is cheap, and which step 1's differential run gets
  almost for free.
- **The 86 regex sites.** Nothing about a corpus tells you that a rewritten regex differs on an
  input nobody wrote down. The mitigation is the real-graph differential run, not more unit tests.

---

## 6. Cost

Ranges, with the reasoning attached. Throughput assumed is the same one-developer-directing-agents
rate that produced M0–M6.

### 6.1 Lines

~3,510 TypeScript lines in scope (§1.5) → ~4,500–7,000 Rust, plus ~500–1,000 lines of binding
crates (three or four of them, §2.4) and ~500 lines of conformance harness (§5). Call it
**5,500–8,500 lines of new Rust** to reach behavioural parity with code that already works.

### 6.2 Time

| Step | Scope | Estimate |
|---|---|---|
| 1 | parser + tokenizer + refs, corpus conformance, real-graph diff | 3–6 weeks |
| 2 | primitives (ids/hlc/order/page-name) + record-replay harness | 2–3 weeks |
| 3 | `applyOps`/`rebuild` over `rusqlite`, server dual-run behind a flag | 4–8 weeks |
| 4 | web client on the WASM core (option d), replacing `@nooklet/core` in the worker | 4–8 weeks |
| 5 | UniFFI, XCFramework, cargo-ndk, CI matrix — *excluding the native UI* | 4–8 weeks |

Steps 1–4 — the point at which the web client runs on the Rust core and nothing else has changed —
is **3–6 months**. Step 5 adds 1–2 months and is worthless without the ~7,200-line native editor
that research/10 §7 priced separately.

The wide ranges are honest: the biggest single unknown is how much of the 888-line tokenizer's
UTF-16 discipline has to be carried by hand versus wrapped, and that is exactly what step 1 is
designed to find out cheaply.

### 6.3 Ongoing

- **Two toolchains.** There is currently **no Rust toolchain on this machine** (`cargo` and
  `rustc` are not on `PATH`). Today the setup is `pnpm install` and `pnpm test`; core's 260 tests
  run in 3.08 s. After the port, every contributor and every coding agent needs `rustup`, the
  `wasm32-unknown-unknown` target, `wasm-bindgen-cli`/`wasm-pack`, and — for step 5 — Xcode command
  line tools, the Android NDK, and `cargo-ndk`.
- **CI matrix, with real timings.** research/10 §6 already noted Tauri has "no meaningful
  cross-compilation"; the same is true here. Native (3 OS) × wasm32 × iOS device + simulator ×
  Android ABIs, plus `cargo clippy`, `cargo fmt`, and a `cargo audit` that Biome does not cover.
  Measured from matrix-rust-sdk's public GitHub Actions runs, **with warm `Swatinem/rust-cache`**:
  the Android 4-ABI matrix is 11m19s–11m49s *per ABI* and **18m20s wall clock** including AAR
  assembly; a single `aarch64-apple-ios` dev build is **8m12s**, and the full Apple XCFramework
  **12m49s**. Mozilla's own application-services build docs warn that *"the initial setup is likely
  to take a number of hours to complete."* Today `pnpm -r test` runs 1,185 tests in well under a
  minute.
- **The structural mitigation, which both Mozilla and Element independently arrived at: put the
  Rust build in a separate repo and consume tagged, checksummed prebuilt artifacts** — an
  XCFramework zip via an SPM `binaryTarget`, an AAR via Maven. Element X iOS's app CI never runs
  `cargo` at all. That works, and it means the "one core" is operationally a *vendored third-party
  dependency you also happen to maintain*, with its own release cadence and version skew. For a
  one-person project that is a second project, not a subdirectory.
- **A build step in front of the innermost package.** ADR 001 chose "package exports point at
  TypeScript source; consumers transpile. A build step is added only when publishing." A Rust
  `@nooklet/core` inverts that for the package everything else depends on. `tsx src/cli.ts` and
  Vitest's watch mode both become "rebuild the WASM first".
- **Debugging across the boundary.** A Rust panic in WASM is an unhelpful `unreachable` trap
  without `console_error_panic_hook` plus DWARF-in-wasm source maps. Under UniFFI, a panic becomes
  an opaque foreign exception unless explicitly mapped. Both are solvable and both are worse than
  a V8 stack trace.
- **Dependency churn on three pre-1.0 things at once.** `wasm-bindgen` is 0.2.x with roughly
  monthly breaking-ish releases; UniFFI is pre-1.0 with *"frequent releases and non-trivial API
  churn"* and an open, untimelined *"Design and agree on a 1.0 FFI"* issue; `sqlite-wasm-rs` is
  0.5.x with one maintainer. Today the equivalent surface is `date-fns` and `fractional-indexing`,
  both stable and boring. ADR 001's rule was "pin majors, bounded migrations" — that rule is much
  more expensive to honour against three moving 0.x dependencies in the innermost package.
- **Agent-directed development gets slower.** The project was built by directing coding agents
  through a single language with a single test command. Every change to core behaviour now spans
  two languages with a conformance gate between them, and the gate is the point — it cannot be
  skipped for speed.

### 6.4 Bundle size, measured

Built at `76bedd8` with `pnpm build` in `apps/web` (Vite 8.3.0, 2026-09-11):

| Artifact | raw | gzip |
|---|---:|---:|
| `sqlite3-*.wasm` (official `@sqlite.org/sqlite-wasm` 3.53.4) | 868.90 kB | 407.46 kB |
| `db.worker-*.js` (core + sqlite glue + Comlink + sync client) | 247.74 kB | — |
| `index-*.js` (Solid + CM6 + core + commands + views) | 515.76 kB | 166.97 kB |
| PWA precache total | 1,870.89 KiB | — |

And `@nooklet/core` alone, bundled and minified with the repo's own esbuild:
**78.6 kB raw / 22.3 kB gzip**.

Two things follow, and they point in opposite directions.

**The usual "WASM bloats the bundle" objection is weaker here than it looks**, because the app
already ships an 869 kB SQLite WASM binary. Under option (a) the Rust artifact *replaces* it
rather than adding to it, and also deletes ~78.6 kB of core JS. The net could plausibly be neutral.

**But Rust WASM artifacts for nontrivial libraries are large.** Published reference points, all
measured from the actual published artifacts:

| Artifact | `*_bg.wasm` |
|---|---:|
| wasm-bindgen `add(a, b)` example, after `wasm-opt -Os` | 172 B |
| rustwasm book's Game of Life, `lto` + `opt-level="z"` + `wasm-opt -Oz` | 17,317 B (9,045 gzip) |
| `ywasm` 0.27.4 (Y-CRDT Rust core) | 983,030 B |
| `@automerge/automerge-wasm` 1.0.0-preview.0 (web) | 2,125,742 B (720,739 gzip, 530,472 brotli) |
| `@automerge/automerge` 3.4.1 | 3,571,259 B |
| `@swc/wasm-web` 1.16.2 | 20,246,940 B |
| `@biomejs/wasm-web` 2.5.13 | 44,645,975 B |

`ywasm` is the fairest comparison — a CRDT core of roughly nooklet-core's ambition, at ~983 kB,
in the same order as the 869 kB SQLite WASM already being shipped. Automerge at 2.1–3.6 MB is the
pessimistic end and does not contain SQLite. (The two Automerge figures are not a like-for-like
series; I did not determine why they differ.)

Measure the right thing: wasm-bindgen's own
[size guide](https://wasm-bindgen.github.io/wasm-bindgen/reference/optimize-size.html) warns that
*"the output of the compiler … is not optimized for size and you should not measure it"* — measure
the post-`wasm-bindgen` `*_bg.wasm`. Note also that **`wasm-snip` and `twiggy` are both archived**;
the surviving tool is `wasm-opt`/Binaryen (version_132, 2026-08-12), which `wasm-pack` runs by
default on release builds. No source publishes isolated per-flag savings for `panic=abort` or
`opt-level="z"` vs `"s"`, so do not put such percentages in a plan — measure your own crate.

The conclusion is not a number — it is that **this is measurable in step 1 and should not be
argued about beforehand.** Build a Rust WASM containing just the tokenizer and parser with those
flags and read the file size. That number decides §6.4, and it costs a day.

### 6.5 Mobile artifact size, measured

Only relevant under step 5, but worth having the real numbers rather than a shrug. Measured from
the shipped `matrix-android-sdk.aar` (tag `sdk-v26.09.9`, 2026-09-09), stripped ELF:

| Artifact | arm64-v8a | armeabi-v7a |
|---|---:|---:|
| `libmatrix_sdk_ffi.so` (Matrix SDK: crypto + SQLite + TLS + sync) | 60.5 MiB | 39.8 MiB |
| `libuniffi_wysiwyg_composer.so` (Element's rich-text editor core — no network, no crypto, no DB) | **2.97 MiB** | **1.94 MiB** |

**The second row is the honest reference point for nooklet's core**, and it is reassuring: a
self-contained UniFFI Rust core of comparable ambition costs ~2–3 MiB per ABI. The first row is
what you get when the core also owns networking, crypto and a database — which, under option (a),
nooklet's would.

Three details that bite:

- **The `.so` is stored uncompressed in the APK.** 16 KB page alignment requires it, so a native
  library contributes its *full* size to the user's download, not a compressed fraction.
- **Apple caps the total of all `__TEXT` sections at 80 MB.** Static archives dead-strip at link
  time, so a 294 MiB `.a` is not a 294 MiB app — but the ceiling is real and Matrix hit an App
  Store *"exceeds the cellular network download size limit"* warning.
- **Play does not require `armeabi-v7a`.** The only rule is that each 32-bit architecture you ship
  must have a 64-bit counterpart, so `arm64-v8a` alone is compliant — one ABI, not four. The
  16 KB page-size requirement bites 2027-02-01 and needs NDK r28+.

Matrix's own size profiles are worth copying verbatim rather than cargo-culting `opt-level="z"`:
`opt-level = "s"` measured *"~33% smaller linked code"* for their XCFramework, and adding
`lto = true` + `strip = "debuginfo"` for Android was *"almost halving the size"*. They deliberately
do **not** strip on iOS, so Xcode can build the `.dSYM` for crash symbolication.

---

## 7. What you give up

Being adversarial about my own proposal, worst first.

1. **`defineOp`'s type inference, and therefore the whole API layer.** Already argued in §2.4 and
   it is the deepest problem. ADR 008's payoff is one definition producing HTTP + OpenAPI + MCP
   tools + a *typed client*, and the typed client is Zod schema inference. Rust cannot do this;
   `ts-rs`/`specta` generate types from Rust, which is a generation step producing a strictly
   weaker result than inference producing it for free. So 4,245 lines of `packages/server/src/ops/`
   stay TypeScript, the handlers stay TypeScript, and the server acquires a Node↔Rust FFI. "One
   core" becomes "one core, four bindings".
2. **esbuild-based plugin bundling has no Rust answer.** research/10 §5 already recorded this:
   *"esbuild has no Rust answer: you would shell out to it, swap to a Rolldown/SWC bundler and
   rewrite plugin semantics, or keep a JS runtime just for plugin builds."* ADR 007 makes plugins
   TypeScript ES modules bundled at runtime and `import()`ed. A Rust core does not change that —
   which means the server keeps a JS runtime forever, which removes the "drop Node entirely" prize
   that made a Rust storage layer attractive in the first place.
3. **`date-fns` timezone and format handling.** §1.2. The format string is user data read from
   Logseq's `config.edn`, so the compatibility target is date-fns's token vocabulary, not a
   vocabulary you choose. The likely outcome is journal title formatting staying in TypeScript and
   `journal.ts` living in two languages.
4. **Developer iteration speed.** `tsx src/cli.ts serve` runs the server with no build. `vitest`
   watches and re-runs 260 core tests in 3 s. Both become "cargo build, wasm-bindgen, then that" —
   seconds, not milliseconds, on the innermost dependency, every time.
5. **A second language for everyone touching the model.** Including the coding agents that built
   this. This is not a small thing when the model is where all the interesting bugs live.
6. **Two implementations of the grammar to keep in sync during the transition** — which §4.3's
   "TypeScript is the oracle" rule manages but does not eliminate. Every grammar change is now
   double work plus a fixture regeneration for however long the transition lasts, and transitions
   like this historically last longer than planned.
7. **A permanent per-environment packaging tax.** Automerge shipped an entire release
   ([Automerge Anywhere](https://automerge.org/blog/automerge-anywhere/), 2024-08) to deal with
   this, and put it bluntly: *"native browser support for WebAssembly modules has remained quite a
   subtle art: different runtimes, package managers, bundlers, and browsers have all settled on
   different approaches and have different constraints. **It's a real mess out there.**"* Their
   answer was a `/slim` entrypoint with manual `initializeWasm()`, plus a base64 fallback that is
   *"somewhat slower and large than a binary object but it's available as the ultimate fallback"*,
   plus a documented matrix of workarounds for Webpack, Vite, Deno, Cloudflare Workers, and Metro.
   nooklet ships a Vite PWA, a Capacitor webview, and (per ADR 005) later a Tauri webview — three
   environments, each with its own wasm-loading quirks, none of which exist today because
   `@nooklet/core` is just TypeScript.
8. **And the mobile side has no packaging story either.** UniFFI states plainly that
   *"UniFFI doesn't provide an end-to-end packaging solution"* — it will not build for your
   targets or produce your `.aar`/`.xcframework`. Its own Xcode documentation stops at "link the
   static lib and add a bridging header": no `lipo`, no `-create-xcframework`, no SPM. The
   third-party tooling is thin — `cargo-swift` (287 stars, macOS-only, and you must manually
   install a version matching your UniFFI version), and the crate for XCFrameworks is `xcframework`
   (18 stars), not `cargo-xcframework`, which does not exist. Both Mozilla and Element skip all of
   it and hand-roll: Mozilla's `build-xcframework.sh` is 221 lines, Matrix's `xtask/src/swift.rs`
   about 600. That is the actual deliverable behind the words "ship a Rust core to iOS".

---

## 8. What the port actually buys, checked against this repo's measurements

Held up against the usual reasons to do this, most of them do not survive:

- **Performance?** No. research/04-editor.md measured the hand-written tokenizer at **0.6 µs per
  block**, 7× faster than markdown-it and 50× faster than micromark, and observes that a
  5,000-block page costs ~3 ms "before DOM creation, which dominates anyway". ADR 002 measured the
  parser round-tripping the entire 952-file / 17.5k-block real graph in **~150 ms**. Rust might
  make that 30 ms. Nobody will notice, because the bottleneck is the DOM and, on the server,
  SQLite and Ollama. Worse, on the target where speed would matter most — a native mobile UI —
  UniFFI's `RustBuffer` serialisation (§2.3) sits between the core and the screen on every call,
  so some of the notional win is spent at the boundary before it reaches the user.
- **Memory?** Plausibly, on a phone — but unmeasured, and the client replica is small: research/10
  §1 measured the full server `graph.sqlite` at 46 MB and noted the client replica is smaller
  still because `ref`/`path_ref`/`block_fts`/`page_fts`/`embedding*` are server-only.
- **Code sharing across platforms?** This is the real one — and only against a *native* UI. Against
  Capacitor (ADR 005's actual decision) it buys nothing, because the TypeScript already runs there.
- **A second implementation as a correctness oracle for hand-rolled sync?** Genuinely valuable,
  and the strongest non-mobile argument in the document. PLAN §16 lists "hand-rolled sync bugs" as
  risk #1. But note that steps 1–2 deliver most of this for ~5–9 weeks, and steps 3–5 — where all
  the cost is — deliver almost none of it.
- **Smaller bundle?** Unknown, possibly neutral, measurable in a day (§6.4). Not a reason on its own.
- **Escaping Node on the server?** Blocked by esbuild (§7.2) regardless of what language the core
  is in.

---

## 9. Recommendation and the trigger condition

**Do not port. The trigger that would change this is both of the following, in order:**

1. **The decision to build a native SwiftUI and/or Jetpack Compose editor has been made on its own
   merits** — i.e. research/10 §7's stated signal has fired: Capacitor's editing feel on a real
   device disappointed, specifically on caret behaviour, autocorrect, dictation, selection handles
   and IME for mixed Czech/English typing. That is the decision this port serves. Without it, the
   port serves nothing.
2. **And research/10 §7's path 2 — running the existing TypeScript core inside JavaScriptCore on
   iOS and QuickJS/Hermes on Android — has been measured and failed.** The measurement is specific
   and cheap: `rebuild()` over the real 17.5k-block op log, and `parseOutline` of the 1.7 MB page,
   in **interpreter-only JSC** on a real iPhone. research/10 §7 flags "third-party apps get
   interpreter-only JSC (no JIT)" as unverified; verifying it is a day's work and is two orders of
   magnitude cheaper than the port. If those two operations land within a few hundred milliseconds,
   the TypeScript core is fine on-device and the Rust port has no case at all.

Condition 1 without condition 2 is not enough, and that ordering is the whole recommendation:
**the port is only justified once the free version of the same benefit has been tried and has
lost.**

Two secondary notes, offered as information rather than as a recommendation:

- **Step 1 alone has standalone value if and only if the grammar will be implemented by someone
  else** (a real Obsidian plugin, a third-party client). A Rust reference implementation plus the
  corpus becomes the artifact of record. But be honest that the corpus *already is* that artifact —
  `markdown-grammar.md` plus 48 `.md`/`.expected.json` pairs is language-neutral and implementable
  from — so this buys confidence, not capability.
- **If sync-correctness bugs start reaching production that the property tests miss**, a second
  independent implementation as a differential oracle becomes the strongest argument here, and
  steps 1–2 (~5–9 weeks) deliver it without any of steps 3–5. If that happens, do steps 1–2 and
  explicitly stop. Do not let them become a foot in the door: none of their cost is amortised by
  the later steps, and all of the later steps' cost is real.

Finally, three things fell out of writing this that are worth doing **regardless of whether the
port ever happens**, because each strengthens the existing TypeScript code and each is small:

1. **Make `corpus.test.ts` check the `tokens` and `blockContent` fields** (§5.1). It skips them
   today on a note that predates `tokens.ts` landing, so 13 of the 48 cases are only half-checked —
   including case 47, the one that pins UTF-16 offset behaviour.
2. **Add a `--bless` mode to the corpus** (§5.1), following tree-sitter's `test -u`.
3. **Verify the interpreter-only-JSC claim** (condition 2 above, and research/10 §8's open item).
   It is a day's work, it is the cheapest decision-relevant measurement available, and it governs
   both this proposal and ADR 005's mobile path.

---

## 10. Still unverified

1. **Whether `sqlite-wasm-vfs`'s `sahpool` on-disk pool layout is byte-compatible with
   `@sqlite.org/sqlite-wasm`'s `opfs-sahpool`.** Its docs say "ported from sqlite-wasm", which
   suggests yes, but I found no explicit statement. Mitigated rather than blocking (§3.3): the
   server is the truth, so the migration path is snapshot re-bootstrap.
2. **Whether the `fractional_index` crate (2.0.2) produces byte-identical keys to the npm
   `fractional-indexing` package.** Its crates.io metadata says nothing about JS compatibility and
   its `documentation`/`homepage` fields are null. Assume reimplementation until proven otherwise.
   This is load-bearing: divergent order keys mean divergent sibling order across devices.
3. **The size of a Rust WASM artifact for *this* core.** §6.4 gives measured figures for other
   people's crates as reference points, not as predictions. Step 1 measures the real one.
4. **The marshalling cost of option (d)** — Rust calling a synchronous JS SQLite closure per
   query, over a `rebuild()` of the real 17.5k-block log. This decides whether option (a) is
   needed at all.
5. **Whether `sqlite-wasm-rs` is a safe dependency to build a product on.** It is the right shape
   and rusqlite depends on it by default (7.8 M downloads), but the repo has 96 stars, 2 open
   issues and a single visible maintainer — who is also the author of the rusqlite PR that made
   rusqlite depend on it. The download count reflects rusqlite's default feature, not independent
   adoption. Bus factor is a real risk for a crate that would own the user's local replica.
6. **Whether third-party iOS apps really get interpreter-only JavaScriptCore.** Inherited unverified
   from research/10 §7, and it is now the single most decision-relevant unverified fact in either
   document — it is condition 2 of §9.
7. **Whether Vite 8's native `.wasm` ESM integration handles wasm-bindgen `--target bundler`
   output** (with its circular glue↔wasm imports) without `vite-plugin-wasm` +
   `vite-plugin-top-level-await`. The Vite docs describe the mechanism but never mention
   wasm-bindgen; Automerge's docs still require both plugins. A 20-minute spike settles it.
8. **Per-flag WASM size savings.** No source publishes isolated numbers for `panic="abort"`,
   `opt-level="z"` vs `"s"`, or `lto`. Only cumulative figures exist. (Matrix's mobile numbers in
   §6.5 are the exception and are cumulative too.)
9. **Whether UniFFI's Swift bindings use Swift 6 typed throws** (`throws(MyError)`) or untyped
   `throws`. Not stated in the docs. Related: Swift 6 strict concurrency is only partially
   supported, and UniFFI's own docs say *"at time of writing, it is known that async code will not
   conform"* to `Sendable`.
10. **Whether any Automerge retrospective exists on the cost of the Rust-core + multi-binding
    approach.** None is on their blog; the closest first-party statements are the "Automerge
    Anywhere" quote in §7 and the two HACKING/CONTRIBUTING documents cited in §2.3. A conference
    talk may exist and was not found.

---

## Sources

Verified 2026-09-11 unless noted. Repo metadata via `gh api`; crate metadata via the crates.io API;
npm artifact sizes via `npm pack` and `tar`.

- [crates.io: wasm-bindgen](https://crates.io/crates/wasm-bindgen) — 0.2.128, released 2026-09-04;
  521.8 M total downloads; 5,204 dependent crates.
- [Sunsetting the rustwasm GitHub org](https://blog.rust-lang.org/inside-rust/2025/07/21/sunsetting-the-rustwasm-github-org/)
  — wasm-bindgen and wasm-pack moved to a new community-governed org; the rest was archived.
- [wasm-bindgen: JSPI](https://github.com/wasm-bindgen/wasm-bindgen/blob/main/guide/src/reference/jspi.md)
  — experimental in 0.2.128; *"call fully Promise-based browser APIs from ordinary Rust code, with
  no `async` call chain required"*; Chrome 137+, Firefox 153+, **Safari Technology Preview 238**.
  Official [JSPI + OPFS example](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/examples/jspi-opfs).
- [wasm-bindgen: optimize size](https://wasm-bindgen.github.io/wasm-bindgen/reference/optimize-size.html)
  — *"the output of the compiler … is not optimized for size and you should not measure it."*
- [rustc platform support: wasm32-unknown-unknown](https://doc.rust-lang.org/nightly/rustc/platform-support/wasm32-unknown-unknown.html)
  — Tier 2; *"`std::thread::spawn` will panic."*
- [wasm-bindgen-rayon](https://github.com/RReverser/wasm-bindgen-rayon) — threads need nightly,
  `-Zbuild-std`, `+atomics`, and `--target web`; last release 1.3.0, 2024-12-21.
- [github.com/wasm-bindgen/wasm-pack](https://github.com/wasm-bindgen/wasm-pack) — v0.15.0
  published 2026-05-15; 0.14.0 2026-01-20 after a 15-month gap from 0.13.1 (2024-10-29); last push
  2026-08-12; 392 open issues; not archived.
- [crates.io: uniffi](https://crates.io/crates/uniffi) — 0.32.1, released 2026-09-09, Mozilla.
- [UniFFI: describing the interface](https://github.com/mozilla/uniffi-rs/blob/main/docs/manual/src/describing.md)
  — *"UniFFI allows you to define your object model using both Procedural Macros and via
  stand-alone UDL files."* Proc-macros have not replaced UDL.
- [UniFFI ADR-0002: serialize complex datatypes](https://github.com/mozilla/uniffi-rs/blob/main/docs/adr/0002-serialize-complex-datatypes.md)
  — *"This choice comes with non-trivial performance costs, but that's acceptable for MVP."*
- [UniFFI: traits for records and enums](https://github.com/mozilla/uniffi-rs/blob/main/docs/manual/src/types/uniffi_traits.md)
  — *"the entire object copies across the FFI boundary on each method call … compared to
  Interfaces, which only copy a pointer."*
- [UniFFI: WASM configuration](https://github.com/mozilla/uniffi-rs/blob/main/docs/manual/src/wasm/configuration.md)
  — *"uniffi-rs does not come with bindings generators 'for WASM'."*
- [UniFFI: Motivation](https://github.com/mozilla/uniffi-rs/blob/main/docs/manual/src/Motivation.md)
  — *"frequent releases and non-trivial API churn"*; *"UniFFI doesn't provide an end-to-end
  packaging solution."*
- [uniffi-bindgen-react-native](https://github.com/jhugman/uniffi-bindgen-react-native) — 0.31.0-5
  (2026-08-21); TypeScript over UniFFI for React Native, web/WASM and N-API Node; *"should not yet
  be used in production."*
- [matrix-rust-sdk `bindings/matrix-sdk-ffi/Cargo.toml`](https://github.com/matrix-org/matrix-rust-sdk/blob/main/bindings/matrix-sdk-ffi/Cargo.toml)
  — `crate-type = ["cdylib", "staticlib", "lib"]` with comments naming Android, iOS, JS/Wasm.
  Root `Cargo.toml` pins `uniffi` to a git rev, not a release.
- [matrix-rust-sdk PR #6764](https://github.com/matrix-org/matrix-rust-sdk/pull/6764) — patched
  UniFFI to disable checksums, which *"consistently fail on Android in ARM 32bit devices"*.
- [matrix-rust-sdk `bindings/CONTRIBUTING.md`](https://github.com/matrix-org/matrix-rust-sdk/blob/main/bindings/CONTRIBUTING.md)
  — `opt-level = "s"` gave *"~33% smaller linked code"*; Android's `lto` + `strip = "debuginfo"`
  profile was *"almost halving the size"*.
- Android `.so` sizes measured from the published `matrix-android-sdk.aar`, tag `sdk-v26.09.9`:
  `libmatrix_sdk_ffi.so` 63,444,592 B (arm64-v8a) / 41,682,892 B (armeabi-v7a);
  `libuniffi_wysiwyg_composer.so` 2.97 MiB / 1.94 MiB.
- [Android 16 KB page sizes](https://developer.android.com/guide/practices/page-sizes) —
  *"Starting February 1, 2027, if your app updates don't support 16 KB memory page sizes, you won't
  be able to release these updates."* NDK r28+.
- [Play 64-bit requirement](https://developer.android.com/google/play/requirements/64-bit) — only
  requires a 64-bit counterpart per 32-bit ABI; `arm64-v8a` alone is compliant.
- [Apple: maximum build file sizes](https://developer.apple.com/help/app-store-connect/reference/maximum-build-file-sizes)
  — 80 MB cap on the total of all `__TEXT` sections.
- [UniFFI: Throwing errors](https://mozilla.github.io/uniffi-rs/latest/types/errors.html) — *"your
  error type (E) must be an enum and implement std::error::Error (thiserror works!)"*; *"a proper
  exception will be thrown if Result::is_err() is true"*; *"You can't yet use anyhow directly in
  your exposed functions - you need a wrapper."*
- [UniFFI: Async/Future support](https://mozilla.github.io/uniffi-rs/latest/futures.html) —
  `async fn` maps to Swift `async`/`await` and Kotlin `suspend fun`; *"There's no requirement for a
  Rust event loop... the foreign bindings supply the executor"*; *"We don't directly support
  cancellation in UniFFI even when the underlying platforms do."*
- [crates.io: rusqlite](https://crates.io/crates/rusqlite) — 0.40.2, released 2026-08-08; default
  features are `cache` and `ffi-sqlite-wasm-rs`.
- [rusqlite README](https://github.com/rusqlite/rusqlite) — *"ffi-sqlite-wasm-rs switches to using
  the sqlite-wasm-rs crate (instead of libsqlite3-sys) on wasm32-unknown-unknown builds. This is
  enabled by default"*; bundled SQLite is *"3.53.2 (as of rusqlite 0.40.1 / libsqlite3-sys 0.38.1)"*.
- [crates.io: sqlite-wasm-rs](https://crates.io/crates/sqlite-wasm-rs) /
  [repo](https://github.com/Spxg/sqlite-wasm-rs) — 0.5.5, released 2026-05-25; VFS backends
  `memory`, `sahpool` (OPFS), `relaxed-idb`; `sahpool` requires a Dedicated Worker, no COOP/COEP,
  full durability, single connection; *"This library is not thread-safe"* (`-DSQLITE_THREADSAFE=0`);
  MSRV 1.81.0. Repo: 96 stars, 2 open issues, last push 2026-09-02.
- [docs.rs: sqlite-wasm-vfs](https://docs.rs/sqlite-wasm-vfs/latest/sqlite_wasm_vfs/) — provides
  `relaxed_idb` and `sahpool`; the latter described as *"opfs-sahpool vfs implementation, ported
  from sqlite-wasm"*.
- [rusqlite PR #1769](https://github.com/rusqlite/rusqlite/pull/1769) — merged 2025-12-14,
  *"replace `libsqlite3-sys` with `sqlite-wasm-rs` on the wasm platform"*, closing
  [#827](https://github.com/rusqlite/rusqlite/issues/827). rusqlite's wasm CI runs
  `wasm-pack test --node`, not a browser.
- [wa-sqlite discussion #154](https://github.com/rhashimoto/wa-sqlite/discussions/154) —
  *"wasm-bindgen doesn't seem to provide an Asyncify or JSPI feature, which means it's difficult to
  call asynchronous functions synchronously."*
- [SQLite WASM persistence docs](https://sqlite.org/wasm/doc/trunk/persistence.md) — the `opfs` VFS
  requires `SharedArrayBuffer` and therefore COOP/COEP; `opfs-sahpool` requires neither, is
  *"easily the highest OPFS performance of the options"*, and *"Does not support multiple
  simultaneous connections"*; `pauseVfs()`/`unpauseVfs()` (v3.49/3.50) is the cooperative escape
  hatch for the multi-tab follow-up `db.worker.ts` already documents.
- [crates.io: sqlite-vec](https://crates.io/crates/sqlite-vec) — *"FFI bindings to the sqlite-vec
  SQLite extension"*; stable 0.1.9 (2026-03-31), head 0.1.10-alpha.4 (2026-05-18); `build.rs` is
  `cc::Build::new().file("sqlite-vec.c").define("SQLITE_CORE", None).compile("sqlite_vec0")`.
  Upstream repo last pushed 2026-05-18, 204 open issues.
- [sqlite-vec WASM docs](https://alexgarcia.xyz/sqlite-vec/wasm.html) — *"It's not possible to
  dynamically load a SQLite extension into a WASM build of SQLite."*
- [crates.io: proptest](https://crates.io/crates/proptest) — 1.11.0, released 2026-03-24.
- [proptest: failure persistence](https://proptest-rs.github.io/proptest/proptest/failure-persistence.html)
  — persists *"the **seed** that was used to produce the failing test case"* into
  `proptest-regressions`, which *"should be checked into version control"*.
- [CommonMark spec tests](https://github.com/commonmark/commonmark-spec),
  [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite),
  [tree-sitter corpus tests](https://tree-sitter.github.io/tree-sitter/creating-parsers/5-writing-tests.html)
  — the three good models for language-neutral conformance corpora; tree-sitter's `test -u`
  re-blesses expectations.
- [crates.io: fractional_index](https://crates.io/crates/fractional_index) — 2.0.2, released
  2024-09-17; no documentation or homepage field, no stated JS compatibility.
- [automerge/automerge](https://github.com/automerge/automerge) — Rust workspace contains
  `automerge-wasm` (pinned `wasm-bindgen = "= 0.2.127"`) and `automerge-c`; last push 2026-09-10;
  the crate is at 0.11.0 (2026-08-12).
- [automerge/automerge-swift](https://github.com/automerge/automerge-swift) — UniFFI
  (`AutomergeUniffi/`, `rust/uniffi-bindgen.rs`); latest release 0.7.2 (2025-12-20), repo last
  pushed 2026-04-02; `automergeFFI.xcframework.zip` is 54,278,033 B; CONTRIBUTING warns the
  XCFramework binary and generated Swift are *"**tightly** coupled"*.
- [automerge/automerge-java](https://github.com/automerge/automerge-java) — JNI, not UniFFI
  (*"FFM is only available in Java 18 and later and this library targets Java 8 up"*); HACKING.md
  describes toolchains for 11 platforms plus a Docker cross-compilation image; last push 2026-04-22.
- [Automerge Anywhere](https://automerge.org/blog/automerge-anywhere/) (2024-08) — *"different
  runtimes, package managers, bundlers, and browsers have all settled on different approaches …
  It's a real mess out there."*
- [Automerge: library initialization](https://automerge.org/docs/reference/library-initialization/)
  — Vite needs `vite-plugin-wasm` + `vite-plugin-top-level-await`; per-environment matrix for
  Webpack, Deno, Cloudflare Workers, Metro.
- [Automerge 2.0](https://automerge.org/blog/automerge-2/) (2023-01) — *"we decided to rewrite
  Automerge in Rust and use platform-specific wrappers … we can be confident that the core CRDT
  logic is identical across all platforms."*
- `@automerge/automerge-wasm` 1.0.0-preview.0 on npm — `web/automerge_wasm_bg.wasm` is 2,125,742
  bytes (720,739 gzip -9, 530,472 brotli -q 11); `web/automerge_wasm.js` glue is 75,938 bytes.
  Measured locally with `npm pack` + `tar`. `@automerge/automerge` 3.4.1's wasm is 3,571,259 B;
  `ywasm` 0.27.4's is 983,030 B; `@swc/wasm-web` 1.16.2's is 20,246,940 B; `@biomejs/wasm-web`
  2.5.13's is 44,645,975 B (all via jsDelivr's package API).
- [rustwasm book: shrinking .wasm size](https://rustwasm.github.io/book/game-of-life/code-size.html)
  — Game of Life 29,410 B → 17,317 B with `lto` + `opt-level="z"` + `wasm-opt -Oz` → 9,045 B gzip.
  [`wasm-snip`](https://github.com/rustwasm/wasm-snip) and `twiggy` are both archived.

Internal references: `docs/adr/001`, `002`, `003`, `004`, `005`, `006`, `007`, `008`, `009`, `010`,
`014`; `docs/research/03-sync.md` §4/§6.9, `04-editor.md` §2/§5, `08-mobile.md` §1.3,
`10-desktop-packaging.md` §1/§5/§6/§7; `docs/spec/markdown-grammar.md` §7/§9;
`docs/spec/00-conventions.md`.
