/**
 * The client plugin host (ADR 007, ADR 023): activates the built-in plugins' client halves that
 * were bundled into this build (`./builtins.ts`) and implements the part of `ClientPluginContext`
 * they need, through seams that already exist — the command registry and the slash menu's row list
 * for slash commands, the fence renderer registry for code blocks, the top bar's status strip.
 *
 * Deliberately small. Everything on `ClientPluginContext` this host does not implement THROWS
 * with a message naming it, rather than returning a do-nothing `Disposable`: a plugin author
 * whose panel never appears should be told why on the first call, not left to find out. What is
 * implemented: `registerSlashCommand`, `registerCommand`, `registerCodeBlockRenderer`,
 * `registerStatusItem`, `on("page.opened" | "page.changed")`, `rpc.call`, `editor.currentPage`,
 * `editor.insertText`, `editor.openPage`, `editor.navigate`, `log`, `subscriptions`, `host`,
 * `plugin`. Not yet: `data`, panels, menus, toolbar, keybindings, macros, theme, dialogs,
 * settings, and the server-shaped change events (`block.updated` & co. — the replica's change bus
 * knows which pages a write touched, not which rows, so any payload would be invented).
 *
 * Every registration is tracked per plugin and disposed in reverse order on `stop()` or when
 * `activate()` throws part-way (spec rule 12), so a half-activated plugin leaves nothing behind.
 */
import type { Page } from "@nooklet/core";
import type {
  ClientPluginContext,
  ClientPluginModule,
  Disposable,
  EditorApi,
  Json,
  Logger,
} from "@nooklet/plugin-api";
import type { EditorHost } from "../commands/hosts/editor-host.js";
import type { CommandRegistry } from "../commands/registry.js";
import type { SlashItem } from "../commands/types.js";

/** A plugin whose client half is part of this build. `manifest` is the plugin's `package.json`. */
export interface BuiltinClientPlugin {
  manifest: { version: string; nooklet: { id: string; name?: string; api: string } };
  module: ClientPluginModule;
}

export type ClientEvent = "page.opened" | "page.changed";

export interface ClientPluginHostDeps {
  registry: CommandRegistry;
  editor: EditorHost;
  navigate: (path: string) => void;
  /** Resolves a page id to its name for `editor.openPage(id)`. */
  pageNameForId: (id: string) => Promise<string | undefined>;
  pagePath: (name: string) => string;
  /** The page open in the main view, or `null` (journals, search, …). */
  currentPage: () => Page | null;
  baseUrl: () => string;
  getToken: () => string | undefined;
  hostVersion: string;
  platform: "desktop" | "mobile";
  theme: () => "light" | "dark";
  /** The three slots, injected so tests can observe them without the app's module-level state. */
  contributeSlashItem: (item: SlashItem) => () => void;
  registerFenceRenderer: (
    lang: string,
    renderer: Parameters<ClientPluginContext["registerCodeBlockRenderer"]>[1],
  ) => () => void;
  addStatusItem: (entry: {
    pluginId: string;
    item: Parameters<ClientPluginContext["registerStatusItem"]>[0];
  }) => () => void;
  fetch?: typeof fetch;
  logger?: Pick<Console, "info" | "warn" | "error" | "debug">;
}

export interface PluginStatus {
  id: string;
  status: "active" | "error";
  error?: string;
}

export interface ClientPluginHost {
  /** Activates each plugin in order; one failing never stops the next (spec rule 15's safe mode). */
  start(plugins: readonly BuiltinClientPlugin[]): Promise<void>;
  emit(event: ClientEvent, payload: { page: Page | null }): void;
  list(): PluginStatus[];
  /** Disposes every plugin's registrations (reverse order) and calls its `deactivate()`. */
  stop(): Promise<void>;
}

const SUPPORTED_API = "1";
const CLIENT_EVENTS: ReadonlySet<string> = new Set<ClientEvent>(["page.opened", "page.changed"]);

/** `word-count` + `slash-mermaid` → `plugin.wordCount.slashMermaid`: the registry only accepts
 * camelCase segments (commands-and-keymap.md R2), and manifest ids are kebab-case. */
export function pluginCommandId(pluginId: string, localId: string): string {
  const camel = (s: string): string =>
    s
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join("");
  return `plugin.${camel(pluginId)}.${camel(localId)}`;
}

function unsupported(what: string): never {
  throw new Error(`${what} is not supported by nooklet's client plugin host yet (ADR 023)`);
}

export function createClientPluginHost(deps: ClientPluginHostDeps): ClientPluginHost {
  const logger = deps.logger ?? console;
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const listeners = new Map<
    ClientEvent,
    Set<{ pluginId: string; handler: (p: unknown) => void }>
  >();
  const active = new Map<string, { module: ClientPluginModule; subscriptions: Disposable[] }>();
  const statuses = new Map<string, PluginStatus>();

  function disposeAll(pluginId: string, subscriptions: Disposable[]): void {
    for (const d of subscriptions.splice(0).reverse()) {
      try {
        d.dispose();
      } catch (e) {
        logger.error(`[plugin:${pluginId}] a registration threw while being disposed:`, e);
      }
    }
  }

  function createContext(plugin: BuiltinClientPlugin, subscriptions: Disposable[]) {
    const { id: pluginId, name } = plugin.manifest.nooklet;
    const track = (dispose: () => void): Disposable => {
      let done = false;
      const d = {
        dispose() {
          if (done) return;
          done = true;
          dispose();
        },
      };
      subscriptions.push(d);
      return d;
    };
    const prefix = `[plugin:${pluginId}]`;
    const log: Logger = {
      debug: (...a) => logger.debug(prefix, ...a),
      info: (...a) => logger.info(prefix, ...a),
      warn: (...a) => logger.warn(prefix, ...a),
      error: (...a) => logger.error(prefix, ...a),
    };

    const editor: EditorApi = {
      currentPage: () => deps.currentPage(),
      currentBlock: () => unsupported("editor.currentBlock()"),
      selection: () => unsupported("editor.selection()"),
      async insertText(text, opts) {
        const sel = deps.editor.getSelection();
        if (!sel) throw new Error("editor.insertText(): no block is being edited");
        deps.editor.replaceRange({ from: sel.start, to: sel.end, text, caretOffset: opts?.cursor });
      },
      replaceBlock: async () => unsupported("editor.replaceBlock()"),
      insertBlockAfter: async () => unsupported("editor.insertBlockAfter()"),
      focusBlock: () => unsupported("editor.focusBlock()"),
      async openPage(ref, opts) {
        if (opts?.sidebar) unsupported("editor.openPage({ sidebar: true })");
        const pageName = typeof ref === "string" ? await deps.pageNameForId(ref) : ref.name;
        if (!pageName) throw new Error(`editor.openPage(): no page with id "${String(ref)}"`);
        deps.navigate(deps.pagePath(pageName));
      },
      navigate: (path) => deps.navigate(path),
    };

    function registerCommandImpl(
      localId: string,
      spec: {
        title: string;
        description?: string;
        category?: string;
        icon?: string;
        when?: string;
      },
      run: () => void | Promise<void>,
    ): string {
      const id = pluginCommandId(pluginId, localId);
      deps.registry.register({
        id,
        title: spec.title,
        description: spec.description,
        category: spec.category ?? name ?? pluginId,
        icon: spec.icon,
        when: spec.when,
        defaultKeys: {},
        run,
      });
      return id;
    }

    const on = (event: string, handler: (p: unknown) => void): Disposable => {
      if (!CLIENT_EVENTS.has(event)) unsupported(`ctx.on("${event}")`);
      const key = event as ClientEvent;
      const entry = { pluginId, handler };
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(entry);
      return track(() => listeners.get(key)?.delete(entry));
    };

    const ctx: ClientPluginContext = {
      plugin: { id: pluginId, version: plugin.manifest.version },
      host: {
        version: deps.hostVersion,
        apiVersion: "1",
        platform: deps.platform,
        get theme() {
          return deps.theme();
        },
      },
      get data(): never {
        return unsupported("ctx.data");
      },
      on: on as ClientPluginContext["on"],

      registerCommand(cmd) {
        const id = registerCommandImpl(cmd.id, cmd, () => cmd.run({ editor }));
        return track(() => deps.registry.unregister(id));
      },
      registerKeybinding: () => unsupported("registerKeybinding()"),
      registerSlashCommand(item) {
        // Through the registry like every core slash row (R1), gated on a focused editor so the
        // palette does not offer an insert with nowhere to insert into.
        const id = registerCommandImpl(
          `slash-${item.id}`,
          { title: item.label, icon: item.icon, when: "editorFocused" },
          () => item.run(editor),
        );
        const removeRow = deps.contributeSlashItem({
          label: item.label,
          command: id,
          keywords: item.keywords ?? [],
        });
        return track(() => {
          removeRow();
          deps.registry.unregister(id);
        });
      },
      registerCodeBlockRenderer(lang, renderer) {
        return track(deps.registerFenceRenderer(lang, renderer));
      },
      registerMacroRenderer: () => unsupported("registerMacroRenderer()"),
      registerPanel: () => unsupported("registerPanel()"),
      registerMenuItem: (() =>
        unsupported("registerMenuItem()")) as ClientPluginContext["registerMenuItem"],
      registerToolbarItem: () => unsupported("registerToolbarItem()"),
      registerStatusItem(item) {
        return track(deps.addStatusItem({ pluginId, item }));
      },

      theme: {
        style: () => unsupported("theme.style()"),
        vars: () => unsupported("theme.vars()"),
      },
      editor,

      notify: () => unsupported("notify()"),
      confirm: async () => unsupported("confirm()"),
      prompt: async () => unsupported("prompt()"),
      modal: () => unsupported("modal()"),

      settings: {
        get: () => unsupported("settings.get()"),
        onChange: () => unsupported("settings.onChange()"),
      },
      rpc: {
        async call<T extends Json = Json>(fn: string, ...args: Json[]): Promise<T> {
          const token = deps.getToken();
          const res = await doFetch(
            `${deps.baseUrl()}/api/plugins/${encodeURIComponent(pluginId)}/rpc/${encodeURIComponent(fn)}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(token ? { authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify(args),
            },
          );
          if (!res.ok) {
            throw new Error(`rpc.call("${fn}") failed: HTTP ${res.status} ${await res.text()}`);
          }
          return (await res.json()) as T;
        },
      },

      log,
      subscriptions,
      experimental: {},
    };
    return ctx;
  }

  return {
    async start(plugins) {
      for (const plugin of plugins) {
        const { id, api } = plugin.manifest.nooklet;
        if (active.has(id)) continue;
        if (api !== SUPPORTED_API) {
          const error = `plugin API "${api}" is not supported (this host supports "${SUPPORTED_API}")`;
          statuses.set(id, { id, status: "error", error });
          logger.error(`[plugin:${id}] ${error}`);
          continue;
        }
        const subscriptions: Disposable[] = [];
        try {
          await plugin.module.activate(createContext(plugin, subscriptions));
          active.set(id, { module: plugin.module, subscriptions });
          statuses.set(id, { id, status: "active" });
        } catch (e) {
          disposeAll(id, subscriptions);
          const error = e instanceof Error ? e.message : String(e);
          statuses.set(id, { id, status: "error", error });
          logger.error(`[plugin:${id}] failed to activate:`, e);
        }
      }
    },

    emit(event, payload) {
      for (const { pluginId, handler } of [...(listeners.get(event) ?? [])]) {
        try {
          handler(payload);
        } catch (e) {
          logger.error(`[plugin:${pluginId}] "${event}" handler threw:`, e);
        }
      }
    },

    list: () => [...statuses.values()],

    async stop() {
      for (const [id, entry] of [...active].reverse()) {
        disposeAll(id, entry.subscriptions);
        try {
          await entry.module.deactivate?.();
        } catch (e) {
          logger.error(`[plugin:${id}] deactivate() threw:`, e);
        }
        active.delete(id);
        statuses.delete(id);
      }
    },
  };
}
