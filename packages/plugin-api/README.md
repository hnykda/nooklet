# `@nooklet/plugin-api`

Types (and a couple of tiny runtime helpers: `defineOp`, `definePlugin`, `OpError`,
`validateManifest`, `assertApiSupported`) that a nooklet plugin is written against. This package
has no runtime dependency on `@nooklet/server` — it is safe to import from code that runs in the
browser, in the server process, or in both.

If you are building the plugin host itself, this package is also the contract you implement
against: `ServerPluginContext`/`ClientPluginContext` are what you construct and hand to a plugin's
`activate()`.

## What a plugin is

A nooklet plugin is a directory with a `nooklet` key in its `package.json`, or a single
`*.plugin.ts` file for a quick script. It can implement either or both of two independent
**halves**:

- a **server half** — runs inside the nooklet server process. It can register ops (which become
  HTTP routes, OpenAPI operations, and MCP tools all at once), subscribe to write events, veto or
  rewrite writes before they land, run background jobs, and register importers/exporters.
- a **client half** — runs inside the nooklet UI. It can render code blocks and macros, add slash
  commands, palette commands, panels, and menu items, and talk to the editor. **Today** (ADR 023)
  the web app runs only the built-in plugins' client halves, compiled into its build, and
  implements part of `ClientPluginContext` — slash and palette commands, code-block renderers,
  status items, `page.opened`/`page.changed`, `rpc`; the rest throws naming itself. The list is in
  `docs/spec/api-and-plugin-types.md` §5, "What the v1 client host implements".

Both halves see the same `ctx.data` (`DataApi`): blocks, pages, query, all as one atomic
`transact`. A client half calls into its own server half over `ctx.rpc` — that is a private,
plugin-owned RPC channel, separate from `ctx.data` (which always talks to core, never to a
plugin's own code).

**v1 trust model — read this before writing a plugin.** v1 plugins are **trusted, unsandboxed
ESM**: the host bundles your entry files with esbuild and `import()`s them directly. Your code has
full Node access on the server half (filesystem, network, child processes — whatever
`permissions` you declare is informational only in v1, not enforced) and full DOM access on the
client half. There is no security boundary between a plugin and the host in v1. Only install
plugins you trust, same as an Obsidian plugin or a VS Code extension before those ecosystems grew
review processes. The API is deliberately shaped so a real sandbox can be added later (async
calls, JSON-serializable arguments, `register(...)`-returned disposables, an optional `html()`
renderer form) without changing plugin code — see ADR 007 — but that sandbox does not exist yet.

## The manifest

```jsonc
// plugins/mermaid-tools/package.json
{
  "name": "nooklet-plugin-mermaid-tools",
  "version": "0.1.0",
  "type": "module",
  "nooklet": {
    "id": "mermaid-tools", // stable, [a-z0-9-]+; namespaces your kv/settings/routes/rpc
    "name": "Mermaid + word count",
    "api": "1", // plugin API major you're targeting — see "Versioning" below
    "server": "./src/server.ts", // optional
    "client": "./src/client.ts", // optional — declare at least one of the two
    "permissions": [], // "net" | "fs" | "shell" | "env" — informational in v1
    "contributes": { "slash": [{ "id": "mermaid", "label": "Mermaid diagram" }] }
  },
  "engines": { "nooklet": ">=0.4" },
  "dependencies": { "mermaid": "^11" }
}
```

`contributes` declares commands/slash-items/keybindings **ahead of code loading**, so the palette,
slash menu, and keymap UI can show them (and detect conflicts) before your plugin's `activate()`
ever runs. You still have to actually `registerCommand`/`registerSlashCommand` the matching `id`
in code — `contributes` is metadata, not a substitute for registration.

Validate a manifest before trusting it (the host does this at discovery time; plugin authors can
use it to catch typos before shipping):

```ts
import { validateManifest } from "@nooklet/plugin-api";

const result = validateManifest(JSON.parse(packageJsonText).nooklet);
if (!result.valid) {
  for (const e of result.errors) console.error(`${e.path || "(manifest)"}: ${e.message}`);
}
```

### Quick scripts: the single-file form

No `package.json` needed for a one-off:

```ts
// plugins/wordcount.plugin.ts
import { definePlugin } from "@nooklet/plugin-api";

export default definePlugin({
  id: "wordcount",
  api: "1",
  server: {
    activate(ctx) {
      /* ... */
    },
  },
  client: {
    activate(ctx) {
      /* ... */
    },
  },
});
```

## Worked example: both halves, end to end

A `/mermaid` code-block renderer on the client, and a `page.wordcount` op on the server exposed as
both an HTTP route and an MCP tool.

```ts
// plugins/mermaid-tools/src/server.ts
import { defineOp, OpError } from "@nooklet/plugin-api";
import type { ServerPluginModule } from "@nooklet/plugin-api";
import { z } from "zod";

export default {
  async activate(plugin) {
    plugin.ops.register(
      defineOp({
        name: "page.wordcount",
        summary: "Count words in a page",
        description:
          "Counts words across all blocks of a page or journal day. Read-only and cheap; " +
          "call before deciding whether to read the full page.",
        input: z
          .object({
            page: z.string().min(1).max(512).describe('Page name, journal date (YYYY-MM-DD), or "today"'),
          })
          .strict(),
        output: z.object({ page: z.string(), block_count: z.number().int(), word_count: z.number().int() }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        scopes: ["read"],
        // Plugin ops default to HTTP-only (mcp: false) — opt in explicitly to appear in tools/list.
        expose: { http: true, mcp: true },
        render: (out) => `${out.page}: ${out.word_count} words across ${out.block_count} blocks`,
        async handler({ page }, opCtx) {
          const target = await opCtx.data.pages.get({ name: page });
          if (!target) throw new OpError("not_found", `no page named "${page}"`, "check the exact name with page.list");
          const tree = await opCtx.data.blocks.tree({ page: target.id });
          let blockCount = 0;
          let wordCount = 0;
          const walk = (nodes: typeof tree) => {
            for (const n of nodes) {
              blockCount++;
              wordCount += n.content.split(/\s+/).filter(Boolean).length;
              walk(n.children);
            }
          };
          walk(tree);
          return { page: target.name, block_count: blockCount, word_count: wordCount };
        },
      }),
    );
  },
} satisfies ServerPluginModule;
```

```ts
// plugins/mermaid-tools/src/client.ts
import type { ClientPluginModule } from "@nooklet/plugin-api";

export default {
  async activate(ctx) {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ startOnLoad: false });

    ctx.registerCodeBlockRenderer("mermaid", {
      async render(source, el) {
        const { svg } = await mermaid.render(`m-${crypto.randomUUID()}`, source);
        el.innerHTML = svg;
      },
    });

    ctx.registerSlashCommand({
      id: "mermaid",
      label: "Mermaid diagram",
      keywords: ["diagram", "graph"],
      run: (editor) => editor.insertText("```mermaid\ngraph TD\n  A --> B\n```"),
    });
  },
} satisfies ClientPluginModule;
```

Neither half calls `deactivate()`: every registration (`ops.register`, `registerCodeBlockRenderer`,
`registerSlashCommand`) returns a `Disposable` the host already tracks — see "Lifecycle" below.

`page.wordcount` is now reachable three ways, all from the one `defineOp` call:

```
POST /api/v1/page.wordcount
{ "page": "today" }

200 OK
{ "page": "2026-09-10", "block_count": 14, "word_count": 132 }
```

and as an MCP tool named `page_wordcount` (`.` becomes `_`) in `tools/list`, with the `input`
schema, `annotations`, and `render()`-produced text nooklet's other 15+ core ops also expose.

## `DataApi`: the one interface both halves share

```ts
ctx.data.pages.get({ name: "Projects/Nooklet" });
ctx.data.blocks.tree({ page: pageId }, { depth: 2 });
ctx.data.blocks.insert({ page: pageId, content: "- a new block" });
ctx.data.query.blocks({ tags: ["urgent"], order: "updated" });
await ctx.data.transact(async (tx) => {
  const page = await tx.pages.create({ name: "Scratch" });
  await tx.blocks.insert({ page: page.id, content: "first block" });
}); // one atomic write, one change-event batch
```

It is byte-identical on both halves (server: a thin wrapper over core services + the op write
path; client: HTTP calls to the same ops plus the local sync replica cache for reads), so shared
code that only touches `ctx.data` runs unmodified on either side. Property values are always
`string`, or `null` in a patch to unset a key. Journal pages are addressed by ISO `YYYY-MM-DD` (or
`"today"`/`"yesterday"`/`"tomorrow"`), never the internal `YYYYMMDD` integer.

## Server context highlights (`ServerPluginContext`)

- `ctx.on("block.created" | "block.updated" | "block.moved" | "block.deleted" | "page.*" |
  "tx.committed", handler)` — every payload carries `origin` (who/what made the write: user, api,
  mcp, sync, plugin, import, mirror, system).
- `ctx.beforeWrite(handler)` — transform the pending ops in place, or `throw` to veto the write
  entirely. **Never invoked for `origin.kind === "sync"`** — a plugin veto on an incoming sync
  write would fork devices, so sync always converges regardless of what plugins think.
- `ctx.registerCommand`, `ctx.rpc.expose`, `ctx.registerRoute`, `ctx.registerMcpTool` /
  `ctx.registerMcpResource`, `ctx.registerJob`, `ctx.registerImporter` / `ctx.registerExporter`,
  `ctx.registerEmbeddingProvider` / `ctx.registerSearchProvider` — every one of these returns a
  `Disposable`.
- `ctx.ops.register(opDef)` — the full `defineOp` escape hatch when a `registerCommand`/RPC isn't
  enough and you want the same HTTP+OpenAPI+MCP treatment as a core op.
- `ctx.settings` / `ctx.kv` — per-plugin persisted JSON, namespaced by your manifest `id`.

## Client context highlights (`ClientPluginContext`)

- `ctx.registerCodeBlockRenderer(lang, { render(source, el) })` or `{ html(source) => string }` —
  see "Renderers: `render` vs `html`" below.
- `ctx.registerMacroRenderer`, `ctx.registerSlashCommand`, `ctx.registerPanel`,
  `ctx.registerMenuItem("block" | "page", item)`, `ctx.registerToolbarItem`,
  `ctx.registerStatusItem`, `ctx.registerKeybinding(keys, commandId)`.
- `ctx.editor` — `currentPage()`, `currentBlock()`, `selection()`, `insertText`, `replaceBlock`,
  `insertBlockAfter`, `focusBlock`, `openPage`, `navigate`.
- `ctx.notify` / `ctx.confirm` / `ctx.prompt` / `ctx.modal` for host-native UI instead of rolling
  your own toasts/dialogs.
- `ctx.rpc.call(name, ...args)` — calls the matching `ctx.rpc.expose(name, fn)` on your *own*
  server half. This is not the same channel as `ctx.data`.

### Renderers: `render` vs `html`

```ts
type CodeBlockRenderer =
  | { render(source: string, el: HTMLElement, info: RenderInfo): void | Disposable | Promise<...> }
  | { html(source: string, info: RenderInfo): string | Promise<string> };
```

`render(el)` gets a real `HTMLElement` and full DOM access — the only form v1 actually runs, and
what the worked example above uses. `html(source) => string` is a pure function with no DOM
access at all. Prefer `html()` when your renderer can be expressed that way (no event listeners,
no external mutable state): it costs nothing extra in v1 and is the only form a future sandboxed
v2 client host (untrusted plugins, Web Worker + iframe) will call. If you need real interactivity
(click handlers, a live-updating widget), you need `render()`, and your plugin will need to stay
in the trusted set once a v2 sandbox exists.

## Lifecycle

```ts
interface ServerPluginModule {
  activate(ctx: ServerPluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
```

Every `register*`/`on`/`beforeWrite`/`ops.register` call returns a `Disposable`
(`{ dispose(): void }`). You never call `.dispose()` yourself and you never need to keep the
returned value around — the host pushes it onto your plugin's private list and calls `dispose()`
on **every** entry, **in reverse registration order**, when your plugin is disabled, hot-reloaded,
or the server shuts down. This is Obsidian's `Component`/`register()` pattern made fully
automatic: Obsidian requires you to call `this.register(disposable)` yourself; here every
host-owned registration function already does that for you.

Only implement `deactivate()` for cleanup that happened **outside** a `register*` call — a raw
`setInterval`, an open child process, a WebSocket you opened by hand. A plugin that only ever used
`register*`/`on` (like the worked example above) needs no `deactivate()` at all.

## Versioning

`nooklet.api` is a string **major** — `"1"` for the whole v1 API described here. Within `1.x`,
changes to this package are additive-only (new optional fields, new `register*` methods, new
event names); nothing that compiles against API `1.0` will stop compiling against a later `1.x`.
A breaking change (removing/renaming a field, an incompatible `register*` signature, changed
default `expose` semantics) ships as `api: "2"` — the host would then run two context factories
side by side so `"1"` and `"2"` plugins load at once, with a deprecation window before `"1"`
support is dropped. See `src/api-version.ts` for the exact compatibility check
(`assertApiSupported`) the host runs before calling your `activate()`; an unsupported `api` marks
your plugin `error` in Settings → Plugins without stopping the server or any other plugin.

## Package layout

| Module | Contents |
| --- | --- |
| `data.ts` | `DataApi`, `BlocksApi`, `PagesApi`, `QueryApi`, `BlockNode`, `PropertyPatch` |
| `op-def.ts` | `defineOp`, `OpDef`, `OpContext`, `OpError`, `Scope`, `OpAnnotations`, `Origin`, `Actor` |
| `manifest.ts` | `PluginManifest`, `PluginContributes`, `validateManifest` |
| `define-plugin.ts` | `definePlugin`, `ServerPluginModule`, `ClientPluginModule` |
| `server-context.ts` | `ServerPluginContext` and everything it registers |
| `client-context.ts` | `ClientPluginContext`, `EditorApi`, renderer/panel/menu types |
| `command.ts` | `Command`, `CommandKeys`, `Platform` |
| `api-version.ts` | `assertApiSupported`, `isApiSupported`, `SUPPORTED_API_MAJORS` |
| `disposable.ts` / `json.ts` | `Disposable`, `Json` |

Full normative spec: `docs/spec/api-and-plugin-types.md`. Design rationale: `docs/adr/007-plugins.md`.
