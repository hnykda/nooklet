# 09 — Live UI control: an agent watching and driving a running vrite client

*Research date: 2026-09-10. Motivated by ADR 013 §2 ("the live running client should be
observable and controllable by an agent, not just the underlying graph"). Builds on PLAN.md §3/§6/
§12/§14, ADR 003 (sync/poke), ADR 009 + `docs/spec/commands-and-keymap.md` (the `Command`/`when`
registry), ADR 008 + `docs/spec/mcp-tools.md` (the existing 18-tool headless MCP surface), and ADR
005 (packaging). All external facts below were verified by web search/fetch on this date; where a
claim is general industry knowledge rather than a specific verified fact, it is marked as such
rather than given a citation it doesn't have. This report proposes a design; it does not amend
`docs/spec/mcp-tools.md` or `docs/spec/commands-and-keymap.md` — a follow-up ADR does that once
M2 starts.*

---

## 0. TL;DR

| Question | Recommendation | Why (short) |
|---|---|---|
| Transport | A **second, dedicated WebSocket** (`/ui/live`), not a multiplexed extension of the sync "poke" socket | The UI-control channel is opt-in and per-window; the sync socket is mandatory and correctness-critical (ADR 003's property-tested convergence guarantee). Keeping them separate makes "is an agent connected to this window" literally equal to "is this second socket open" — the same fact the consent badge shows the user — and never risks the sync protocol for an unrelated feature |
| Addressing | A `window_id` (random per-tab session id, not synced, not the device id) sent in the socket's `hello`; the server keeps an in-memory table of live `(device_id, window_id)` sessions, never persisted | A device can have several open tabs/windows; sync's `device_id` already exists but identifies the SQLite replica, not one on-screen window |
| Server-queryable state | A JSON snapshot that is, almost verbatim, the `WhenContext`/`CommandContext` vrite's own command dispatcher already computes before every keydown (`docs/spec/commands-and-keymap.md` Interfaces) — page, focused/selected block(s), cursor offset, viewport, open panel/dialog | Reuses a data shape the client already maintains; no second "what is the UI doing" model to keep in sync |
| Server-pushable commands | The **same** `Command` registry (ADR 009), invoked by `command_id` + `args` exactly as `commands-and-keymap.md` R4 already anticipates ("`run(ctx)` MUST be idempotent-safe to invoke from ... the HTTP API's command-invocation op, if exposed") | 100% reuse, zero new editing primitives; two small additions needed — `nav.openPage`/`nav.revealBlock` — for the two things no keybinding-driven command does today (jump straight to a known page/block with no picker) |
| New MCP tools | `ui_list_windows`, `ui_get_state`, `ui_run_command`, and two thin wrappers `ui_navigate`/`ui_highlight` (§2.5) | Matches the task's own naming; wrappers exist because "open a page" and "look at a block" are the two things an agent will do constantly and a raw `command_id` is one extra hop for the common case |
| MCP resource vs. tool | **Tools now**, an `vrite://ui/state` resource **later**, in parallel not instead | 2026-07-28 added exactly the primitive this needs (`resources` capability's `subscribe`, `subscriptions/listen`, `notifications/resources/updated`) — but Claude Code (the user's own primary client) surfaces resources only as manual `@mentions`, not something an autonomous agent loop polls, so a tool is the only path that works everywhere today |
| Consent/visibility | A persistent, always-visible status-bar badge with three states (off / observed / controlled); two independent per-window, per-device, unsynced toggles — "let agents view this window" (default **on**) and "let agents control this window" (default **off**); a distinct flash highlight on whatever block a remote command just touched | The user explicitly wants people to *feel* the control is happening, not have it be silent; escalating from "see" to "act" mirrors how much trust each grants |
| Scopes | A new capability flag `ui:control`, orthogonal to `read`/`write`/`admin` | An agent's data-write token should not automatically be able to drive the human's screen, and vice versa — these are different trust decisions even though a live-UI edit and an API edit end up as the same kind of op |
| Destructive commands | No synchronous confirmation dialog (defeats the "watch it happen" point and drags in MRTR elicitation round-trips); instead every op a remote command produces with `destructiveHint: true` shows a toast with one-tap Undo backed by the existing `batch_undo` | vrite already has no unsaved-state concept and everything destructive is soft-deleted/undoable (ADR 013); a blocking dialog would be security theater for actions that are already free to reverse |
| Packaging | No change needed across PWA/Capacitor/Tauri (or a hypothetical Electron build) — it rides the same WS to the same server every build already opens | This is exactly ADR 005's own argument for why SolidJS doesn't lock out native shells, one level up: the *feature*, not just the UI framework, is packaging-agnostic because nothing here is OS-level automation |
| Strongest prior art | **VS Code's Language Model Tools API + Copilot Chat's editor context**, not any browser-automation tool | It is the only precedent that is *also* "an app with its own internal command registry and focus/selection model, now exposed to an LLM over a semantic, non-pixel channel" — the literal shape of this task |

---

## 1. Prior art

### 1.1 Browser automation / "computer use" — the wrong shape for this problem, and why

**Chrome DevTools Protocol (CDP)** is the ~300-command JSON/WebSocket protocol every real browser automation tool is built on. It is genuinely semantic in places — it does not require pixel coordinates or screenshots to know what is on a page — but it is a *browser*-level API (DOM domain, Accessibility domain, Input domain, Page domain), not an *application*-level one: it knows about DOM nodes, not about "which vrite block is focused." Playwright and Puppeteer both wrap it; Playwright's own MCP server, notably, does **not** send screenshots or raw HTML to the model — it sends the browser's accessibility tree, "a structured, semantic, text-based representation of the page" ([Steve Kinney, "Driving vs. Debugging the browser"](https://stevekinney.com/writing/driving-vs-debugging-the-browser)). A 2026 benchmark found Puppeteer beats Playwright 15–20% on raw CDP tasks because it stays closer to the wire (11 KB vs. 326 KB of WebSocket traffic for the same job) — evidence that even among CDP-based tools, "closer to the app's own semantics, less generic infrastructure" wins on both speed and clarity ([Lightpanda, "CDP vs Playwright vs Puppeteer"](https://lightpanda.io/blog/posts/cdp-vs-playwright-vs-puppeteer-is-this-the-wrong-question)). The official CDP getting-started guide itself warns "think twice before using CDP directly for browser automation — you'll be better off with Playwright" ([aslushnikov/getting-started-with-cdp](https://github.com/aslushnikov/getting-started-with-cdp/blob/master/README.md)) — i.e. even CDP's own maintainers steer people toward a higher-level layer.

**Anthropic's own "computer use" reference tool** is the other end of the spectrum: a Docker container running a desktop, driven by screenshots in and synthetic mouse/keyboard events out. Its own advocates are candid about the cost: "every single click or keystroke costs a full round trip — Claude takes a screenshot, uploads it, processes it, decides, responds, executes… expect 2–5 seconds per action depending on the model and screenshot resolution," and Anthropic's own guidance is to prefer it for "background information gathering, automated testing, batch processing" — not latency-sensitive collaboration ([Riza, "Getting Started with Claude Computer Use"](https://riza.io/blog/claude-computer-use); [AI SDK cookbook, "Computer Use"](https://ai-sdk.dev/cookbook/guides/computer-use)). Screenshots also burn vision tokens on every step. Its one real virtue — "works with any application without integration code" — is precisely the virtue vrite does not need: vrite owns both ends of the connection (its own client, its own server), so there is nothing to reverse-engineer visually.

**Browser-extension "agent controls the browser" tools** (Browser Use, BrowserMCP, `browser-control-mcp`, and similar 2025–2026 projects) exist to solve a problem vrite does not have: a plain web page does not natively expose CDP or any command channel to an outside agent, so these projects install a **browser extension** — which *does* have elevated privileges (`chrome.tabs`, `chrome.scripting`, content scripts) — as a bridge between a local MCP server and the page the human already has open, or alternatively launch a fresh, automation-flagged browser instance via Playwright/Puppeteer that the human never actually uses interactively. Browser MCP's own description makes the trade explicit: it automates *your existing logged-in browser session* locally, at the cost of needing an installed extension and per-site DOM heuristics for "click this, type that" ([Browser MCP docs](https://docs.browsermcp.io/setup-extension); [BrowserMCP/mcp](https://github.com/browsermcp/mcp); [eyalzh/browser-control-mcp](https://github.com/eyalzh/browser-control-mcp)). **None of this machinery is relevant to vrite.** vrite is not a third-party page an agent must break into from outside — it is vrite's own first-party client, already holding an authenticated WebSocket to vrite's own server. The entire reason browser-automation tools need an extension, a CDP handshake, or screenshots is that they are outside the application; vrite's agent integration is designed from *inside* it, the same way a plugin is (PLAN §13). This is the single biggest reason "computer use" and "browser use" are the wrong template despite superficially being "an AI controlling a running web UI."

### 1.2 App-native command/state buses — the right shape

**VS Code's Language Model Tools API + Copilot Chat's editor-context model is the closest existing analogue**, and the strongest piece of prior art found in this survey, because it is the only precedent that combines *exactly* vrite's two pre-existing ingredients: an app with its own internal, declarative command registry, and a live notion of "what document/selection is active right now," now exposed to an LLM over a structured channel rather than pixels.

- Extensions register tools via a manifest contribution point, `contributes.languageModelTools`, giving each tool a `name`, `displayName`, a `modelDescription` written for the LLM, a JSON Schema `inputSchema`, and — notably — a `when` clause that gates the tool's *availability* on editor state (e.g. `"debugState == 'running'"`), then link the manifest entry to an implementation with `vscode.lm.registerTool` ([VS Code docs, "Language Model Tool API"](https://code.visualstudio.com/api/extension-guides/ai/tools)). This is structurally identical to vrite's own `Command.when` — a boolean expression evaluated against a context snapshot before the action is offered — except VS Code applies the same idea to *tool availability for an LLM*, not just to a human's keybinding/palette. vrite can do the same: a `Command`'s existing `when` clause is exactly the check `ui_run_command`'s handler needs to run before invoking `run(ctx)` remotely, with no new gating language to invent.
- The chat surface "automatically includes the active file, your current selection, and the file name as context" on every request — this is VS Code doing, unprompted, what `ui_get_state` does on request: handing the model a live snapshot of what the human is looking at (search result summary, verified via VS Code's own documentation).
- Consent is a **generic confirmation dialog before every tool invocation**, customizable per-tool via a `prepareInvocation` lifecycle hook that produces a human-readable message, with an explicit "Always Allow" escape hatch for repeat use — tools cannot bypass it (VS Code docs, same page). This is a directly reusable pattern for vrite's "destructive command" question (§2.6), and — more importantly for the "make it feel powerful, not silent" goal — VS Code treats *telling the user a tool is about to touch their live editor* as a first-class, non-optional UX obligation, not an afterthought.

**Figma's plugin API and its 2026 MCP server** are the second-best analogue, for a different reason: they show what "write to a live, currently-open creative document" looks like when the writes are *structured operations against a document object model*, never raw pixels. Figma's write path explicitly reuses "your existing components and variables to produce real design system assets" — generating frames, components, and variables through the same object model a human-driven plugin would use, not by drawing shapes at coordinates — and is scoped to when a human actually has the file open in the desktop app, gated by seat type (Dev seats get read-only outside their own drafts; write access needs a Full seat) ([Figma blog, "Agents, Meet the Figma Canvas"](https://www.figma.com/blog/the-figma-canvas-is-now-open-to-agents/); [Figma Dev Mode MCP Server docs](https://developers.figma.com/docs/figma-mcp-server/); [Figma, "write to canvas"](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas)). The lesson for vrite: gate write-shaped remote commands by an explicit capability the way Figma gates canvas-write by seat, and always express the write as a structured operation the app's own model already understands (a `Command`, a block op) — never as a pixel-level "click here."

**Weaker, supporting precedent** (mentioned in the task, checked, genuinely less concrete): Cursor's chat "automatically assembles context by including the active file and your cursor position" on every message, with the team explicitly removing a manual `/add-active-tabs` command in favor of automatic detection — the same "hand the model live editor state without being asked" pattern as Copilot Chat ([Cursor community forum discussion](https://forum.cursor.com/t/how-can-i-set-cursor-to-use-all-open-tabs-as-the-context/15155); [Dre Dyson, "Why /add-active-tabs Was Removed"](https://dredyson.com/the-beginners-guide-to-cursors-context-system-why-add-active-tabs-was-removed-and-how-to-adapt/)). Obsidian's community AI plugins (Smart Composer, "AI Copilot") layer a chat panel that can be pointed at "your current note, selected text, or entire vault" via manual `@`-mentions, and several already speak MCP as a *client* — but none of them exposes Obsidian's own internal command palette for an agent to invoke, and none pushes live state without being asked ([Smart Composer on GitHub](https://github.com/glowingjade/obsidian-smart-composer); [AI Copilot plugin listing](https://community.obsidian.md/plugins/ai-copilot)). This confirms the note-taking-app category has not yet built what vrite is proposing; VS Code and Figma, both from adjacent categories, are the real templates.

### 1.3 Home Assistant's WebSocket API — the transport-pattern reference already in the user's own toolset

Home Assistant's WebSocket API is one persistent, authenticated connection carrying state *out* and commands *in*, and it is worth studying precisely because the user already depends on an MCP server built on top of it every day. Two message shapes matter:

```json
// client → server: subscribe to live state
{ "id": 18, "type": "subscribe_events", "event_type": "state_changed" }
```
```json
// client → server: issue a command ("service call")
{ "id": 24, "type": "call_service", "domain": "light", "service": "turn_on",
  "service_data": { "entity_id": "light.kitchen" } }
```

State changes arrive as `event` messages pushed asynchronously on the same socket after a `subscribe_events` request; a `call_service` message gets no return value beyond an ack — the caller observes the *effect* through the state-change event stream it is already subscribed to, not through the command's own response ([Home Assistant Developer Docs, "WebSocket API"](https://developers.home-assistant.io/docs/api/websocket/)). This is the cleanest existing "one channel, two directions" precedent, and its core idea — subscribe once, get a stream of state deltas, issue commands separately, correlate the command's effect by watching the stream rather than trusting the command's own ack — is worth carrying into vrite's design (§2.3's `state.get`/`state` push split; a command's effect is confirmed by the resulting op's `seq`, not just a bare "ok").

Where the HA precedent *diverges* from vrite's needs, and why vrite should not copy it literally: every Home Assistant client that opens this socket wants both state and control, always, for as long as it's connected — there is no "observe but don't control" tier, because a dashboard is useless without both. vrite's live-UI channel is explicitly **opt-in and asymmetric** (§2.6: viewing defaults on, controlling defaults off), which argues for keeping it off the always-on sync socket entirely rather than multiplexing it the way HA multiplexes everything onto one socket (§2.1).

### 1.4 MCP's own primitives: resources with `subscribe`, not just tools

The 2026-07-28 spec (the version ADR 008 already targets) has a **native primitive for exactly "a resource that represents live, subscribable state,"** and it did not exist in earlier MCP versions in this form. A server declares:

```json
{ "capabilities": { "resources": { "listChanged": true, "subscribe": true } } }
```

A client that wants live updates for a specific resource sends a `subscriptions/listen` request naming the resource's URI in `notifications.resourceSubscriptions`; the server then delivers `notifications/resources/updated` on that stream whenever the watched resource changes, e.g.:

```json
{ "jsonrpc": "2.0", "method": "notifications/resources/updated",
  "params": { "_meta": { "io.modelcontextprotocol/subscriptionId": 4 }, "uri": "file:///project/src/main.rs" } }
```

— after which the client re-issues `resources/read` to fetch the new content ([MCP spec, "Resources," 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)). This is a materially better fit for "current UI state" than any bespoke tool-polling loop: a resource URI like `vrite://ui/window/{window_id}` could be `resources/read` for a one-shot snapshot and `subscriptions/listen`-subscribed for a live feed, with no vrite-specific protocol invented at all — this is precisely research question 4's proposed alternative, and the spec supports it natively.

**Why tools are still the right primary surface for vrite today, per §2.5's recommendation:** resource *reading* is application-driven in MCP's own user-interaction model — "applications could expose resources through UI elements for explicit selection… allow the user to search and filter… implement automatic context inclusion" (same spec page) — it is not something the protocol guarantees an autonomous agent loop will pull on its own. `docs/research/07-api-mcp.md` §2.1 already recorded, from the same verification pass ADR 008 relied on, that "Claude Code surfaces \[resources\] as `@vrite:vrite://page/Foo` mentions" — i.e. a manual, human-driven picker action, not something an agentic tool-use loop reaches for mid-task. A tool call, by contrast, is exactly what every surveyed MCP client (Claude Code, Claude Desktop via the stdio bridge, Cursor) already drives autonomously. So: **ship `ui_get_state`/`ui_run_command` as tools now** (guaranteed to work everywhere vrite's other 18 tools work), and add the `vrite://ui/window/{id}` resource with `subscribe` **in parallel, not as a replacement**, once M2's client exists — it costs little to also expose and benefits any future host that does drive resource subscriptions autonomously, without being load-bearing for day one.

---

## 2. Design for vrite

### 2.1 Transport: a second WebSocket, not an extension of "poke"

ADR 003's sync channel is deliberately minimal: `POST /sync/push`, `GET /sync/pull`, `GET /sync/snapshot`, plus a WebSocket whose entire vocabulary today is `{type: 'poke', seq}` — a one-way, fire-and-forget "something changed, go pull" nudge (`docs/research/03-sync.md` §6.5). It is always open, per-device, and protected by property tests proving the state tables are a pure function of the op log (ADR 003's "Consequences"). Live-UI control needs the opposite risk profile: it is **optional** (off by default for control, per §2.6), **per-window** rather than per-device, and involves genuinely new duplex request/response semantics (the server asks a specific tab a question and waits for an answer with a correlation id) that the sync channel was never designed to carry.

**Recommendation: a dedicated `/ui/live` WebSocket**, authenticated the same way the client already authenticates sync (its existing per-device session), opened by the client **only** while the human has the "let agents view this window" toggle on (§2.6) and closed the instant they turn it off. This gives one clean invariant that both the implementation and the consent UI can rely on: *the socket being open is the feature being active* — the persistent badge in §2.6 is, literally, "is `/ui/live` connected," with no separate enable/disable flag to keep in sync with the visible affordance the way CDP needs explicit per-domain `Domain.enable`/`Domain.disable` calls to avoid a firehose when nobody's watching (a real cost CDP pays that this design avoids by construction).

The alternative — multiplexing UI-control messages onto the existing sync socket by `type`, the way Home Assistant multiplexes everything onto one socket (§1.3) — was considered and rejected for vrite specifically (not as a general pattern; HA's own choice is right for HA, where every connected client wants both halves always). Reasons: (1) it would require adding an enable/disable sub-negotiation to a channel ADR 003 currently treats as a single trusted primitive, raising the blast radius of any bug in the new code for a channel PLAN's own risk table calls out as needing protection ("Hand-rolled sync bugs → property-based multi-device simulation… kept forever"); (2) it decouples "is this feature active" from "is a socket open," which is exactly the ambiguity the consent design (§2.6) needs to *not* have; (3) PLAN's own scope-creep mitigation is "ADR for every new subsystem" — this is a new subsystem, and giving it a small, separately-reasoned-about connection matches that philosophy better than growing the sync protocol's surface for an unrelated concern.

### 2.2 Identity: window, not device

A device (one SQLite replica, one sync connection identity per ADR 003/004) can have several browser tabs or windows open at once — the client's own architecture already elects "one writer tab" for the SQLite worker via `navigator.locks` (`docs/research/03-sync.md` §6.9), which is implicit acknowledgment that multiple tabs of the same device are a normal case, not an edge case. Live-UI state is inherently per-*window* (which tab has the cursor, what page is on screen in that specific tab), so it needs its own identity distinct from `device_id`:

- On load, each window mints a `window_id` (a random client-generated id, kept in `sessionStorage` so it survives a reload but not a new tab/window — a fresh tab is a fresh window for this purpose, matching what a human means by "this window").
- The `/ui/live` connection's opening `hello` message carries `{ device_id, window_id, client, control_enabled }`; the server keeps an **in-memory only** table of live `(device_id, window_id)` sessions — this state is inherently ephemeral (it describes "what is on screen right now," which stops being true the instant a tab closes) and, unlike the op log, is never something a `rebuild()` needs to reproduce or a backup needs to preserve.
- Multi-window resolution policy (for `ui_get_state`/`ui_run_command`'s optional `window_id` input): 0 live windows is a normal, non-error state everywhere (§2.3). Exactly 1 live window: used automatically, no `window_id` needed — this covers the overwhelming common case (one person, one open tab) with zero friction. **More than 1 live window: the policy differs by whether the tool reads or acts.** `ui_get_state`/`ui_list_windows` default to the most-recently-active window (the one that last reported a focus/visibility change) and always return the full `other_windows` list alongside the resolved one, so an agent immediately sees the ambiguity existed even though it wasn't blocked by it — a read has no cost to guessing wrong once, and forcing a disambiguation round-trip before every read would make the common "just tell me what's on screen" case clunky for no safety benefit. `ui_run_command` (and its `ui_navigate`/`ui_highlight` wrappers) is stricter: with `window_id` omitted and more than one live window, it returns `ambiguous_window` with `details.windows` listing candidates (id, device, current page, last-active time) rather than guessing — acting on the wrong window autonomously is a materially worse failure than reading the wrong one, and this is the one place this design deliberately does *not* optimize away a round trip.

### 2.3 State the server can query from a live client

The minimum viable snapshot is, almost verbatim, the `WhenContext`/`CommandContext` the client's own command dispatcher already computes before every keydown and before every palette/menu render (`docs/spec/commands-and-keymap.md`, Interfaces) — this is a deliberate design economy: vrite does not need a second "what is the user doing" model built for agents, it needs to serialize the one it already has.

```ts
interface UiWindowState {
  window_id: string;
  device_id: string;
  focused: boolean;                 // this window is the frontmost one, if the platform can tell
  page: { id: string; name: string; kind: 'page' | 'journal' } | null;
  zoom_root_block_id: string | null;                       // WhenContext.zoomed, resolved to an id
  focus: {
    mode: 'editing' | 'block_selection' | 'none';          // editorFocused / blockSelected / neither
    block_id: string | null;                                // focused block, or selection anchor
    selected_block_ids: string[];                           // [] unless mode == 'block_selection'
    cursor: { anchor: number; head: number } | null;        // offsets into the focused block's content; null unless mode == 'editing'
  };
  viewport: { first_visible_block_id: string | null; last_visible_block_id: string | null; scroll_top: number };
  panels: { sidebar_open: boolean; active_view: string; dialog_open: string | null };  // e.g. dialog_open: "scheduled-date-picker" | "command-palette" | null
  updated_at: string;               // ISO-8601, when this snapshot was taken
}
```

`focus`/`zoom_root_block_id` map 1:1 onto `WhenContext`'s `editorFocused`, `blockSelected`, `selectionCount`, `zoomed` and `CommandContext`'s `focusedBlockId`/`selectedBlockIds` (`docs/spec/commands-and-keymap.md` Interfaces) — deliberately, so that anything the command dispatcher can already answer about "what's focused right now" needs no new tracking code, just a serializer. **"No client is currently open" is reported as `{ live: false, windows: [] }`, a normal completed `ui_get_state`/`ui_list_windows` result, never an error** — this needs to be explicit because it is the single most common state for any self-hosted personal tool (the human is usually not looking at it while an agent works headlessly through the other 18 tools), and the whole point of ADR 013's framing is that the live-UI capability is *additive* on top of an API that already works with nobody watching.

On the wire, `/ui/live` supports both a pull and a (rate-limited) push model, mirroring the HA lesson of §1.3 that a command's effect should be confirmed by watching state change, not just trusted from the command's own ack:

```json
// server → client, on-demand (backs a fresh ui_get_state call)
{ "type": "state.get", "request_id": "r1" }
// client → server
{ "type": "state.result", "request_id": "r1", "state": { "...": "UiWindowState" } }

// server → client, only sent while ≥1 MCP caller holds a live subscription (§1.4's future resource path)
{ "type": "state.subscribe" }
{ "type": "state.unsubscribe" }
// client → server, debounced ~150–250 ms while subscribed, coalescing keystroke-level cursor moves
{ "type": "state.push", "state": { "...": "UiWindowState" } }
```

The `state.subscribe`/`unsubscribe` pair exists for the same reason CDP gates most domains behind an explicit `enable` call: state changes on every keystroke, and streaming that continuously to a server nobody is currently querying would be pure overhead. It is enabled only while an MCP resource subscription (§1.4/§2.5) is actually open, and unused entirely if a caller only ever does one-shot `ui_get_state` polls via `state.get`.

### 2.4 Commands the server can push to a live client

**Recommendation: reuse the full `Command` registry by id, not a narrower hand-picked allowlist — gated by the same `when` clause every command already declares, plus one new per-command flag and the existing scope model.** `docs/spec/commands-and-keymap.md` R4 already anticipates exactly this: "`run(ctx: CommandContext)` MUST be idempotent-safe to invoke from any of: a keydown match, a palette/slash-menu selection, a mobile toolbar tap, a block/page context-menu click, **the HTTP API's command-invocation op (if exposed)**, and another command's `ctx.exec(...)` call." A remote `ui_run_command` call is simply one more entry on that list, not a new invocation mode the command author has to think about — every command is already contractually required to behave correctly when triggered this way.

Concretely, on receiving `command.run` over `/ui/live`, the client:
1. Looks up `command_id` in the registry; unknown id → `invalid`.
2. Builds a `CommandContext` from the window's **current, actual** focus state (exactly the same context a keydown would use — there is no separate "remote" context) and evaluates the command's `when` against it; `false` → a normal (non-error) `when_result: 'skipped_when_false'`, since this is an expected outcome (e.g. an agent calling `task.setPriorityA` on a block that isn't a task), not a fault.
3. Runs `command.run(ctx)`, exactly as a keybinding would.
4. Replies with the result and, if the run produced graph mutations, forces an immediate `/sync/push` for those ops rather than waiting for the normal 300 ms debounce (ADR 003 §6.5) — the whole reason a caller uses the live-UI channel instead of the headless `page_append`/`block_update` tools is speed, so its "did it happen" answer should not itself wait on an unrelated batching window. The reply then carries the real `server_seq` from that push's ack, matching the `WriteResult.seq` idiom the rest of the MCP surface already returns (`docs/spec/mcp-tools.md` §4.1) — so `ui_run_command`'s output can be chained into `changes_since`/`batch_undo` exactly like any other write.

**Origin/attribution consequence for the future ADR:** because the resulting op is minted client-side and pushed through the normal sync path — not through the server's `applyOps`-from-HTTP/MCP path — the client needs to know to tag it `origin: 'mcp'` (the existing enum already has this value, `docs/spec/mcp-tools.md` §4.1's `Origin`) with `actor` = the calling token's label, rather than the `'user'` it would stamp for a real keypress, so the `changes` audit trail and the UI's "changed by agent X" badge (PLAN §11) stay accurate. The server's `command.run` message therefore needs to carry `{ actor, client }` alongside `command_id`/`args`, and the client's op-emission path needs an optional origin override it does not need for ordinary local edits. This is a small, well-contained addition to flag for the implementation, not a redesign of anything in ADR 003.

**Scope policy — should a remote agent be able to run *any* command, including `app.quit` or `sync.now`?** No v1 core command is intrinsically dangerous in the way `app.quit` would be (no such command exists in `docs/spec/commands-and-keymap.md`'s tables today — it would only appear in a future Tauri-specific extension of the registry), and `sync.now` is harmless (it only forces an earlier pull/push). The recommended policy is therefore a **default-allow list gated by a new, explicit opt-out flag** rather than a hand-maintained allowlist that has to be kept in sync with every future command: extend `Command` with an optional `remoteInvocable?: boolean` (default `true`); core sets it `false` only on commands that act outside the document model entirely — a hypothetical future `app.quit`, a factory-reset, an uninstall-plugin action, anything touching credentials/tokens. On top of that binary flag, `ui_run_command`'s handler must still check the calling token's **existing** scopes for whatever the command actually does: a read-only-scoped token can run `nav.*`/`search.open`/`app.toggleSidebar` (no graph mutation) but not `block.update`/`block.delete`-shaped commands, exactly as it already cannot call the corresponding `block_update`/`block_delete` MCP tools today (`docs/spec/mcp-tools.md` §4.2's per-tool `scopes`). This means the live-UI channel never becomes a way to route around the read/write/admin scope model that already protects the headless API — it is a new *transport* for the same permissions, not a new permission surface, aside from the `ui:control` gate in §2.6 that sits in front of all of it.

**Two small additions the registry needs**, because no existing keybinding-driven command does "jump straight to a known page/block with no picker" (every `nav.*` command today opens an interactive picker or a fixed destination — `nav.switchPage`, `nav.todayJournal`, `nav.journals`, none of which take a target page as an argument):
- `nav.openPage` — id area `nav`, no default keybinding, `when: 'true'`, args `{ page: PageRef, blockId?: BlockId }`: sets the router directly to the given page (and zoom root, if `blockId` given), pushing a navigation-history entry exactly as any other `nav.*` command does (R42). This is the direct-open primitive `ui_navigate` wraps; it is equally useful to a future plugin that wants to jump somewhere programmatically, not just to remote agents.
- `nav.revealBlock` — id area `nav`, no default keybinding, `when: 'true'`, args `{ blockId: BlockId, highlightMs?: number }`: scrolls the target block into view and applies the same "briefly highlight" visual `nav.followLink`'s block-ref case already implements today (R43), extended per §2.6 to also carry the distinct "an agent just touched this" visual treatment. This is the primitive `ui_highlight` wraps.

Both fit R2's naming grammar (`^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$`) and R3's category conventions unchanged; they are proposed here as a design consequence, not implemented — the follow-up ADR/spec update adds their formal rows to `docs/spec/commands-and-keymap.md` §E.3.

### 2.5 New MCP surface

Following the existing tool style (`docs/spec/mcp-tools.md` §4), all five are `expose.mcp: true`, `openWorldHint: false`, deferred (not `alwaysLoad` — low call frequency relative to the 4 always-loaded data tools), and additionally gated by the `ui:control` capability (§2.6) on top of whatever `scopes` each needs for the graph-mutating case.

| Tool | Ann. | Scopes | One line |
|---|---|---|---|
| `ui_list_windows` | R I | `read`, `ui:control` | List currently live vrite windows across all devices |
| `ui_get_state` | R I | `read`, `ui:control` | What is on screen right now in one (or the most-recently-active) window |
| `ui_run_command` | *varies — annotate conservatively* | `ui:control` (+ whatever the invoked command needs) | Invoke any core/plugin command by id, exactly as a keybinding would |
| `ui_navigate` | A | `read`, `ui:control` | Open a page (and optionally zoom to a block) in a live window |
| `ui_highlight` | A I | `read`, `ui:control` | Scroll to and flash a block in a live window, without changing focus/navigation |

**`ui_list_windows`**

> "Lists the vrite windows currently connected and visible to a human right now — across all of this graph's devices. Returns an empty list if nobody has vrite open; that is a normal result, not an error. Use this before `ui_run_command`/`ui_navigate` if you are unsure whether more than one window is open."

```ts
export const uiListWindows = defineOp({
  name: 'ui.list_windows', summary: 'List live vrite windows',
  input: z.object({}).strict(),
  output: z.object({
    live: z.boolean().describe('false if no window is currently open anywhere'),
    windows: z.array(z.object({
      window_id: z.string(), device_id: z.string(), device_label: z.string().optional(),
      focused: z.boolean().describe('This window is the frontmost one on its device, if knowable'),
      page: z.object({ id: z.string(), name: z.string() }).nullable(),
      control_enabled: z.boolean().describe('The human has allowed command execution against this window (§2.6); false means only ui_get_state will work'),
      connected_at: z.string(), last_active_at: z.string(),
    })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  scopes: ['read'], mcp: { requiresCapability: 'ui:control' },
  render: renderUiWindows, handler: (_, ctx) => ctx.ui.listWindows(),
});
```

```json
// response when nobody has vrite open
{ "live": false, "windows": [] }
```

**Errors**: none specific — this call cannot fail except `internal`.

**`ui_get_state`**

> "Reads what a human is currently looking at in a live vrite window: which page, which block is focused or selected, cursor position, scroll position, open panels/dialogs. Omit `window_id` if you expect exactly one window open; if several are open the response is resolved to the most-recently-active one and lists the others in `other_windows` so you can target a specific one next time. If no window is open anywhere, this returns `live: false` — not an error; the data tools (`search`, `page_read`, …) work the same whether or not anyone has vrite open."

```ts
export const uiGetState = defineOp({
  name: 'ui.get_state', summary: 'What is on screen right now',
  input: z.object({ window_id: z.string().optional().describe('From ui_list_windows; omit to auto-resolve') }).strict(),
  output: z.object({
    live: z.boolean(),
    window_id: z.string().optional(), resolved_by: z.enum(['only_window', 'most_recently_active', 'requested']).optional(),
    state: UiWindowState.optional(),                       // see §2.3; absent when live is false
    other_windows: z.array(z.object({ window_id: z.string(), page: z.string().nullable() })).optional()
      .describe('Present when more than one window was live and window_id was auto-resolved'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  scopes: ['read'], mcp: { requiresCapability: 'ui:control' },
  render: renderUiState, handler: (i, ctx) => ctx.ui.getState(i),
});
```

**Errors**: `not_found` — the given `window_id` is not currently connected (it may have just closed; call `ui_list_windows` again).

**`ui_run_command`**

> "Runs a vrite command in a live window — the same command ids the palette, slash menu, and keybindings use (see the command reference). This is how an agent drives the actual UI a human has open, as opposed to editing the graph headlessly. `args` shape depends on `command_id`. A command whose `when` clause does not hold for the window's current state is skipped, not an error — check `when_result`. Prefer `ui_navigate`/`ui_highlight` for the two most common cases (open a page; point at a block) instead of calling this directly with `nav.openPage`/`nav.revealBlock`."

```ts
export const uiRunCommand = defineOp({
  name: 'ui.run_command', summary: 'Run a command in a live window',
  input: z.object({
    command_id: z.string().regex(/^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/)
      .describe('e.g. "task.setMarkerDone", "block.zoomIn", "nav.openPage"'),
    args: z.unknown().optional(),
    window_id: z.string().optional(),
  }).strict(),
  output: z.object({
    window_id: z.string(),
    when_result: z.enum(['ran', 'skipped_when_false', 'unknown_command', 'not_permitted']),
    result: z.unknown().optional(),
    changed: z.object({ created: z.array(BlockId), updated: z.array(BlockId), deleted: z.array(BlockId), seq: z.number().int() }).optional()
      .describe('Present when the command produced graph mutations; seq is safe to pass to changes_since/batch_undo'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  scopes: ['ui:control'],   // handler additionally checks the invoked command's own required scope
  mcp: { requiresCapability: 'ui:control' },
  render: renderUiCommandResult, handler: (i, ctx) => ctx.ui.runCommand(i),
});
```

`destructiveHint: true` is the conservative, correct default here per Anthropic's own tool-annotation guidance quoted in `docs/research/07-api-mcp.md` §2.1 ("an unannotated write tool is presumed destructive") — `command_id` is caller-chosen and dynamic, so the tool cannot know in advance whether a given call is `block.delete` or `nav.switchPage`; annotating conservatively is correct even though most invocations will be harmless navigation.

**Errors**: `not_found` (`window_id` given but not connected), `no_live_window` (`window_id` omitted and zero windows are live — the one place this family of tools *is* an error where `ui_get_state` is not, since there is nothing to run a command against; hint: "no vrite window is open; use page_append/block_update instead"), `ambiguous_window` (`window_id` omitted, >1 live windows; `details.windows` lists candidates), `forbidden` (`command_id` is `remoteInvocable: false`, or the token lacks the scope the specific command needs, or the target window has `control_enabled: false`, §2.6), `rate_limited`.

**`ui_navigate`** (thin wrapper over `ui_run_command('nav.openPage', { page, blockId })`)

```ts
export const uiNavigate = defineOp({
  name: 'ui.navigate', summary: 'Open a page in a live window',
  input: z.object({ page: PageRef, block_id: BlockId.optional().describe('Also zoom to this block'), window_id: z.string().optional() }).strict(),
  output: z.object({ window_id: z.string(), page: z.string() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  scopes: ['read', 'ui:control'], mcp: { requiresCapability: 'ui:control' },
  render: renderUiNavigate, handler: (i, ctx) => ctx.ui.navigate(i),
});
```

**`ui_highlight`** (thin wrapper over `ui_run_command('nav.revealBlock', { blockId })`)

```ts
export const uiHighlight = defineOp({
  name: 'ui.highlight', summary: 'Point at a block in a live window without navigating away',
  input: z.object({ block_id: BlockId, window_id: z.string().optional() }).strict(),
  output: z.object({ window_id: z.string() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  scopes: ['read', 'ui:control'], mcp: { requiresCapability: 'ui:control' },
  render: renderUiHighlight, handler: (i, ctx) => ctx.ui.highlight(i),
});
```

Both wrappers share `ui_run_command`'s `not_found`/`no_live_window`/`ambiguous_window` error cases and add nothing new; they exist purely so an agent doing the two most common things — "go look at X," "point at Y" — does not have to know the underlying command ids at all.

**Complementary, non-load-bearing resource** (§1.4): `vrite://ui/window/{window_id}` (and a static `vrite://ui/windows` list), `mimeType: application/json`, content = the same `UiWindowState`/window-list shapes as the tools above, with the server declaring `resources: { subscribe: true }` and wiring `state.subscribe`/`unsubscribe` (§2.3) to real `subscriptions/listen` traffic. Ship this once the M2 client exists, for hosts that do drive resource subscriptions autonomously; it is additive polish, not required for the tools above to work.

### 2.6 Visibility and consent

The user's own framing is the design brief here: *"there is something powerful for the user to know that the UI can be controlled by the LLM easily"* — the goal is not to make this invisible or minimally-surprising, it is to make it **legible and a little bit delightful to watch**, while still being trivially revocable. Three mechanisms:

1. **A persistent status-bar badge**, always visible (not tucked in a settings page), with three states: *off* (no `/ui/live` connection), *observed* (connected, `control_enabled: false` — an agent can see this window but not act on it), *controlled* (connected, `control_enabled: true`). Clicking it opens the two toggles below and shows a short recent-activity log ("Claude looked at Projects/Aurora 2 minutes ago"; "Claude marked a task DONE just now") sourced from the same `changes`/audit trail PLAN §11 already specifies for the headless API, extended to include live-UI-triggered events distinctly from the badge's own local WS traffic (so the log survives even if the socket briefly reconnects).
2. **Two independent, per-window, per-device, unsynced toggles** (local settings, not `keybindings.json`/graph data — whether *this specific device* trusts remote viewing/control is a device-local trust decision, deliberately not something that syncs and silently turns on control on a phone because it was enabled on a desktop):
   - *"Let agents view this window"* — default **on**. This only ever answers read requests (`ui_get_state`/`ui_list_windows`); it cannot make anything happen on screen. Defaulting it on is what makes the feature discoverable and "feel powerful" the first time someone tries it, and it carries essentially the write-side risk of zero — it is the same category of information the "changed by agent X" UI badge (PLAN §11) already displays about *past* edits, just live instead of retrospective.
   - *"Let agents control this window"* — default **off**, requiring one explicit toggle before `ui_run_command`/`ui_navigate`/`ui_highlight` will do anything to this window (attempts return `forbidden` with a hint pointing at the toggle). This is the escalation from "can see what I'm doing" to "can act as if it were me," which deserves a deliberate opt-in the same way VS Code's tool-confirmation dialog treats every tool invocation as needing acknowledgment (§1.2) — except here the acknowledgment is given once per window, up front, rather than re-litigated on every single call, because re-confirming every command would defeat the "watch it happen live" value the user is after.
3. **A distinct visual highlight on whatever a remote command just touched** — reusing and extending the flash `nav.followLink`'s block-ref case already applies when a human clicks a block reference (R43), via the new `nav.revealBlock` command (§2.4), but with a different color/label ("Agent" rather than the human's own accent color) so it reads unambiguously as "the AI did this," not as the human's own UI flickering unexpectedly. This is explicitly **not** a reintroduction of PLAN's excluded "real-time cursors/co-editing" (§2's non-goals list) — that item is about continuous human-to-human presence during simultaneous typing; this is a one-shot, attributed "here's what just happened" flash tied to the existing agent-attribution concept, not a live second cursor.

**Scope/capability recommendation**: add `ui:control` as a new capability flag, checked in addition to (not instead of) the existing `read`/`write`/`admin` scopes (ADR 008) — i.e. a token needs both the scope its intended graph operation requires *and* `ui:control` to reach any `ui_*` tool at all (§2.5's tables). This is deliberately a **separate** flag rather than folding it into `write` or `admin`, because the trust decision is different in kind: a broad `write` token created so an agent can do headless data cleanup should not, by itself, also grant "drive my screen while I'm watching," and conversely a narrowly-scoped `ui:control`-only token (paired with `read`) is a sensible "can look at what I'm doing and point things out, but only I can actually edit" grant for a lower-trust integration. `mcp-tools.md`'s existing token model (`read`/`write`/`admin` with labels as audit actors) extends cleanly to a fourth, orthogonal flag with no change to how the other three work.

**Destructive commands**: no synchronous confirmation dialog gates `ui_run_command` itself (that would both reintroduce MRTR's elicitation round-trip for every call and undercut the "watch it happen live" premise — the human is, by construction, looking at the screen when this channel is in use). Instead, any op a remote command produces with `destructiveHint: true` (block/subtree delete, in v1 the only such case per `docs/spec/commands-and-keymap.md`'s registry) surfaces a toast with a one-tap **Undo**, backed by the existing `batch_undo(batch_id)` (ADR 013) — the same batch id the op's own `changes` row already carries. This is consistent with the rest of vrite's design ethos noted in ADR 013 itself: "vrite has no unsaved-state concept" and everything destructive is already soft-deleted and cheaply reversible, so a blocking confirmation defends against a risk (irrecoverable loss) that mostly does not exist in this architecture; a fast, visible undo path defends against the risk that does exist (an agent did something unwanted) without the latency and UX cost of a dialog. The one place vrite's *existing* MCP design already uses a hard confirmation gate — `page_delete`'s `_meta["anthropic/requiresUserInteraction"]` (ADR 008 §3.1.4) — remains the right pattern for that specific, page-level, harder-to-casually-undo action; nothing here proposes weakening it, only declining to add an equivalent gate for the much smaller, already-undoable block-level case.

### 2.7 Packaging independence

This design needs no OS-level automation anywhere: every operation described above is "the browser tab's own JS calls a function in its own command registry and sends a JSON message over a WebSocket it already opened to a server it already trusts" — identical in a PWA tab, inside Capacitor's native WebView shell, inside a Tauri window, or (were it ever built, which ADR 005 does not plan) an Electron renderer, because all four are "a webview pointed at the same web build" (ADR 005's own note on why SolidJS doesn't lock vrite out of native shells makes exactly this argument one layer down the stack; this section is the same argument one layer up, for a *feature* rather than for the UI framework). Nothing here depends on which shell is hosting the page.

The one genuine, packaging-specific difference is what a **desktop shell can additionally do that a browser tab cannot**, and it is explicitly optional, later, and non-required for the core design: Tauri (or a hypothetical Electron build) can expose OS-level affordances a sandboxed browser tab has no API for — raising/focusing the actual OS window when a remote command fires (so the human notices even if vrite isn't the frontmost app), or a global overlay independent of any single window. These would be added the same way ADR 005's `platform` adapter already handles every other shell-specific capability (storage driver, keyboard insets, haptics, share, files, deep links) — a `platform.window.focus()` call that is a real OS call under Tauri and a no-op under a plain PWA tab — and are noted here only so a future implementer does not mistake "the core design doesn't need this" for "this could never be added."

### 2.8 What this explicitly is not

- **Not "computer use."** No screenshots leave the machine, no vision tokens are spent, no synthetic mouse coordinates or keystrokes are synthesized. Every observation is a typed JSON snapshot of state the client already tracks (§2.3); every action is a call into the client's own command function by id (§2.4). This is the entire point of building it this way instead of pointing Anthropic's computer-use tool at a vrite tab: a WebSocket round trip measured in tens of milliseconds and a precise, unambiguous target (`block_id`, `command_id`) versus computer use's own documented 2–5 seconds per action and pixel-level uncertainty (§1.1).
- **Not a replacement for, or a variant of, the existing 18-tool headless MCP data API** (`docs/spec/mcp-tools.md`). That API is defined to work identically whether zero or several clients are open — an agent can `page_append` to today's journal at 3 a.m. with nobody's laptop even open — and nothing in this design changes that. The `ui_*` tools are purely additive and are only ever meaningful on top of that API when a human happens to have a window open; when none is open, `ui_get_state`/`ui_list_windows` say so plainly (§2.3) and every other tool keeps working exactly as before.

---

## 3. Open questions and consequences for the follow-up ADR

1. **`Command.remoteInvocable` and the two new commands** (`nav.openPage`, `nav.revealBlock`, §2.4) need formal rows added to `docs/spec/commands-and-keymap.md` §E.3 before implementation — not done in this report per the task's own scope, but flagged as a direct, mechanical consequence.
2. **Origin tagging for remotely-triggered local ops** (§2.4's "origin/attribution consequence") is a small addition to the client's op-emission path (an optional origin/actor override alongside the normal local-edit path) that ADR 003/004 do not currently need to accommodate; it should be specified alongside whatever spec formalizes `applyOps`'s client-side counterpart.
3. **Rate limiting** for `ui_run_command` needs its own bucket in the existing per-token rate-limit table (`docs/spec/mcp-tools.md` §3.7) — separate from `write`'s 120/min, since a live-UI session doing rapid navigation+highlight calls during an active collaboration burst has a different natural rate than a batch data-import script.
4. **The `vrite://ui/window/{id}` resource's `subscribe` wiring** (§2.5) should be revisited once M2's actual client exists and once it's clearer which MCP hosts besides Claude Code are in scope, since the compatibility argument in §1.4 for "tools first" is specifically about Claude Code's current behavior on this research date and may not hold for every future host.
5. **Whether `ui:control` should itself be splittable** (e.g. a narrower "navigation and highlighting only, no write-shaped commands" tier between "view" and "full control") is deliberately left open here — §2.4's existing-scope-check-per-command already gives a natural finer boundary (a `read`+`ui:control` token can navigate/highlight but no `block.*` command will pass its own scope check), so a third capability tier may turn out to be unnecessary complexity; worth revisiting only if real usage shows the two-tier model too coarse.
