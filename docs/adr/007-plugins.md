# ADR 007: Plugins: one package, optional server and client halves, trusted ESM in v1

Date: 2026-09-10. Status: accepted.

## Decision

- A plugin is a directory with a `nooklet` manifest in `package.json` (id, API version, optional
  `server` and `client` entries, JSON-schema settings, permissions, declared contributions), or
  a single `*.plugin.ts` for quick scripts. Shared code is an ordinary shared module.
- The data API (`blocks`, `pages`, `query`, `transact`) is the same TypeScript interface on both
  sides: server halves call core services, client halves go through the HTTP API and the local
  replica. A client half calls its server half over RPC.
- v1 runtime is trusted: the host bundles each entry with esbuild and `import()`s it; the trust
  boundary is the plugins directory. The UI states that plugins run with full access.
- The API is written so a sandbox can be added later without changing it: every call is async
  with JSON-serializable arguments and results; callbacks enter the host only through
  `register(...)` functions returning disposables; client renderers may be `render(source, el)`
  (trusted) or `html(source) => string` (sandboxable). Upgrade path: server halves in a
  `worker_thread` (v1.x), untrusted client halves in a Web Worker with sandboxed iframes (v2).
- Extension points are enumerated in `PLAN.md` section 13 and kept small. Slots are named and
  host-owned; plugins get `HTMLElement`s, never framework components.
- Built-in optional features ship as internal plugins to keep the API honest.

## Why

- Obsidian's simple trusted `Plugin` class with auto-cleanup registration is what made its
  ecosystem; SilverBullet's sandboxed portable runtime was abandoned in 2025 because two runtimes
  were "a persistent burden" for authors. nooklet needs server-authoritative features (MCP, jobs,
  hooks), so two explicit halves with one shared interface beats one portable runtime.
- Sandboxes with real teeth (QuickJS-wasm, workers) all cost DOM and sync access, which is what
  renderers and slash commands want; `isolated-vm` is in maintenance with a 2026 escape CVE;
  `node:vm` is not a security boundary; ShadowRealm has shipped nowhere.

## Consequences

- Node cannot evict ES modules, so in-process hot reload leaks old module graphs; acceptable in
  development and solved by the worker host later.
- MCP is reached through `ctx.mcp`, never by importing the SDK directly, so SDK upgrades stay
  the host's problem.

## Confirmation

User confirmed trusted plugins for v1 on 2026-09-10.
