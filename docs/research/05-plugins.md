# nooklet plugin system: survey and recommended design

Research date: 2026-09-10. Versions and statuses below were checked against npm, GitHub and the projects' own docs on that date (see "Sources" at the end).

---

## 0. TL;DR

**Recommendation for nooklet v1**

1. **One plugin package, two entry points.** A plugin is an npm-style directory with a `nooklet` field in `package.json` naming a `server` entry and/or a `client` entry (plus a JSON-schema `settings` block and a declared `permissions` list). Shared code is just a shared module; the *data* API (`blocks`, `pages`, `query`, `transact`) is **isomorphic** (identical TS interface on both sides), and the plugin's client half can call its server half through `ctx.rpc`. This is the SilverBullet "one code base" idea, but without SilverBullet's mistake of running the *same* plugin runtime in two places (they removed the server-side runtime in v2, see ADR-007 below).
2. **Trusted code by default: plain ESM `import()` on both sides.** Self-hosted, single-user, technical authors: the trust boundary is the `plugins/` directory, exactly like Obsidian, Home Assistant, Fastify and Vite. This is what makes Obsidian's ecosystem work and what makes Logseq's iframe model painful. Say so loudly in the UI ("plugins run with full server access").
3. **Design the API so a sandbox can be added later without changing it.** Three rules: every API call is `async` and takes/returns JSON-serialisable values; callbacks only enter the host through *registration* (`register(...)` returning a `Disposable`), never by passing functions into data calls; client renderers can be written in an "HTML-returning" form (`html(source) => string`) as well as the "mount into `el`" form. With these rules the server plugin host can be moved into a `worker_thread` (VS Code extension-host style, `birpc` over `MessagePort`, `resourceLimits`, kill-and-respawn = hot reload) and untrusted client plugins into Web Worker + sandboxed iframe (Figma/SilverBullet style) as a pure hosting change.
4. **Small v1 extension-point list** (server: lifecycle, change events, one `beforeWrite` hook, commands, rpc functions, HTTP routes, MCP tools/resources, scheduled jobs, importers/exporters, embedding + search providers, settings, KV storage; client: lifecycle, commands + keybindings, slash commands, code-block and `{{macro}}` renderers, sidebar panels, block/page menu items, toolbar buttons, styles/themes, editor API, notifications/dialogs, settings, rpc). Everything returns a `Disposable`; `deactivate` disposes all.
5. **Loader**: discover `plugins/*/package.json` (plus packages listed in config and single-file `*.plugin.ts`), bundle each entry with esbuild (server: ESM for Node with node builtins external; client: ESM served at `/plugins/<id>/client.js?v=<hash>`), `import()` it, call `activate(ctx)`. Reload = `deactivate` → rebuild → `import()` new hash → `activate`, broadcast to clients over the existing sync socket. Ship `@nooklet/plugin-api` (types + `definePlugin` + `Disposable` helpers + an in-memory test host), a manifest `api: "1"` field, and `engines.nooklet` for host-version compatibility (Obsidian `minAppVersion` / VS Code `engines.vscode`).
6. **Explicitly rejected as the default**: `node:vm` (documented "not a security mechanism"), `isolated-vm` (maintenance mode, native build, `--no-node-snapshot`, and an August 2026 sandbox-escape CVE), ShadowRealm (still Stage 2.7, shipped nowhere), SES/Compartments (needs realm-wide `lockdown()`, no DOM, breaks many libraries). QuickJS-in-wasm is the credible *future* option for genuinely untrusted scripts (it is what Figma moved to), not for v1.

---

## 1. What we are optimising for

| Constraint | Implication for the plugin system |
| --- | --- |
| Self-hosted, single user (or a household), Node server + PWA client | The threat model is "code I put on my own server", not "marketplace code from strangers". Security sandboxing is a *future* need, robustness and DX are *present* needs. |
| Technical users who write TS/JS | Prefer a code-first API (Obsidian/VS Code style) over YAML manifests + string templates (Logseq `provideUI` templates are the single most-complained-about part of that API). |
| Both server and client extension points, ideally from one package | Directus "bundles" and VS Code's `main`/`browser` dual entries are the proven shape. SilverBullet shows what *not* to do: one runtime that must behave identically in two environments. |
| Core primitives: block tree, refs, queries, commands, MCP | The plugin API must sit on the *same* internal service layer as the HTTP API and MCP server. If the core can be driven by the plugin API, the API is sufficient (dogfooding rule, as in VS Code/Obsidian/SilverBullet where core features are plugins). |
| Multi-device sync | Change events must carry an `origin` (user/api/mcp/sync/plugin/import) so plugins can avoid loops; plugin settings live server-side and sync. |
| Small and stable from day one | Ship few extension points, all disposable, all async, JSON-only across the boundary; gate anything unstable behind `ctx.experimental`. |

---

## 2. Survey

### 2.1 Logseq (`@logseq/libs`)

**Loading and sandbox.** A Logseq plugin is a directory with `package.json` (a `logseq` field with `id`, `main` pointing at an HTML file, optional `mode`, `title`, `icon`) and a `main.js`. The host (`LSPluginCore` → `PluginLocal`) loads the plugin's HTML into an `<iframe sandbox=...>` served from the custom `lsp://` protocol (Electron) or `file://`; a lighter `mode: 'shadow'` runs it in a Shadow DOM instead. Everything crosses the boundary as `postMessage` RPC (`LSPluginCaller`, message types `LSPMSG_READY`, `LSPMSG_SYNC` with request ids, `LSPMSG_SETTINGS`, `LSPMSG_ERROR_TAG`); only functions white-listed in `logseq.api` are reachable. The marketplace manifest has an `effect: true` flag meaning "run the sandbox same-origin with the host", i.e. an escape hatch that the marketplace README explicitly discourages and reviews more strictly.

**Package config type (from `LSPlugin.d.ts` 0.3.4):**

```ts
export interface LSPluginPkgConfig {
  id: PluginLocalIdentity;
  main: string;
  entry: string;
  title: string;
  mode: 'shadow' | 'iframe';
  themes: Theme[];
  icon: string;
  devEntry: string;   // alternative entrypoint for development
}
```

**API surface** (global `logseq` = `ILSPluginUser`): `App`, `Editor`, `DB`, `UI`, `Git`, `Assets`, `Net`, `FileStorage`, `Experiments`, plus on the user object itself `ready()`, `beforeunload()`, `provideModel()`, `provideTheme()`, `provideStyle()`, `provideUI()`, `useSettingsSchema()`, `updateSettings()`, `onSettingsChanged()`, `showSettingsUI()`, `showMainUI()/hideMainUI()`, `resolveResourceFullUrl()`.

Representative signatures (verbatim from 0.3.4 typings):

```ts
// Editor
registerSlashCommand: (tag: string, action: BlockCommandCallback | Array<SlashCommandAction>) => CommandUnregister | false;
registerBlockContextMenuItem: (label: string, action: BlockCommandCallback) => CommandUnregister | false;
insertBlock: (srcBlock: BlockIdentity | EntityID, content: string, opts?: Partial<{ before, sibling, start, end, customUUID, properties }>) => Promise<BlockEntity | null>;
getPageBlocksTree: (srcPage: PageIdentity) => Promise<Array<BlockEntity> | null>;
getPageLinkedReferences: (srcPage: PageIdentity) => Promise<Array<[page: PageEntity, blocks: Array<BlockEntity>]> | null>;
getPagesFromNamespace / getPagesTreeFromNamespace: (namespace: BlockPageName) => Promise<Array<PageEntity> | null>;
upsertBlockProperty: (block, key: string, value: any, options?) => Promise<void>;

// App
registerCommandPalette: (opts: { key: string; label: string; keybinding?: SimpleCommandKeybinding }, action) => CommandUnregister | false;
registerCommandShortcut: (keybinding: SimpleCommandKeybinding | string, action, opts?) => CommandUnregister | false;
registerUIItem: (type: 'toolbar' | 'pagebar', opts: { key: string; template: string }) => void;
onMacroRendererSlotted: IUserSlotHook<{ payload: { arguments: string[]; uuid: string } }>;   // for {{renderer ...}}
onBlockRendererSlotted, onPageHeadActionsSlotted, onRouteChanged, onThemeModeChanged, onTodayJournalCreated, ...

// DB
q: <T = any>(dsl: string) => Promise<T>;                       // Logseq simple query DSL
datascriptQuery: <T = any>(query: string, ...inputs) => Promise<T>;
onChanged: IUserHook<{ blocks: BlockEntity[]; txData: IDatom[]; txMeta?: { outlinerOp: string } }>;
onBlockChanged(uuid: BlockUUID, callback: (block, txData, txMeta?) => void): IUserOffHook;
```

Settings schema (host renders the UI):

```ts
export type SettingSchemaDesc = {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'heading';
  default: string | number | boolean | Array<any> | object | null;
  title: string;
  description: string;
  inputAs?: 'color' | 'date' | 'datetime-local' | 'range' | 'textarea';
  enumChoices?: Array<string>;
  enumPicker?: 'select' | 'radio' | 'checkbox';
};
```

UI injection is by *HTML string template* into either a named slot or an arbitrary DOM selector:

```ts
// from the typings' own example: {{renderer :h1, hello world, green}}
logseq.App.onMacroRendererSlotted(({ slot, payload: { arguments: args } }) => {
  const [type, text, color] = args
  if (type !== ':h1') return
  logseq.provideUI({ key: 'h1-playground', slot, template: `<h2 style="color:${color}">${text}</h2>` })
})
```

Minimal plugin (from `logseq-plugin-samples/logseq-slash-commands`):

```js
function main () {
  logseq.Editor.registerSlashCommand('💥 Big Bang', async () => {
    const { content, uuid } = await logseq.Editor.getCurrentBlock()
    logseq.App.showMsg(`[:div.p-2 [:h1 "#${uuid}"] [:h2.text-xl "${content}"]]`)  // hiccup!
  })
  logseq.Editor.registerBlockContextMenuItem('🦜 Send A Tweet', ({ blockId }) => { /* ... */ })
}
logseq.ready(main).catch(console.error)
```

**Versions / status (2026-09).** npm `@logseq/libs`: the `latest` dist-tag still points at **0.0.17** (file-graph line) while **0.2.x/0.3.x (newest 0.3.4)** is the DB-graph SDK line the forum tells you to use for DB graphs; the DB-version docs (dated 2026-04-28) claim "65+ plugins that support DB graphs" and the marketplace manifest grew `supportsDB` / `supportsDBOnly` flags. In practice the DB transition split the plugin ecosystem in two.

**Strengths.** Real isolation from the host DOM/JS (a plugin crash cannot take the app down); a generic settings-schema UI; slot-based UI injection means the host controls layout; `DB.onChanged` gives transaction-level datoms; a marketplace with cheap submission (PR with a `manifest.json`).

**Weaknesses (lessons).**
- *Everything is async RPC*, including reads that would be trivial in-process; UI is built from HTML strings (or hiccup) pushed across the boundary, event wiring goes through `provideModel` name lookups. This is the part plugin authors dislike most.
- The sandbox is porous by design (`effect: true`, `mode: 'shadow'`) because the pure iframe model could not satisfy real plugins, so you pay the DX cost without a clean security story.
- iframe-per-plugin startup cost is visible with many plugins.
- API stability: the DB-graph migration required a second SDK line; the `latest` tag confusion above is a symptom.

### 2.2 Obsidian (`obsidian` typings, `obsidian-api` repo)

**Loading and (non-)sandbox.** A plugin is a folder in `.obsidian/plugins/<id>/` with `manifest.json` + `main.js` (+ optional `styles.css`). `main.js` is loaded with `require()` in the Electron renderer, **unsandboxed**, with full Node/Electron access. Obsidian's own security page says it "cannot restrict plugin permissions" and that community plugins can "access files on your computer", "connect to internet", "install additional programs"; the mitigation is *Restricted Mode* (default: no third-party code), automated scanning, manual review of popular/flagged plugins, and the *Developer policies* (no obfuscation, no client-side telemetry, no self-updating, disclosed network use / file access outside the vault, etc.).

**Manifest (verbatim from `obsidian.d.ts` 1.13.1, 2026-06):**

```ts
export interface PluginManifest {
  dir?: string; id: string; name: string; author: string; version: string;
  minAppVersion: string; description: string; authorUrl?: string; isDesktopOnly?: boolean;
}
```

**The `Plugin` class (verbatim, 1.13.1):**

```ts
export abstract class Plugin extends Component {
  app: App; manifest: PluginManifest; settings?: unknown;
  constructor(app: App, manifest: PluginManifest);
  onload(): Promise<void> | void;
  addRibbonIcon(icon: IconName, title: string, callback: (evt: MouseEvent) => any): HTMLElement;
  addStatusBarItem(): HTMLElement;
  addCommand(command: Command): Command;
  removeCommand(commandId: string): void;
  addSettingTab(settingTab: PluginSettingTab): void;
  registerView(type: string, viewCreator: ViewCreator): void;
  registerHoverLinkSource(id: string, info: HoverLinkSource): void;
  registerExtensions(extensions: string[], viewType: string): void;
  registerMarkdownPostProcessor(postProcessor: MarkdownPostProcessor, sortOrder?: number): MarkdownPostProcessor;
  registerMarkdownCodeBlockProcessor(language: string,
      handler: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<any> | void,
      sortOrder?: number): MarkdownPostProcessor;
  registerBasesView(viewId: string, registration: BasesViewRegistration): boolean;
  registerEditorExtension(extension: Extension): void;          // CodeMirror 6 extension
  registerObsidianProtocolHandler(action: string, handler: ObsidianProtocolHandler): void;
  registerEditorSuggest(editorSuggest: EditorSuggest<any>): void;
  registerCliHandler(command: string, description: string, flags: CliFlags | null, handler: CliHandler): void;
  loadData(): Promise<any>; saveData(data: any): Promise<void>;
  onUserEnable(): void;
  onExternalSettingsChange?(): any;
}
// inherited from Component:
//   load/unload/onload/onunload, addChild/removeChild, register(cb), registerEvent(ref),
//   registerDomEvent(el, type, cb), registerInterval(id)
```

```ts
export interface Command {
  id: string; name: string; icon?: IconName; mobileOnly?: boolean; repeatable?: boolean;
  callback?: () => any;
  checkCallback?: (checking: boolean) => boolean | void;
  editorCallback?: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => any;
  editorCheckCallback?: (checking: boolean, editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => boolean | void;
  hotkeys?: Hotkey[];
}
```

Typical plugin:

```ts
import { Plugin, PluginSettingTab, Setting } from 'obsidian';

export default class MermaidPlus extends Plugin {
  async onload() {
    const settings = Object.assign({ theme: 'default' }, await this.loadData());
    this.registerMarkdownCodeBlockProcessor('mermaid', async (source, el, ctx) => {
      el.appendChild(await renderMermaid(source, settings.theme));   // you get a real HTMLElement
    });
    this.addCommand({ id: 'insert-diagram', name: 'Insert diagram', editorCallback: (editor) => editor.replaceSelection('```mermaid\n\n```') });
    this.registerEvent(this.app.vault.on('modify', (file) => { /* ... */ }));   // auto-detached on unload
    this.addSettingTab(new MySettingsTab(this.app, this));
  }
  // onunload(): everything registered via register*/add* is torn down by Component
}
```

**Why developers love it.** (1) *Full power*: real DOM, real CodeMirror 6 extensions, any npm package, Node `fs`/`child_process` when needed. (2) *Tiny mental model*: one class, `onload`, everything you register is auto-disposed via `Component`. (3) *Stable typings* in a public repo (`obsidian-api`), plus the community `obsidian-typings` for internals. (4) Synchronous access to metadata caches. (5) A `Setting` builder for settings tabs.

**Risks.** No isolation at all: a plugin exception in a render path can break the view, an infinite loop freezes the app, and supply-chain compromise of a popular plugin equals RCE on every user's machine. Obsidian mitigates socially (policies, review, Restricted Mode), not technically. Obsidian also never exposes its UI framework, so plugins use vanilla DOM (or bundle their own), which is why the API has stayed stable across years.

### 2.3 SilverBullet: plugs, syscalls and Space Lua

SilverBullet is the closest analogue to nooklet (markdown, self-hosted, PWA, technical users) and has changed dramatically: v2 shipped 2025-08-29; the client toolchain moved from Deno to Node (2.6); the server was rewritten in Go (2025-09) and then Rust (v2.10.0, 2026-06); npm `@silverbulletmd/silverbullet` is 2.10.0 (2026-07-28).

**Plugs.** A plug is a compiled bundle `<name>.plug.js` (built by `plug-compile` / esbuild from a `<name>.plug.yaml` manifest plus TS files) that exports `{manifest, functionMapping}`. At load time **each plug runs in its own Web Worker in the browser**; it never touches the DOM; all interaction goes through *syscalls* (`globalThis.syscall(name, ...args)` forwarded to the main thread). Two message kinds cross the boundary: *invoke* (main → worker: run function X for a hook) and *syscall* (worker → main). Plugs are discovered as any `*.plug.js` file in the space; built-in plugs live under `Library/Std/Plugs`. Reloading is explicit (`Plugs: Reload`, `system.loadPlug(path)` / `system.unloadPlug(path)`); an earlier changelog entry notes "hot reloading plugs has been disabled because it caused some nasty race condition".

Manifest type (verbatim, `client/plugos/types.ts` + `plug-api/types/manifest.ts`):

```ts
export interface Manifest<HookT> {
  name: string;
  requiredPermissions?: string[];      // currently "fetch" and "shell"
  assets?: string[] | AssetJson;       // bundled, readable via asset.readAsset
  functions: Record<string, FunctionDef<HookT>>;
  config?: any;
  build?: BuildStep[];                 // esbuild | sass | copy, run before bundling
}
export type FunctionDef<HookT> = {
  path?: string;        // "file.ts:exportedFunction"
  redirect?: string;    // "otherPlug.function"
  env?: string;         // "cli" | "server" | "client"  (legacy: the server runtime is gone)
} & HookT;
export type SilverBulletHooks = CommandHookT & SlashCommandHookT & MQHookT & EventHookT &
  CodeWidgetT & PlugNamespaceHookT & DocumentEditorT & SyscallHookT;
// CommandDef: name, contexts?, priority?, key?, mac?, hide?, requireMode?: "rw"|"ro", requireEditor?, disableInVim?, menu placement...
// SlashCommandDef: name, description?, priority?, onlyContexts?, exceptContexts?
// MQSubscription: queue, batchSize?, pollInterval?, autoAck?
// CodeWidgetT: codeWidget?: string; renderMode?: "iframe"
// SyscallHookT: syscall?: string | ({ name } & LuaFunctionDocumentation)
```

A manifest that declares a syscall, a command, an MQ subscriber and an event subscriber (verbatim from the docs):

```yaml
name: index
functions:
  extractFrontmatter:
    path: api.ts:extractFrontmatter
    syscall: index.extractFrontmatter
  reindexSpaceCommand:
    path: ./command.ts:reindexCommand
    command:
      name: "Space: Reindex"
  processIndexQueue:
    path: ./queue.ts:processIndexQueue
    mqSubscriptions:
      - queue: indexQueue
        batchSize: 3
        autoAck: true
  indexPage:
    path: indexer.ts:indexPage
    events:
      - page:index
```

```ts
import { editor, space, system } from "@silverbulletmd/silverbullet/syscalls";
export async function toggleDarkMode() {
  const current = await editor.getUiOption("darkMode");
  await editor.setUiOption("darkMode", !current);
}
// code widget: register a renderer for a fenced block language
export async function clockWidget(_body: string, _pageName: string) {
  return { markdown: `The time is ${new Date().toLocaleTimeString()}` };   // or HTML, rendered in an iframe with renderMode: iframe
}
```

Syscall namespaces (docs/API): `asset, clientStore, codeWidget, command, config, datastore, dom, editor, encoding, event, global, http, icon, identity, index, js, jsonschema, language, lua, markdown, math, mq, net, os, search, service, shell, slashCommand, space, spacelua, string, sync, syntax, system, table, tag, taskState, template, ...`. The event bus doubles as RPC: `event.dispatch(name, data)` returns the array of listener results.

**Space Lua.** A from-scratch Lua 5.4-ish interpreter written in TypeScript (ADR-005, 2024-10): scripts live in ```` ```space-lua ```` blocks inside pages, are indexed like any other object, loaded at boot / `System: Reload` in `-- priority:` order, and are global across the space. `${expr}` renders live in pages. Command/slash/event/widget APIs:

```lua
command.define { name = "Hello", key = "Ctrl-Alt-h", run = function() editor.flashNotification("Hi") end }
slashCommand.define { name = "hello-world", run = function() editor.insertAtCursor("Hello |^| world!", false, true) end }
event.listen { name = "hooks:renderTopWidgets", run = function(e) return widget.new { markdown = "top of every page" } end }
codeWidget.define { language = "mermaid", render = function(body) ... end }   -- added 2026: renderers from Lua
-- JS interop: js.window, js.import("https://esm.sh/lodash@4.17.21"), promises awaited transparently
```

Runaway protection: a busy-time budget on the main thread; scripts that exceed it are offered *Stop*/*Keep going*; stopped definitions are *quarantined* (disabled on reload until edited). Widgets/expressions are cut off with an inline "Lua timeout".

**The key lesson for nooklet: ADR-007 "Core Application Logic on the Client" (2025-08-29).** The v1 PlugOS runtime could run plugs "either on the server or in the client" (server mode vs sync mode). The ADR's own words: "maintaining two runtime environments for PlugOS was a persistent burden: every capability had to work and the dual model produced subtle, hard-to-diagnose issues"; it "was also confusing for plug developers". v2 **eliminated the server-side runtime**: plugs, indexing, queries, Space Lua and sync run only in the client; the server "is reduced to a file store". Consequences they accept: every device re-indexes, no thin-client mode, and "server-authoritative features are harder" (CRDT/collab, anything needing a central source of truth). `system.getEnv` is now deprecated with the note "The environment is always the client".

nooklet's requirements (server-side hooks, MCP, scheduled jobs, importers, embeddings on the server) are exactly the "server-authoritative" features SilverBullet gave up. So: *do not* build one runtime that must run identically in both places; build *two explicit halves* with a shared data interface and a thin RPC between them.

**Strengths.** Clean API boundary (syscalls are the single choke point, enumerable via `system.listSyscalls`, permission-gated); manifest makes contributions statically discoverable (commands, keybindings, slash commands appear before the code runs); per-plug worker isolation without a native dependency; syscall-exposed plug functions are callable from other plugs and from Lua; in-page scripting (Space Lua) has an extremely low barrier for small customisations; time-budget + quarantine is a nice robustness pattern.

**Weaknesses.** No DOM for plugs (widgets are markdown/HTML strings or iframes); YAML manifest + function-path strings is an extra layer relative to a typed `definePlugin`; two languages (TS plugs vs Lua scripts); an entire custom Lua interpreter to maintain; and, historically, the dual-runtime cost discussed above.

### 2.4 VS Code extension host

Extensions never run in the renderer: they run in a separate **extension host** (local Node.js process, a Web Worker in the browser build, or a remote host in a container/SSH). `package.json` declares *contribution points* (commands, keybindings, views, configuration...) and *activation events* so the host can be lazy; the code entry is `main` (Node) and/or `browser` (worker). `extensionKind: ["ui"] | ["workspace"]` says where an extension prefers to run. The stated rationale: extensions cannot "impact startup performance", "slow down UI operations", or "modify the UI" (no DOM access; UI is contributed declaratively or via webviews). API calls are async RPC between renderer and host.

Lessons: (1) *declarative contributions + lazy activation* let the host render menus/palettes before loading plugin code; (2) process isolation gives crash containment and clean restarts ("Reload window"), not security (the extension host has full Node access); (3) the `engines.vscode` semver range plus *proposed API* opt-in is a good compatibility policy; (4) the `Disposable` / `context.subscriptions` pattern is the cleanest lifecycle idiom in the industry.

### 2.5 Trilium / TriliumNext scripts

Scripts are *code notes* inside the database. Labels select where/when they run: `#run=frontendStartup`, `#run=backendStartup`, `#run=hourly`, `#run=daily`, `#run=mobileStartup`; `#customRequestHandler=<regex>` exposes a note as an HTTP endpoint under `/custom/<path>` with Express `api.req`/`api.res` (and **unauthenticated by default**, the docs warn); `#customResourceProvider` serves file notes; `#widget` notes extend `api.BasicWidget` / `NoteContextAwareWidget` / `RightPanelWidget` to add UI.

Frontend API (from `frontend_script_api.ts`): `currentNote`, `startNote`, `originEntity`, `runOnBackend(func, params)`, `runAsyncOnBackendWithManualTransactionHandling`, `addButtonToToolbar`, `bindGlobalShortcut`, `searchForNotes`, `getNote`, `createNote`, `openTabWithNote`, `showMessage/showError/showConfirmDialog/showPromptDialog`, `triggerCommand/triggerEvent`, `getActiveContextTextEditor`, `waitUntilSynced`, `preact`, `dayjs`, ...
Backend API (from `backend_script_api.ts`): `createTextNote/createDataNote/createNewNote`, `getNote/getBranch/getAttribute`, `searchForNotes/searchForNote`, `getNotesWithLabel`, `toggleNoteInParent`, `sortNotes`, `transactional`, `runOutsideOfSync`, `backupNow`, `exportSubtreeToZipFile`, `runOnFrontend`, `log`, **`sql`** (raw SQL), `axios`, `cheerio`, `dayjs`, `xml2js`, `getAppInfo`, ...

Execution: the client runs bundles with ``eval(`const apiContext = this; (async function() { ${bundle.script} })()`)``; the server does the same (`script.ts`: ``eval(`const apiContext = this;\r\n(${script}\r\n)()`)``) and `script_context.ts` states plainly "It is NOT a security sandbox. Scripts execute via eval() in the main Node.js". Notably TriliumNext recently added `scripting_guard.ts`: backend scripting is **off unless** `[Security] backendScriptingEnabled=true` ("WARNING: Backend scripts have full server access").

Lessons: the "scripts in notes, run on both sides, `runOnBackend` bridge" model is beloved for its immediacy, but scripts-in-synced-content plus full server access is a footgun (hence the new kill-switch). If nooklet ever adds in-page scripting, it should be client-only and sandboxed.

### 2.6 Joplin

Multi-process for *stability*, not security. The `PluginService` delegates to a platform `PluginRunner`: desktop creates a **new `BrowserWindow` (separate process) per plugin**; mobile runs plugins in an `about:srcdoc` iframe in a WebView; CLI uses `node:vm` in-process. A *sandbox proxy* in the plugin process turns every `joplin.*` call into an IPC message; functions cannot cross IPC, so event handlers are replaced by ids (`onExecute: '___event_handler_123'`) and re-materialised as stubs on the host. UI (`joplin.views.panels/dialogs`) is HTML in a webview with `postMessage`/`onMessage`; *content scripts* (`ContentScriptType.MarkdownItPlugin`, `CodeMirrorPlugin`) run inside the renderer/editor. Note `joplin.require()` gives plugins native packages (`sqlite3`, `fs-extra`), so desktop isolation is not a security boundary either. Packaging is a `.jpl` archive with `manifest.json`; the API is a `joplin` global with namespaces `plugins, workspace, filters, commands, views, interop, settings, contentScripts, clipboard, window, imaging, data, fs, ai`.

Lesson: the id-for-callback IPC serialisation is exactly what nooklet would implement if/when the server plugin host moves to a worker; designing the API as *registrations + dispatch* from day one makes that transparent.

### 2.7 SiYuan

Frontend plugins: `plugin.json` (`name`, `version`, `minAppVersion`, `backends`, `frontends`, `kernels`, localised `displayName`/`description`) + `index.js`/`index.css`, loaded **unsandboxed** into the frontend; a `Plugin` class with `onload / onLayoutReady / onDataChanged / onunload / uninstall` (run strictly in sequence with a shared 5-second teardown budget), `addCommand`, `addDock`, `addTab`, `addTopBar`, `eventBus.on`, `loadData/saveData`, and `customBlockRenders` for `;;;plugin/type ... ;;;` custom blocks. Distribution is the *bazaar* (GitHub release zip + PR to `plugins.json`, then hourly auto-indexing).

**Kernel plugins (server side, 2026).** The same package may ship `kernel.js`, which runs **inside the Go kernel in a `goja` JS runtime** with a lifecycle state machine `ready → loading → loaded → running → stopping → stopped` and a `globalThis.siyuan` object: `siyuan.rpc.bind/unbind/broadcast`, `siyuan.storage.put/get/list/remove` (scoped to `data/storage/petal/<plugin>/`, path traversal blocked), `siyuan.server.private.http/ws/es.handler` (routes under `/plugin/private/<name>/*`), `siyuan.event.handler/emit`, `siyuan.client.fetch/socket/event`, `siyuan.logger`. This is a real, current example of "one package, frontend + backend halves, with a typed RPC between them" (`kernels` field gates the backend half).

### 2.8 Home Assistant custom components (server-only, Python)

`custom_components/<domain>/manifest.json` (`domain`, `name`, `version`, `requirements`, `dependencies`, `config_flow`, `iot_class`) + `__init__.py` exporting `async_setup(hass, config)` / `async_setup_entry(hass, entry)`; per-platform modules (`sensor.py` ...). The `hass` object *is* the capability API: `hass.states`, `hass.services`, `hass.bus`, `hass.data`, `hass.config_entries`. Unsandboxed Python imported with `importlib`; HACS is the "marketplace"; a broken integration can and does take the server down, so HA invests in *safe mode* and *config-entry-scoped* setup/teardown (`async_unload_entry`) instead of isolation.

Lesson: the "context object as capability bag" and "every register returns an unsubscribe" pattern is enough for a server-only plugin system used by millions; explicit teardown is what matters.

### 2.9 Fastify and Vite plugin idioms (server-side hook style)

Fastify (5.12.3): a plugin is `async (fastify, opts) => { fastify.decorate(...); fastify.addHook('onRequest', ...); fastify.get(...) }`, registered with `fastify.register(plugin, opts)`. Registration creates an **encapsulated child context** (decorators/hooks only visible to descendants) unless wrapped in `fastify-plugin` (which also records `name`, supported `fastify` version and `dependencies`); `avvio` guarantees ordered, awaited loading. Vite (8.3.0): a plugin is a factory returning `{ name, enforce?: 'pre' | 'post', apply?: 'build' | 'serve' | fn, config, configResolved, configureServer, transformIndexHtml, handleHotUpdate, resolveId/load/transform }`; virtual modules use the `virtual:` / `\0` convention; naming `vite-plugin-*` with a `peerDependency` on `vite`.

Lessons for nooklet's server side: named plugins with declared host-version ranges and inter-plugin dependencies; ordering via `enforce`/priority rather than load order; hook handlers that can *transform or veto* (Vite `transform`, Fastify `preHandler`); a route/handler API that is framework-neutral (nooklet should expose Web-standard `Request`/`Response` rather than Fastify/Express objects, so the HTTP framework can change).

### 2.10 Directus bundles (one npm package, both sides) and its sandbox

Directus "bundle" extensions put several *app* (Vue frontend: interfaces, displays, layouts, modules, panels) and *api* (backend: hooks, endpoints, operations) extensions into one npm package, declared in `package.json` under `directus:extension` with `type: "bundle"` and `entries: [{ type, name, source }]`; `partial: true` lets users disable entries individually; `@directus/extensions-sdk` builds both sides. API extensions get a context (`services, database, getSchema, env, logger`), and can opt into a **sandbox** (`"sandbox": { "enabled": true, "requestedScopes": { "log": {}, "sleep": {}, "request": { "methods": ["GET"], "urls": ["https://example.com/*"] } } }`) in which only `import { log, request, sleep } from 'directus:api'` exist, no Node built-ins, no unbundled npm; the sandbox was built on isolated-vm. This is the best existing template for nooklet's package format: one manifest, typed entries per side, per-entry enable/disable, opt-in sandbox with declared scopes.

### 2.11 Sandbox precedents: Figma, MetaMask Snaps, Zed

- **Figma**: first tried an iframe for plugin logic (rejected: everything async, and serialising a large document cost "14 seconds ... before the plugin could even run"), then the *Realms shim* on the main thread (same JS VM, membrane of opaque handles), then after shim vulnerabilities switched to **QuickJS compiled to WebAssembly**: "it's impossible to confuse internal and external objects because the forms of expression are completely different". Plugin *UI* runs in a null-origin iframe with full browser APIs; the sandbox has no DOM/`fetch`/`setTimeout`; both halves talk via `postMessage`. This is the reference architecture for "untrusted plugins that still render UI".
- **MetaMask Snaps**: untrusted JS runs in an iframe after `lockdown()` (SES/Hardened JS, via LavaMoat); no DOM, no Node built-ins; restricted globals (`fetch`, `WebAssembly`, ...) only via manifest-declared *endowments* (`endowment:network-access`, `endowment:cronjob`...); communication is JSON-RPC. Reference for capability/permission manifests.
- **Zed**: extensions are Rust compiled to `wasm32-wasip2` components against a versioned `zed_extension_api` crate, declared in `extension.toml`; they contribute language servers, themes, slash commands, MCP ("context") servers. WASM gives a hard boundary and a versioned ABI at the cost of a Rust toolchain; not appropriate for a TS-author audience, but the "versioned API crate ↔ host version compatibility table" idea is worth copying.

### 2.12 Comparison

| System | Where plugin code runs | Isolation | UI model | Both sides from one package? | Contribution declaration | DX verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Logseq | iframe (or shadow DOM) in the app | postMessage RPC, whitelisted API; `effect` escape hatch | HTML string templates into slots/selectors | n/a (client only) | code (`register*`) + `useSettingsSchema` | safe-ish, clunky |
| Obsidian | Electron renderer, `require()` | none (Restricted Mode toggle + policies) | real DOM, CM6 extensions | n/a | code (`Plugin` class) | beloved, risky |
| SilverBullet plugs | Web Worker per plug (client only since v2) | syscall boundary, permissions `fetch`/`shell` | markdown/HTML widgets, iframes | v1 yes (removed in v2) | YAML manifest + TS functions | clean, indirect |
| SilverBullet Space Lua | main thread Lua interpreter | time budget + quarantine; `js.*` escape | widgets / DOM builder | client only | code in pages | lowest barrier |
| VS Code | separate process / worker | process boundary (not security) | declarative + webviews | `main` + `browser` entries | `package.json` contributes + activation events | industrial |
| Trilium | `eval` in browser and in the Node server | none; backend scripting now off by default | jQuery/preact widgets | scripts choose side via labels; `runOnBackend` | labels on notes | immediate, dangerous |
| Joplin | BrowserWindow per plugin / iframe / vm | process boundary (has `require`) | webviews + content scripts | n/a | code + manifest | solid, verbose |
| SiYuan | frontend unsandboxed; `kernel.js` in goja inside Go | none / interpreter | real DOM | yes (`index.js` + `kernel.js`) | `plugin.json` + code | practical |
| Home Assistant | server process (Python) | none | n/a | server only | `manifest.json` + `async_setup` | practical |
| Directus | Vue app + Node API | optional isolated-vm sandbox with scopes | Vue components | yes (bundle) | `package.json` `directus:extension` | good template |

---

## 3. Sandboxing options in 2026

| Option | Boundary | DX | Perf | Can render UI? | Status (2026-09) | Verdict for nooklet |
| --- | --- | --- | --- | --- | --- | --- |
| **Trusted `import()`** (Obsidian/HA/Fastify) | none | best (sync-capable, real DOM, any npm) | native | yes | n/a | **default for v1** |
| **`worker_threads` + capability API over `MessagePort`** | crash/latency isolation, `resourceLimits` (heap), `terminate()`; *not* a security boundary (same process, same `fs`) | good if API is async + JSON | structured-clone per call (fine for block-sized payloads; transferables for embeddings) | no (server) | stable; Node permission model (`--permission`, `--allow-fs-read`, `--allow-worker`) is Stable since 23.5 and process-wide | **v1.x upgrade path for the server plugin host** |
| **Web Worker + `postMessage` RPC (comlink / birpc)** | real origin/thread isolation from the app's JS; no DOM | good for logic, indirect for UI | fast | only via HTML strings / sandboxed iframe | Web Workers stable; `comlink` 4.4.2 last published 2024-11 (dormant but works); `birpc` 4.2.0 (2026-08, used by Vitest, transport-agnostic) | **future mode for untrusted client plugins** |
| **`<iframe sandbox>`** (Logseq, Figma UI, Joplin mobile) | browser origin isolation; CSP | UI is easy *inside* the iframe, host integration is awkward | iframe startup cost | yes, but boxed | stable | use for *untrusted UI surfaces* only |
| **ShadowRealm** | same-thread separate realm, callable boundary, no object sharing | attractive (sync) | native | no DOM | **Stage 2.7** per proposal README (Stage-3 request Dec 2024); no browser or Node ships it unflagged; polyfill `shadowrealm-api` 2 years stale | not usable |
| **QuickJS / quickjs-ng via wasm** (`quickjs-emscripten` 0.32.0, 2026-02; `@sebastianwessel/quickjs` 3.1.0, 2026-06) | strongest practical JS boundary (separate interpreter, `setMemoryLimit`, `setInterruptHandler`, `setMaxStackSize`); Figma's choice after Realms | host functions must be marshalled by hand (`vm.newFunction`); no DOM; asyncify build is 2x larger and slower | interpreter, ~10-50x slower than V8 for compute | no (needs iframe for UI) | active; still 0.x semver | **the credible future option for untrusted in-page scripts** |
| **SES / Hardened JS** (`ses` 2.3.0, `@endo/compartment-mapper` 2.4.0, `lavamoat` 11.1.5, 2026-08) | Compartments + frozen intrinsics + endowments; production at Agoric/MetaMask | requires `lockdown()` of the *whole realm* (breaks libraries that mutate prototypes), no DOM; compartment-mapper can load npm packages with least authority | native speed | no | active | viable for a marketplace tier, too invasive as a default |
| **`isolated-vm`** 7.0.1 | true V8 isolate (separate heap, memory/CPU limits) | native addon, `--no-node-snapshot` on Node 20+, manual `Reference`/`Copy` marshalling | native | no | **maintenance mode**; critical sandbox-escape GHSA-864f-rcv7-6rh4 disclosed 2026-08-19 (fixed 6.2.0/7.0.1); README warns leaking any ivm object escapes the sandbox | avoid |
| **`node:vm`** | none ("The `node:vm` module is not a security mechanism", Node 26.8.2 docs); `timeout` exists but `vm.SourceTextModule` is still experimental behind `--experimental-vm-modules` | fine | native | no | stable-but-not-secure | only as a *loader trick* (never as isolation) |
| **WASM components** (Zed/Extism) | hard boundary, versioned ABI | wrong toolchain for TS authors (`@extism/js-pdk` last published 2024-09) | good | no | active for Rust | no |
| **Separate OS process** (VS Code ext host) | crash isolation, can use OS sandboxing | RPC | IPC | no | stable | same benefits as worker with more overhead; worker first |

**Decision.** Trusted `import()` now; API constrained so that the server host can move into a `worker_thread` and untrusted client plugins into Worker + iframe without API changes; QuickJS reserved for a possible later "scripts inside pages" feature. Reasons: the audience writes its own code; the systems with the healthiest plugin ecosystems (Obsidian, VS Code, HA) do not sandbox for security; every sandbox with real teeth costs the DOM and sync access, which is precisely what block renderers and slash commands want; and the only secure in-process option (SES) is invasive while the native one (isolated-vm) is in maintenance mode with a fresh CVE.

---

## 4. Loading mechanism

**Discovery.** Three sources, all producing the same in-memory `PluginPackage`:

1. `plugins/<dir>/package.json` with a `nooklet` field (the normal case; `plugins/` lives in the data directory so it is backed up with the SQLite file).
2. Packages named in server config (`plugins: ["nooklet-plugin-foo"]`) resolved with `import.meta.resolve` from the server's `node_modules` (for plugins installed with `npm i`).
3. Single-file plugins `plugins/<name>.plugin.ts` whose default export is a `definePlugin({...})` with inline `server`/`client` objects (for quick scripts; see §5.2).

**Bundling.** Run esbuild (already a transitive dependency of most TS toolchains; ~10 MB) at load time: server entry → `<data>/.cache/plugins/<id>/server.<hash>.mjs` (`platform: 'node'`, `format: 'esm'`, `external: [node builtins, '@nooklet/plugin-api']`); client entry → `<data>/.cache/plugins/<id>/client.<hash>.js` (`platform: 'browser'`, `format: 'esm'`, TSX allowed, everything bundled). Content hash goes in the file name, which doubles as the cache-busting key. Escape hatch: if `package.json#nooklet.server`/`client` point at `.js`/`.mjs` files, they are used as-is (prebuilt with the author's own toolchain, e.g. `tsdown`/`vite`). (Node ≥ 22.18 can import erasable-syntax `.ts` directly via built-in type stripping, but that neither bundles a plugin's dependencies nor helps the browser side, so esbuild keeps both paths uniform.)

**Loading (server).** `const mod = await import(pathToFileURL(builtFile).href)`; `mod.default` must satisfy `ServerPlugin`; the host builds a `ServerContext` scoped to the plugin id and calls `activate(ctx)`; every registration is pushed into `ctx.subscriptions`; `deactivate()` disposes them in reverse order. Activation errors mark the plugin `error` (shown in Settings → Plugins) but never abort server start (HA "safe mode" behaviour).

**Loading (client).** The server exposes `GET /api/plugins` (enabled plugins, their manifests, client bundle URLs with hashes, settings schemas, and *declared* contributions) and `GET /plugins/<id>/client.<hash>.js`. The PWA fetches the list on boot and after a `plugins.changed` message on the sync socket, then `await import(/* @vite-ignore */ url)` each bundle and calls `activate(ctx)`. The module receives everything through `ctx`; it must not import runtime code from the app (no import maps needed; `@nooklet/plugin-api` is types + tiny helpers that get bundled).

**Hot reload.** A recursive `fs.watch` (or chokidar) on `plugins/` debounces changes per package: `deactivate()` → rebuild → `import()` (new hash ⇒ new module instance) → `activate()` → broadcast `plugins.changed`. ESM modules cannot be evicted from Node's cache (nodejs/node#38322 is still open; the query-string trick just loads another copy), so old module graphs leak until process restart. That is acceptable for a dev loop and exactly what SilverBullet does (explicit `Plugs: Reload`; they turned *automatic* hot reload off after race conditions). When the server host moves to a worker, reload becomes `worker.terminate()` + respawn, with no leak.

**Types for authors: `@nooklet/plugin-api`.** Publish a small package containing: the `ServerContext`/`ClientContext`/`DataApi` interfaces, `defineServerPlugin`/`defineClientPlugin`/`definePlugin` identity helpers, `Disposable` utilities, the manifest JSON schema, and `@nooklet/plugin-api/testing` (an in-memory host that runs `activate` against a temp SQLite database so plugins can be unit-tested with Vitest). Plugins declare it as a `devDependency`/`peerDependency`; the host stamps `host.apiVersion` and `host.version` into `ctx`.

**Versioning / compatibility.** `nooklet.api: "1"` in the manifest (major of the API); `engines.nooklet: ">=0.4"` for host version (like Obsidian's `minAppVersion` and VS Code's `engines.vscode`); the host refuses to load a plugin with an unknown `api` major and warns on unmet `engines`. Within API 1.x changes are additive only; deprecated members keep working for at least one minor and log once. Unstable surface lives under `ctx.experimental.*` and requires `"experimental": true` in the manifest (VS Code proposed-API idea).

---

## 5. Recommended design for nooklet

### 5.1 Principles

1. **One package, two halves, one data API.** `server` and `client` entries; shared TS modules; `DataApi` is the same interface on both sides (server: direct service calls; client: HTTP + local cache through the sync layer).
2. **Context object as the capability bag** (`hass`, `fastify`, Obsidian `this.app`): plugins import nothing from the core at runtime.
3. **Everything you register is a `Disposable`;** `deactivate` disposes all (VS Code `subscriptions`, Obsidian `Component`).
4. **RPC-able API**: async, JSON in/out, callbacks only via `register(...)`. This is the whole upgrade path.
5. **Declarative where it helps discovery**: commands/slash/keybindings/settings/permissions declared in the manifest *or* in code, but the manifest copy lets the host show palettes and settings before/without loading code (VS Code, SilverBullet).
6. **Dogfood**: built-in features that fit the model (Ollama embeddings provider, Logseq importer, the default MCP tools, the mermaid renderer) are implemented as internal plugins using the public API.
7. **Framework-agnostic client API**: plugins get `HTMLElement`s and CSS custom properties, never React internals (Obsidian's secret to stability).

### 5.2 Package format and manifest

```jsonc
// plugins/mermaid/package.json
{
  "name": "nooklet-plugin-mermaid",
  "version": "0.1.0",
  "type": "module",
  "nooklet": {
    "id": "mermaid",                       // stable id, [a-z0-9-], namespaced storage/settings/routes
    "name": "Mermaid diagrams",
    "api": "1",                            // plugin API major
    "server": "./src/server.ts",           // optional
    "client": "./src/client.ts",           // optional
    "permissions": ["net"],                // informational in v1; enforced in worker/sandbox modes. Values: net | fs | shell | env
    "contributes": {                       // optional declarative mirror (host can render before load)
      "commands": [{ "id": "insert", "title": "Mermaid: insert diagram", "keybinding": "mod+shift+m" }],
      "slash": [{ "id": "mermaid", "label": "Mermaid diagram" }]
    },
    "settings": {                          // JSON Schema subset; host renders the settings UI, values sync across devices
      "type": "object",
      "properties": {
        "theme": { "type": "string", "enum": ["default", "dark", "forest"], "default": "default", "title": "Theme" },
        "renderOnServer": { "type": "boolean", "default": false, "description": "Pre-render SVG on the server (needs net permission for CDN fonts)" }
      }
    }
  },
  "engines": { "nooklet": ">=0.4" },
  "devDependencies": { "@nooklet/plugin-api": "^1", "typescript": "^5" },
  "dependencies": { "mermaid": "^11" }
}
```

Single-file variant for scripts (`plugins/wordcount.plugin.ts`):

```ts
import { definePlugin } from '@nooklet/plugin-api'
export default definePlugin({
  id: 'wordcount', api: '1',
  server: { activate(ctx) { /* ... */ } },
  client: { activate(ctx) { /* ... */ } },
})
```
(The loader splits the two objects into separate bundles by tree-shaking the other key; document that top-level imports must be side-effect free and side-specific code must live inside the respective `activate`.)

### 5.3 Runtime model and upgrade path

```
                          ┌──────────────────────────── server (Node) ───────────────────────────┐
plugins/<id>/src/server.ts ─esbuild→ .cache/…/server.<hash>.mjs ─import()→ activate(ServerContext)  │
                          │   ServerContext = thin facade over core services (blocks, pages, …)   │
                          │   registrations → registries (commands, rpc, http, mcp, jobs, …)      │
                          │   HTTP API ─┐  MCP server ─┐  sync ─┐  ← all built on the same core   │
                          └─────────────┴──────────────┴────────┴──────────────────────────────────┘
                                                              │ /api/plugins, /plugins/<id>/client.<hash>.js, sync socket
                          ┌──────────────────────────── client (PWA) ─────────────────────────────┐
plugins/<id>/src/client.ts ─esbuild→ client.<hash>.js ─import()→ activate(ClientContext)           │
                          │   ClientContext = commands, slash, renderers, ui slots, editor, data  │
                          └───────────────────────────────────────────────────────────────────────┘
```

Upgrade path (no API change):

| Stage | Server host | Client host | Trigger |
| --- | --- | --- | --- |
| v1 | in-process `import()` | in-page `import()` | now |
| v1.x | **one `worker_thread` "plugin host"** for all plugins (or one per plugin): `ServerContext` becomes `birpc` stubs over `MessagePort`; registrations become id-based dispatch (Joplin pattern); `resourceLimits`, `terminate()` for reload and runaway loops; `env` scrubbed; `--permission` flags optional | unchanged | crash isolation / clean hot reload / first third-party plugins |
| v2 | same | `mode: "sandboxed"` plugins: logic in a Web Worker, UI via `html()` renderers painted into a sandboxed iframe or via `ctx.ui.panel({ iframe: url })` (Figma/SilverBullet model) | a plugin directory/marketplace |
| later | QuickJS-wasm for in-page scripts if that feature is added | same | user demand |

### 5.4 Extension points, v1

**Server (`ServerContext`)**

| Area | API | Notes |
| --- | --- | --- |
| lifecycle | `activate(ctx)`, `deactivate()` | `ctx.subscriptions` auto-disposed |
| data | `ctx.data.blocks / pages / query / transact` | isomorphic `DataApi` (§5.5) |
| change events | `ctx.events.on('block.created' \| 'block.updated' \| 'block.deleted' \| 'block.moved' \| 'page.created' \| 'page.renamed' \| 'page.deleted' \| 'tx.committed', handler)` | post-commit, async, includes `origin` and `txId`; fired for local *and* synced changes |
| write interception | `ctx.hooks.beforeWrite(handler)` | the one "transform or veto" hook: receives the pending `WriteTx`, may mutate ops or throw; ordered by `priority`; not fired for `origin.kind === 'sync'` (sync must never be rejected) |
| commands | `ctx.commands.register({ id, title, description?, args?: JsonSchema, mcp?: boolean, run(args, info) })` | appears in the client palette (executed over HTTP), callable via `POST /api/commands/<plugin>.<id>`; `mcp: true` auto-exposes it as an MCP tool |
| rpc functions | `ctx.rpc.register(name, fn)` | plugin-private functions for its own client half: `ctx.rpc.call('mermaid.render', src)` on the client |
| HTTP routes | `ctx.http.route('GET' \| 'POST' …, '/path', (req: Request, info) => Response)` | mounted at `/api/plugins/<id>/path`, behind the normal auth by default (`auth: 'none'` opt-out for webhooks with an explicit warning) |
| MCP | `ctx.mcp.registerTool(name, { description, inputSchema, outputSchema?, annotations? }, handler)`; `ctx.mcp.registerResource(...)` | wraps the MCP TS SDK v2 (`@modelcontextprotocol/server` 2.0.0, spec 2026-07-28); tool names are prefixed `<pluginId>_`; the SDK's registration handle (`enable/disable/update/remove`) is what the `Disposable` calls, and the SDK sends `notifications/tools/list_changed` automatically |
| jobs | `ctx.jobs.schedule({ id, every?: '15m', cron?: '0 3 * * *', runOnStart?, run })` | single-flight, persisted last-run in KV, jittered |
| importers / exporters | `ctx.importers.register({ id, title, accepts: ['.md', '.zip'], run(input, target, report) })`, `ctx.exporters.register({ id, title, run(scope) => stream })` | appear in the UI and as `nooklet import/export` CLI |
| embeddings / search | `ctx.embeddings.registerProvider({ id, model, dims, embed(texts) })`, `ctx.search.registerProvider({ id, search(q, opts) })` | Ollama provider is itself a plugin; the active provider is a core setting |
| settings / storage | `ctx.settings.get() / onChange(cb)`; `ctx.storage.get/set/delete/list` | settings schema from manifest; KV in SQLite table `plugin_kv(plugin_id, key, value)` |
| misc | `ctx.log`, `ctx.plugin` (id, version, dir, dataDir), `ctx.host` (version, apiVersion), `ctx.experimental` | |

**Client (`ClientContext`)**

| Area | API |
| --- | --- |
| lifecycle | `activate(ctx)`, `deactivate()`, `ctx.subscriptions` |
| data | same `DataApi` (`ctx.data`) + `ctx.events.on(...)` for the same change events (delivered via the sync socket) and UI events (`page.opened`, `block.focused`, `selection.changed`) |
| commands & keys | `ctx.commands.register({ id, title, icon?, when?, run(info) })`, `ctx.keybindings.bind('mod+shift+m', 'mermaid.insert')`; server commands are merged into the palette by the host |
| slash commands | `ctx.slash.register({ id, label, icon?, keywords?, run(editor: EditorApi) })` |
| renderers | `ctx.render.codeBlock('mermaid', { render(source, el, info) } \| { html(source, info) })`, `ctx.render.macro('youtube', { render(args, el, info) } \| { html(args, info) })` |
| UI slots | `ctx.ui.panel({ id, title, icon, side, mount(el, api) })`, `ctx.ui.blockMenu({ id, title, when?, run(block) })`, `ctx.ui.pageMenu(...)`, `ctx.ui.toolbarButton({ id, icon, title, run })`, `ctx.ui.statusItem(...)`, `ctx.ui.settingsPanel(mount)` |
| feedback | `ctx.ui.notify(msg, opts)`, `ctx.ui.confirm(...)`, `ctx.ui.prompt(...)`, `ctx.ui.modal({ title, mount })` |
| theming | `ctx.ui.style(cssText)` (adopted stylesheet, removed on dispose), `ctx.ui.theme({ id, name, vars })` (CSS custom properties are the theming contract) |
| editor | `ctx.editor` (current page/block, selection, `insertText`, `replaceBlock`, `focusBlock`, `openPage`, `navigate`) |
| bridge | `ctx.rpc.call(name, ...args)` → the plugin's own server functions; `ctx.settings`, `ctx.storage` (per-device, `localStorage`-backed) |

Deliberately *not* in v1: custom block *types* (nooklet blocks stay markdown text; renderers decorate), CodeMirror/ProseMirror extension injection (couples the API to the editor implementation; revisit once the editor is settled), custom views/routes in the client, inter-plugin dependencies, in-page scripting, plugin marketplace.

### 5.5 API shapes (TypeScript sketch)

```ts
// ─── @nooklet/plugin-api ────────────────────────────────────────────────────────
export interface Disposable { dispose(): void }
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export interface PluginManifest {
  id: string; name: string; version: string; api: '1'
  server?: string; client?: string
  permissions?: Array<'net' | 'fs' | 'shell' | 'env'>
  settings?: JsonSchema
  contributes?: { commands?: CommandContribution[]; slash?: SlashContribution[]; keybindings?: KeybindingContribution[] }
  experimental?: boolean
}

export interface ServerPlugin { activate(ctx: ServerContext): void | Promise<void>; deactivate?(): void | Promise<void> }
export interface ClientPlugin { activate(ctx: ClientContext): void | Promise<void>; deactivate?(): void | Promise<void> }
export const defineServerPlugin = (p: ServerPlugin) => p
export const defineClientPlugin = (p: ClientPlugin) => p
export const definePlugin = (p: { id: string; api: '1'; server?: ServerPlugin; client?: ClientPlugin }) => p

// ─── core types ───────────────────────────────────────────────────────────────
export type BlockId = string   // uuid v7
export type PageId = string
export type PropValue = string | number | boolean | string[] | { ref: PageId } | null

export interface Block {
  id: BlockId; pageId: PageId; parentId: BlockId | null
  order: string                      // fractional index among siblings
  content: string                    // markdown source of this block
  properties: Record<string, PropValue>
  refs: Array<{ kind: 'page' | 'tag' | 'block'; target: PageId | BlockId; alias?: string }>   // parsed [[refs]], #tags, ((block refs))
  collapsed: boolean
  createdAt: number; updatedAt: number
}
export interface BlockNode extends Block { children: BlockNode[] }
export interface Page {
  id: PageId; name: string; namespace: string | null; title: string
  kind: 'page' | 'journal'; journalDate?: string
  properties: Record<string, PropValue>
  createdAt: number; updatedAt: number
}

export interface ChangeOrigin { kind: 'user' | 'api' | 'mcp' | 'sync' | 'plugin' | 'import' | 'job'; deviceId?: string; pluginId?: string }

// ─── isomorphic data API (identical on server and client) ─────────────────────
export interface DataApi {
  blocks: BlocksApi
  pages: PagesApi
  query: QueryApi
  transact<T>(fn: (tx: Tx) => Promise<T> | T, opts?: { label?: string }): Promise<T>   // one atomic, one change event batch
}
export interface BlocksApi {
  get(id: BlockId): Promise<Block | null>
  children(parent: BlockId | { page: PageId }): Promise<Block[]>
  tree(root: BlockId | { page: PageId }, opts?: { depth?: number }): Promise<BlockNode[]>
  insert(spec: { content: string; properties?: Record<string, PropValue>; page?: PageId; parent?: BlockId; after?: BlockId | 'first' | 'last' }): Promise<Block>
  update(id: BlockId, patch: { content?: string; properties?: Record<string, PropValue | null>; collapsed?: boolean }): Promise<Block>
  move(id: BlockId, to: { page?: PageId; parent?: BlockId; after?: BlockId | 'first' | 'last' }): Promise<void>
  delete(id: BlockId, opts?: { children?: 'delete' | 'lift' }): Promise<void>
}
export interface PagesApi {
  get(ref: PageId | { name: string }): Promise<Page | null>
  list(opts?: { namespace?: string; kind?: 'page' | 'journal'; limit?: number; cursor?: string }): Promise<{ items: Page[]; cursor?: string }>
  create(spec: { name: string; properties?: Record<string, PropValue>; firstBlock?: string }): Promise<Page>
  rename(id: PageId, name: string): Promise<Page>          // rewrites [[refs]] in content
  delete(id: PageId): Promise<void>
  namespaceTree(root: string): Promise<Array<{ page: Page; children: any[] }>>
  journal(date: string, opts?: { create?: boolean }): Promise<Page | null>
}
export interface QueryApi {
  blocks(q: {
    text?: string                          // FTS
    page?: PageId | { namespace: string }
    refs?: { to: PageId | BlockId }        // linked references
    tags?: string[]
    property?: { key: string; value?: PropValue; op?: 'eq' | 'neq' | 'gt' | 'lt' | 'exists' | 'contains' }
    updatedAfter?: number
    limit?: number; cursor?: string; order?: 'updated' | 'created' | 'page'
  }): Promise<{ items: Block[]; cursor?: string }>
  linkedRefs(target: PageId | BlockId): Promise<Array<{ page: Page; blocks: Block[] }>>
  unlinkedRefs(page: PageId): Promise<Array<{ page: Page; blocks: Block[] }>>
  semantic(text: string, opts?: { limit?: number; page?: PageId }): Promise<Array<{ block: Block; score: number }>>
  /** @experimental read-only SQL against a documented, versioned view layer (v_blocks, v_pages, v_refs). */
  sql?(sql: string, params?: Json[]): Promise<Record<string, Json>[]>
}
export interface Tx extends Omit<DataApi, 'transact'> {}

export interface WriteOp =
  | { type: 'block.insert'; block: Block }
  | { type: 'block.update'; before: Block; after: Block }
  | { type: 'block.move'; block: Block; from: { parentId: BlockId | null; pageId: PageId }; to: { parentId: BlockId | null; pageId: PageId } }
  | { type: 'block.delete'; block: Block }
  | { type: 'page.create' | 'page.rename' | 'page.delete'; page: Page; before?: Page }
export interface WriteTx { id: string; origin: ChangeOrigin; ops: WriteOp[] }

export interface ServerEvents {
  'block.created': { block: Block; origin: ChangeOrigin; txId: string }
  'block.updated': { block: Block; before: Block; origin: ChangeOrigin; txId: string }
  'block.moved':   { block: Block; origin: ChangeOrigin; txId: string }
  'block.deleted': { block: Block; origin: ChangeOrigin; txId: string }
  'page.created' | 'page.renamed' | 'page.deleted': { page: Page; before?: Page; origin: ChangeOrigin; txId: string }
  'tx.committed':  WriteTx
  'plugin.settingsChanged': { settings: Json }
}

// ─── server context ───────────────────────────────────────────────────────────
export interface ServerContext {
  readonly plugin: { id: string; version: string; dir: string; dataDir: string; permissions: string[] }
  readonly host: { version: string; apiVersion: 1 }
  readonly data: DataApi
  readonly events: { on<E extends keyof ServerEvents>(event: E, handler: (payload: ServerEvents[E]) => void | Promise<void>): Disposable }
  readonly hooks: { beforeWrite(handler: (tx: WriteTx) => void | Promise<void>, opts?: { priority?: number }): Disposable }
  readonly commands: {
    register(cmd: { id: string; title: string; description?: string; args?: JsonSchema; mcp?: boolean;
                    run(args: Json, info: { origin: ChangeOrigin }): Promise<Json | void> | Json | void }): Disposable
    run(id: string, args?: Json): Promise<Json | void>
  }
  readonly rpc: { register(name: string, fn: (...args: Json[]) => Promise<Json | void> | Json | void): Disposable }
  readonly http: {
    route(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string,
          handler: (req: Request, info: { params: Record<string, string>; user?: { id: string } }) => Response | Promise<Response>,
          opts?: { auth?: 'required' | 'none' }): Disposable
  }
  readonly mcp: {
    registerTool<I extends ZodObject, O extends ZodObject | undefined>(name: string,
      config: { title?: string; description: string; inputSchema?: I; outputSchema?: O;
                annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } },
      handler: (args: z.infer<I>, extra: { origin: ChangeOrigin }) => Promise<McpToolResult>): Disposable
    registerResource(name: string, uriOrTemplate: string, config: { description?: string; mimeType?: string },
      read: (uri: URL, params: Record<string, string>) => Promise<McpResourceResult>): Disposable
  }
  readonly jobs: { schedule(job: { id: string; every?: string; cron?: string; runOnStart?: boolean; run(signal: AbortSignal): Promise<void> }): Disposable }
  readonly importers: { register(i: { id: string; title: string; accepts: string[];
      run(input: { files: Array<{ name: string; bytes(): Promise<Uint8Array> }> }, target: { namespace?: string }, report: (msg: string) => void): Promise<{ pages: number; blocks: number }> }): Disposable }
  readonly exporters: { register(e: { id: string; title: string; mime: string;
      run(scope: { pages?: PageId[]; all?: boolean }): Promise<ReadableStream<Uint8Array>> }): Disposable }
  readonly embeddings: { registerProvider(p: { id: string; model: string; dims: number; embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> }): Disposable }
  readonly search: { registerProvider(p: { id: string; search(query: string, opts: { limit: number }): Promise<Array<{ blockId: BlockId; score: number }>> }): Disposable }
  readonly settings: { get<T = Json>(): T; onChange(cb: (next: Json, prev: Json) => void): Disposable }
  readonly storage: { get<T extends Json>(key: string): Promise<T | null>; set(key: string, value: Json): Promise<void>; delete(key: string): Promise<void>; list(prefix?: string): Promise<string[]> }
  readonly log: { debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void }
  readonly subscriptions: Disposable[]
  readonly experimental: Record<string, unknown>
}

// ─── client context ───────────────────────────────────────────────────────────
export interface ClientContext {
  readonly plugin: { id: string; version: string }
  readonly host: { version: string; apiVersion: 1; platform: 'desktop' | 'mobile'; theme: 'light' | 'dark' }
  readonly data: DataApi
  readonly events: {
    on<E extends keyof ServerEvents>(event: E, handler: (p: ServerEvents[E]) => void): Disposable
    on(event: 'page.opened', handler: (p: { page: Page }) => void): Disposable
    on(event: 'block.focused' | 'block.blurred', handler: (p: { block: Block }) => void): Disposable
    on(event: 'selection.changed', handler: (p: { blocks: BlockId[] }) => void): Disposable
    on(event: 'theme.changed', handler: (p: { theme: 'light' | 'dark' }) => void): Disposable
  }
  readonly commands: { register(cmd: { id: string; title: string; icon?: string; when?: 'editing' | 'page' | 'always'; run(info: { editor: EditorApi }): void | Promise<void> }): Disposable; run(id: string, args?: Json): Promise<void> }
  readonly keybindings: { bind(keys: string, commandId: string): Disposable }
  readonly slash: { register(item: { id: string; label: string; icon?: string; keywords?: string[]; run(editor: EditorApi): void | Promise<void> }): Disposable }
  readonly render: {
    codeBlock(lang: string, r: CodeBlockRenderer): Disposable
    macro(name: string, r: MacroRenderer): Disposable
  }
  readonly ui: {
    panel(p: { id: string; title: string; icon?: string; side?: 'left' | 'right'; mount(el: HTMLElement, api: { close(): void; setTitle(t: string): void }): Disposable | void }): Disposable
    blockMenu(item: { id: string; title: string; icon?: string; when?(block: Block): boolean; run(block: Block, editor: EditorApi): void }): Disposable
    pageMenu(item: { id: string; title: string; icon?: string; run(page: Page): void }): Disposable
    toolbarButton(b: { id: string; title: string; icon: string; run(): void }): Disposable
    statusItem(s: { id: string; mount(el: HTMLElement): Disposable | void }): Disposable
    settingsPanel(mount: (el: HTMLElement) => Disposable | void): Disposable
    style(css: string): Disposable
    theme(t: { id: string; name: string; mode: 'light' | 'dark'; vars: Record<`--${string}`, string> }): Disposable
    notify(message: string, opts?: { kind?: 'info' | 'success' | 'warning' | 'error'; timeout?: number }): void
    confirm(message: string): Promise<boolean>
    prompt(message: string, opts?: { placeholder?: string; initial?: string }): Promise<string | null>
    modal(m: { title: string; mount(el: HTMLElement, api: { close(): void }): Disposable | void }): { close(): void }
  }
  readonly editor: EditorApi
  readonly rpc: { call<T extends Json = Json>(name: string, ...args: Json[]): Promise<T> }
  readonly settings: { get<T = Json>(): T; onChange(cb: (next: Json, prev: Json) => void): Disposable }
  readonly storage: { get<T extends Json>(key: string): T | null; set(key: string, value: Json): void; delete(key: string): void }   // per-device
  readonly log: ServerContext['log']
  readonly subscriptions: Disposable[]
  readonly experimental: Record<string, unknown>
}

export type CodeBlockRenderer =
  | { render(source: string, el: HTMLElement, info: RenderInfo): void | Disposable | Promise<void | Disposable> }   // trusted mode
  | { html(source: string, info: RenderInfo): string | Promise<string> }                                             // sandbox-able (painted into a sandboxed iframe in v2)
export type MacroRenderer =
  | { render(args: string[], el: HTMLElement, info: RenderInfo & { raw: string }): void | Disposable | Promise<void | Disposable> }
  | { html(args: string[], info: RenderInfo & { raw: string }): string | Promise<string> }
export interface RenderInfo { block: Block; page: Page; lang?: string; meta?: string; editing: boolean; signal: AbortSignal }

export interface EditorApi {
  currentPage(): Page | null
  currentBlock(): Block | null
  selection(): { blocks: BlockId[]; text?: string }
  insertText(text: string, opts?: { cursor?: number }): Promise<void>          // at caret; `|^|`-style placeholder supported via opts.cursor
  replaceBlock(id: BlockId, content: string): Promise<void>
  insertBlockAfter(id: BlockId, content: string): Promise<Block>
  focusBlock(id: BlockId, opts?: { at?: 'start' | 'end' | number }): void
  openPage(ref: PageId | { name: string }, opts?: { sidebar?: boolean }): Promise<void>
  navigate(path: string): void
}
```

Design notes on the shapes:

- `DataApi` is the *only* way plugins touch content on either side. On the server it wraps the same service layer the HTTP API and MCP tools use; on the client it is a thin HTTP client plus the local cache/optimistic layer of the sync engine, so a plugin that only uses `ctx.data` and `ctx.events` can share code between halves verbatim.
- Every change event carries `origin`; the host sets `origin.kind = 'plugin', pluginId` for writes made through a plugin's context so plugins can ignore their own writes (Logseq's `txMeta.outlinerOp` is the poor man's version of this).
- `beforeWrite` is the single interception point. It is enough for "validate", "auto-tag", "normalise properties", "reject deletes of protected pages"; it is deliberately not offered for `sync` origin because sync must converge.
- `commands.mcp: true` and `ctx.mcp.registerTool` both exist: the first is the 80% case with zero boilerplate (the host derives the tool from `args` JSON schema and `description`), the second gives full control (`outputSchema`, annotations, resources).
- Renderers accept either `render(el)` (trusted, full DOM) or `html()` (pure function of source → HTML string). Authors choose; the sandboxed hosting mode will only run the second form and paint it into a sandboxed iframe with the plugin's `style()` sheets.

### 5.6 How plugins touch the core primitives

| Primitive | Plugin surface | Implementation note |
| --- | --- | --- |
| Block tree ops | `ctx.data.blocks.*`, `ctx.data.transact` | same `BlockService` as `/api/blocks` and MCP; fractional `order`; all mutations create a `WriteTx` → `beforeWrite` hooks → commit → events → sync broadcast |
| Pages / namespaces / journals | `ctx.data.pages.*` | `rename` rewrites `[[refs]]` inside content in the same tx |
| Refs / linked & unlinked refs | `Block.refs`, `ctx.data.query.linkedRefs / unlinkedRefs` | `refs` table maintained by the core parser on every write |
| Queries | `ctx.data.query.blocks(...)` structured object, FTS `text`, `semantic` | a structured object (not a DSL) is stable, typeable and RPC-able; a text DSL can be layered on later for users; `sql` stays `@experimental` against versioned SQL views |
| Commands | `ctx.commands.register` on either side | a single registry; server commands are executed via `POST /api/commands/<id>`; the palette merges both; keybindings are client-side and refer to command ids |
| UI slots | `ctx.ui.panel / blockMenu / pageMenu / toolbarButton / statusItem / settingsPanel`, `ctx.render.codeBlock / macro` | slots are *named* and *owned by the host* (no arbitrary selectors, unlike Logseq `provideUI({ path })`), so layout changes in the app do not break plugins |
| MCP tools | `ctx.mcp.registerTool / registerResource`, `commands.mcp` | one `McpServer` instance in the core; plugins add/remove tools at runtime via the SDK's registration handles, which emit `list_changed` for connected clients |
| HTTP API | `ctx.http.route` | mounted under `/api/plugins/<id>/`, Web-standard `Request`/`Response`, host auth in front |
| Settings | manifest `settings` schema + `ctx.settings` | stored in `plugin_settings(plugin_id, json)`, synced; generic form rendered by the host; `settingsPanel` for custom UI |
| Embeddings / search | provider registration | the core owns the vector table and the indexing job; providers only compute vectors / rank |

### 5.7 End-to-end example: one package, both halves

```ts
// plugins/mermaid/src/shared.ts
export const LANG = 'mermaid'
export function extractTitle(src: string) { return /^%%\s*title:\s*(.+)$/m.exec(src)?.[1] ?? null }
```

```ts
// plugins/mermaid/src/server.ts
import { defineServerPlugin } from '@nooklet/plugin-api'
import * as z from 'zod/v4'
import { LANG, extractTitle } from './shared'

export default defineServerPlugin({
  async activate(ctx) {
    // 1. keep a `diagram-title` property in sync with the diagram source (write interception)
    ctx.hooks.beforeWrite((tx) => {
      for (const op of tx.ops) {
        if (op.type === 'block.update' && op.after.content.startsWith('```' + LANG)) {
          const title = extractTitle(op.after.content)
          op.after.properties = { ...op.after.properties, 'diagram-title': title }
        }
      }
    })

    // 2. an MCP tool for LLMs
    ctx.mcp.registerTool('list_diagrams', {
      description: 'List mermaid diagrams in the graph, optionally filtered by page',
      inputSchema: z.object({ page: z.string().optional(), limit: z.number().int().max(100).default(20) }),
      annotations: { readOnlyHint: true },
    }, async ({ page, limit }) => {
      const { items } = await ctx.data.query.blocks({ text: '```' + LANG, limit, ...(page ? { page: { namespace: page } } : {}) })
      return { content: [{ type: 'text', text: items.map(b => `${b.id}: ${extractTitle(b.content) ?? '(untitled)'}`).join('\n') }] }
    })

    // 3. a private function the client half calls (server-side render needs `net` for fonts)
    ctx.rpc.register('renderSvg', async (source: string) => renderWithPuppeteerOrCli(source, ctx.settings.get().theme))

    // 4. a nightly job
    ctx.jobs.schedule({ id: 'stats', cron: '0 3 * * *', async run() {
      const { items } = await ctx.data.query.blocks({ text: '```' + LANG, limit: 1000 })
      await ctx.storage.set('count', items.length)
      ctx.log.info(`mermaid: ${items.length} diagrams`)
    } })

    // 5. a command, also exposed to MCP automatically
    ctx.commands.register({ id: 'count', title: 'Mermaid: count diagrams', mcp: true,
      run: async () => ({ count: (await ctx.storage.get<number>('count')) ?? 0 }) })
  },
})
```

```ts
// plugins/mermaid/src/client.ts
import { defineClientPlugin } from '@nooklet/plugin-api'
import mermaid from 'mermaid'          // bundled into client.<hash>.js by the host's esbuild step
import { LANG } from './shared'

export default defineClientPlugin({
  activate(ctx) {
    mermaid.initialize({ startOnLoad: false, theme: ctx.settings.get().theme })
    ctx.settings.onChange(s => mermaid.initialize({ startOnLoad: false, theme: s.theme }))

    ctx.render.codeBlock(LANG, {
      async render(source, el, info) {
        if (ctx.settings.get().renderOnServer) {
          el.innerHTML = await ctx.rpc.call<string>('renderSvg', source)   // talk to our server half
        } else {
          const { svg } = await mermaid.render(`m-${info.block.id}`, source)
          el.innerHTML = svg
        }
        if (info.signal.aborted) return
        return { dispose() { el.replaceChildren() } }
      },
    })

    ctx.slash.register({ id: 'mermaid', label: 'Mermaid diagram', keywords: ['diagram', 'graph'],
      run: (editor) => editor.insertText('```mermaid\ngraph TD\n  A --> B\n```', { cursor: 22 }) })

    ctx.commands.register({ id: 'insert', title: 'Mermaid: insert diagram', when: 'editing',
      run: ({ editor }) => editor.insertText('```mermaid\n\n```', { cursor: 11 }) })
    ctx.keybindings.bind('mod+shift+m', 'mermaid.insert')

    ctx.ui.style(`.nooklet-render[data-lang="mermaid"] svg { max-width: 100%; }`)

    ctx.ui.panel({ id: 'diagrams', title: 'Diagrams', icon: 'flowchart', side: 'right',
      mount(el) {
        const list = document.createElement('ul'); el.append(list)
        const refresh = async () => {
          const { items } = await ctx.data.query.blocks({ text: '```' + LANG, limit: 50 })
          list.replaceChildren(...items.map(b => { const li = document.createElement('li'); li.textContent = b.properties['diagram-title'] as string ?? b.id;
            li.onclick = () => ctx.editor.focusBlock(b.id); return li }))
        }
        refresh()
        const sub = ctx.events.on('block.updated', refresh)
        return { dispose: () => sub.dispose() }
      } })
  },
})
```

The same package on disk:

```
plugins/mermaid/
├── package.json        (nooklet field above)
├── src/shared.ts
├── src/server.ts
├── src/client.ts
└── node_modules/       (only if the plugin has deps; `npm i` inside the plugin dir)
```

### 5.8 Host-side loader sketch (server)

```ts
// packages/server/src/plugins/host.ts (sketch)
export class PluginHost {
  private active = new Map<string, { pkg: PluginPackage; mod: ServerPlugin; subs: Disposable[]; hash: string }>()

  async loadAll() { for (const pkg of await discover(this.pluginsDir, this.config)) await this.load(pkg).catch(e => this.markError(pkg, e)) }

  async load(pkg: PluginPackage) {
    assertApiMajor(pkg.manifest.api, 1); assertEngines(pkg, HOST_VERSION)
    const { file, hash } = await bundleServer(pkg)            // esbuild, cached by content hash
    const mod = (await import(pathToFileURL(file).href)).default as ServerPlugin
    const subs: Disposable[] = []
    const ctx = createServerContext({ pkg, subs, core: this.core, mcp: this.mcp, http: this.http, jobs: this.jobs, log: this.log.child(pkg.id) })
    await mod.activate(ctx)
    this.active.set(pkg.id, { pkg, mod, subs, hash })
    this.broadcast({ type: 'plugins.changed' })
  }

  async unload(id: string) {
    const a = this.active.get(id); if (!a) return
    try { await a.mod.deactivate?.() } finally { for (const d of a.subs.reverse()) safeDispose(d) }
    this.active.delete(id)
  }

  async reload(id: string) { const pkg = this.active.get(id)?.pkg ?? await discoverOne(id); await this.unload(id); await this.load(pkg) }
  // fs.watch(pluginsDir, { recursive: true }) → debounce per package → reload(id)
}
```

The context factory is where the "RPC-able" discipline is enforced: `createServerContext` only closes over registries and services, never leaks core objects with methods on them, and every `register*` returns a `Disposable` that removes the entry from the registry (for MCP: calls the SDK handle's `remove()`).

### 5.9 Dev loop

- `nooklet plugin new <id>` scaffolds the package with `@nooklet/plugin-api`, TS config and a Vitest test using `@nooklet/plugin-api/testing`.
- `nooklet dev` (or the normal server with `NOOKLET_DEV=1`) watches `plugins/`, rebuilds, reloads server halves, and pushes `plugins.changed` so the open PWA re-imports client bundles (with `?v=<hash>`); errors show in a "Plugins" settings page with the stack trace, like Logseq's plugin dashboard and SilverBullet's console guidance.
- Client bundles are served with `Cache-Control: immutable` keyed by hash; server bundles are cached under `.cache/`.

### 5.10 Compatibility policy

- `api: "1"` is the contract; additive changes only within 1.x; breaking changes ⇒ `api: "2"` with a period of dual support in the host (Logseq's 0.0.x vs 0.2/0.3 split is the cautionary tale: publish the new line under the *same* package with a clear major, keep the `latest` tag honest).
- `engines.nooklet` is checked but only warns unless the host is older than the minimum.
- Anything under `ctx.experimental` may change in any release and requires `experimental: true`.
- Deprecations: keep for ≥1 minor, warn once per process.

### 5.11 Non-goals for v1 (and how the design keeps the door open)

| Later feature | Prepared by |
| --- | --- |
| Third-party plugin directory | manifest `permissions`, worker host mode, `html()` renderers, `Disposable` discipline |
| In-page scripting (SilverBullet/Trilium style) | client-only, QuickJS-wasm sandbox with the same `DataApi` marshalled as host functions; never server-side (Trilium's kill-switch is the lesson) |
| Editor-level extensions (CM6/PM plugins) | hold until the editor stack is final; expose under `ctx.experimental.editor` first |
| Custom block types | today's renderers + properties; a future `ctx.render.blockType` can reuse `RenderInfo` |
| Inter-plugin APIs | `ctx.rpc` names are already namespaced by plugin id; add `ctx.plugins.call('<id>.<fn>')` when needed (SilverBullet's `system.invokeFunction`) |

---

## 6. Risks and open questions

1. **Reload leaks in-process.** Acceptable in dev; production reloads should be rare. The worker host mode removes the issue; consider shipping it early if plugin churn is high.
2. **`beforeWrite` and sync convergence.** Hooks are skipped for `sync` origin; document that a plugin that *rejects* local writes cannot rely on the same rule being applied on other devices unless the plugin is installed there too (server-side hooks run once, on the server, for all devices, which is the whole point of having a server half).
3. **Plugin deps in the browser bundle.** Big libraries (mermaid ≈ 1 MB) bloat client bundles; lazy `import()` inside `activate` plus hash-immutable caching mitigates. Consider a per-plugin size budget warning.
4. **MCP SDK churn.** v2 (`@modelcontextprotocol/server` 2.0.0) is very new; keep the SDK behind `ctx.mcp` so plugins never import it directly, and pin zod v4.
5. **Renderers and mobile.** `render(el)` renderers run on phones too; `host.platform` and `RenderInfo.signal` exist so plugins can degrade; a per-render time budget with a visible "renderer timed out" placeholder (SilverBullet's pattern) is worth adding to the host.
6. **Auth for `ctx.http` routes.** Default `auth: 'required'`; the `'none'` opt-out exists for webhooks but must be surfaced in the plugin list (Trilium's unauthenticated custom handlers are a known foot-gun).

---

## 7. Sources

Logseq
- Plugin API docs: https://plugins-doc.logseq.com/ and TypeDoc https://logseq.github.io/plugins/
- `@logseq/libs` on npm (dist-tag `latest` 0.0.17; versions up to 0.3.4): https://www.npmjs.com/package/@logseq/libs ; typings inspected from https://unpkg.com/@logseq/libs@0.3.4/dist/LSPlugin.d.ts
- Samples: https://github.com/logseq/logseq-plugin-samples ; marketplace README (manifest fields incl. `effect`, `supportsDB`): https://github.com/logseq/marketplace
- Plugin system internals (LSPluginCore, iframe sandbox, postMessage protocol): https://deepwiki.com/logseq/logseq/6.1-plugin-system ; `lsp://` protocol thread: https://discuss.logseq.com/t/is-any-one-known-why-plugin-iframe-is-using-lsp-protocol/18656
- DB version docs (2026-04-28): https://github.com/logseq/docs/blob/master/db-version.md ; DB plugins thread: https://discuss.logseq.com/t/logseq-db-plugins/34717

Obsidian
- Typings repo: https://github.com/obsidianmd/obsidian-api (`obsidian.d.ts`, npm `obsidian` 1.13.1, 2026-06-09) ; community internals typings: https://github.com/Fevol/obsidian-typings
- Plugin security / Restricted mode: https://obsidian.md/help/plugin-security ; Developer policies: https://docs.obsidian.md/Developer+policies (source: obsidianmd/obsidian-developer-docs, `en/Community directory/Developer policies.md`)

SilverBullet
- Plugs: https://silverbullet.md/Plugs ; Development: https://silverbullet.md/Plugs/Development ; Architecture: https://silverbullet.md/Plugs/Development/Architecture ; Reference: https://silverbullet.md/Plugs/Development/Reference
- Space Lua: https://silverbullet.md/Space%20Lua ; Widgets: https://silverbullet.md/Space%20Lua/Widget ; JS interop: https://silverbullet.md/Space%20Lua/JavaScript%20Interop ; API index: https://silverbullet.md/API
- Manifest types: https://github.com/silverbulletmd/silverbullet/blob/main/plug-api/types/manifest.ts and https://github.com/silverbulletmd/silverbullet/blob/main/client/plugos/types.ts
- ADR-005 Space Lua: https://github.com/silverbulletmd/silverbullet/blob/main/docs/Architecture/ADR/005%20Space%20Lua.md ; ADR-007 Core Application Logic on the Client: https://github.com/silverbulletmd/silverbullet/blob/main/docs/Architecture/ADR/007%20Core%20Application%20Logic%20on%20the%20Client.md ; ADR-008 Go Backend / ADR-010 Rust Backend in the same folder ; CHANGELOG: https://github.com/silverbulletmd/silverbullet/blob/main/docs/CHANGELOG.md
- npm `@silverbulletmd/silverbullet` 2.10.0 (2026-07-28): https://www.npmjs.com/package/@silverbulletmd/silverbullet ; releases: https://github.com/silverbulletmd/silverbullet/releases

Other plugin systems
- VS Code extension host: https://code.visualstudio.com/api/advanced-topics/extension-host
- Trilium scripting: https://triliumnext.github.io/Docs/Wiki/script-api.html ; custom request handler: https://triliumnext.github.io/Docs/Wiki/custom-request-handler.html ; source: `packages/trilium-core/src/services/script_context.ts`, `script.ts`, `backend_script_api.ts`, `apps/server/src/services/scripting_guard.ts`, `apps/client/src/services/frontend_script_api.ts`, `bundle.ts` in https://github.com/TriliumNext/Trilium
- Joplin plugin architecture spec: https://joplinapp.org/help/dev/spec/plugins/ ; API reference: https://joplinapp.org/api/references/plugin_api/classes/joplin.html
- SiYuan plugin sample (plugin.json, lifecycle, `src/kernel.ts`, kernel-plugin design spec 2026-05-09): https://github.com/siyuan-note/plugin-sample ; bazaar: https://github.com/siyuan-note/bazaar
- Home Assistant custom integrations: https://developers.home-assistant.io/docs/creating_component_index/
- Fastify plugins: https://fastify.dev/docs/latest/Reference/Plugins/ ; Vite plugin API: https://vite.dev/guide/api-plugin.html
- Directus bundles: https://directus.com/docs/guides/extensions/bundles ; API extension sandbox: https://directus.com/docs/guides/extensions/api-extensions/sandbox
- Figma: https://www.figma.com/blog/how-we-built-the-figma-plugin-system/ ; https://www.figma.com/blog/an-update-on-plugin-security/ ; https://developers.figma.com/docs/plugins/how-plugins-run/
- MetaMask Snaps execution environment: https://docs.metamask.io/snaps/learn/about-snaps/execution-environment/
- Zed extensions: https://zed.dev/docs/extensions/developing-extensions

Sandboxing
- ShadowRealm proposal (Stage 2.7): https://github.com/tc39/proposal-shadowrealm
- quickjs-emscripten (0.32.0): https://github.com/justjake/quickjs-emscripten ; @sebastianwessel/quickjs (3.1.0): https://github.com/sebastianwessel/quickjs
- SES / Hardened JS (`ses` 2.3.0): https://github.com/endojs/endo/blob/master/packages/ses/README.md ; compartment-mapper: https://github.com/endojs/endo/tree/master/packages/compartment-mapper ; LavaMoat: https://www.npmjs.com/package/lavamoat
- isolated-vm (7.0.1, maintenance mode; GHSA-864f-rcv7-6rh4): https://github.com/laverdet/isolated-vm ; https://www.npmjs.com/package/isolated-vm
- Node `vm` ("not a security mechanism"): https://nodejs.org/api/vm.html ; `worker_threads` (`resourceLimits`, not a security boundary): https://nodejs.org/api/worker_threads.html ; Permission model (`--permission`, Stable): https://nodejs.org/api/permissions.html
- comlink 4.4.2: https://github.com/GoogleChromeLabs/comlink ; birpc 4.2.0: https://www.npmjs.com/package/birpc
- ESM cache busting limitations: https://github.com/nodejs/node/issues/38322 ; https://ar.al/2021/02/22/cache-busting-in-node.js-dynamic-esm-imports/

MCP
- TS SDK v2 docs (spec 2026-07-28; `@modelcontextprotocol/server` 2.0.0): https://ts.sdk.modelcontextprotocol.io/v2/ ; tools: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html ; notifications and registration handles (`enable/disable/update/remove`, automatic `list_changed`): https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/notifications.md ; legacy `@modelcontextprotocol/sdk` 1.30.0: https://www.npmjs.com/package/@modelcontextprotocol/sdk
