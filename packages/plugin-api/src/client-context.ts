/**
 * Client `PluginContext` (`docs/spec/api-and-plugin-types.md` §5). Greenfield, like
 * `server-context.ts` — no plugin host exists yet, so this follows the spec directly.
 *
 * Design note (ADR 007): renderers accept either `render(el)` (trusted, full DOM — the v1
 * default) or `html()` (a pure function of source -> string); a future sandboxed v2 client host
 * only ever calls the `html()` form and paints the result into a sandboxed iframe. `ctx.rpc.call`
 * is the client -> server bridge for a plugin's own private functions (`ctx.rpc.expose` on the
 * server half, `server-context.ts`); it is a different path from `ctx.data`, which talks to core
 * services, never to the plugin's own server code.
 */
import type { Block, BlockId, Page, PageId } from "@nooklet/core";
import type { DataApi } from "./data.js";
import type { Disposable } from "./disposable.js";
import type { Json } from "./json.js";
import type { Logger } from "./op-def.js";
import type { ServerChangeEvents } from "./server-context.js";

export type CodeBlockRenderer =
  | {
      render(
        source: string,
        el: HTMLElement,
        info: RenderInfo,
      ): void | Disposable | Promise<void | Disposable>;
    }
  | { html(source: string, info: RenderInfo): string | Promise<string> };
export type MacroRenderer =
  | {
      render(
        args: string[],
        el: HTMLElement,
        info: RenderInfo & { raw: string },
      ): void | Disposable | Promise<void | Disposable>;
    }
  | { html(args: string[], info: RenderInfo & { raw: string }): string | Promise<string> };
export interface RenderInfo {
  block: Block;
  page: Page;
  lang?: string;
  meta?: string;
  editing: boolean;
  signal: AbortSignal;
}

export interface EditorApi {
  currentPage(): Page | null;
  currentBlock(): Block | null;
  selection(): { blocks: BlockId[]; text?: string };
  insertText(text: string, opts?: { cursor?: number }): Promise<void>;
  replaceBlock(id: BlockId, content: string): Promise<void>;
  insertBlockAfter(id: BlockId, content: string): Promise<Block>;
  focusBlock(id: BlockId, opts?: { at?: "start" | "end" | number }): void;
  openPage(ref: PageId | { name: string }, opts?: { sidebar?: boolean }): Promise<void>;
  navigate(path: string): void;
}

export interface SlashItem {
  id: string;
  label: string;
  icon?: string;
  keywords?: string[];
  run(editor: EditorApi): void | Promise<void>;
}
export interface PanelDef {
  id: string;
  title: string;
  icon?: string;
  side?: "left" | "right";
  mount(el: HTMLElement, api: { close(): void; setTitle(t: string): void }): Disposable | void;
}
export interface BlockMenuItemDef {
  id: string;
  title: string;
  icon?: string;
  when?(block: Block): boolean;
  run(block: Block, editor: EditorApi): void;
}
export interface PageMenuItemDef {
  id: string;
  title: string;
  icon?: string;
  run(page: Page): void;
}
export interface ToolbarItemDef {
  id: string;
  title: string;
  icon: string;
  run(): void;
}
export interface StatusItemDef {
  id: string;
  mount(el: HTMLElement): Disposable | void;
}

export interface ClientPluginContext {
  readonly plugin: { id: string; version: string };
  readonly host: {
    version: string;
    apiVersion: "1";
    platform: "desktop" | "mobile";
    theme: "light" | "dark";
  };
  readonly data: DataApi;

  on<E extends keyof ServerChangeEvents>(
    event: E,
    handler: (p: ServerChangeEvents[E]) => void,
  ): Disposable;
  on(event: "page.opened", handler: (p: { page: Page }) => void): Disposable;
  /**
   * What `editor.currentPage()` answers has changed: another page was opened, no page is open any
   * more (`page: null`), a block on the open page changed (on this device or another), or the
   * server caught up with a local change to it — so a `rpc.call`/HTTP read now sees the edit.
   * Client-only, like `page.opened`: the local replica knows which pages a write touched, not which
   * rows, and this is what a client half can be told honestly (ADR 023). The server-shaped events
   * above are not delivered by the v1 client host.
   */
  on(event: "page.changed", handler: (p: { page: Page | null }) => void): Disposable;
  on(event: "block.focused" | "block.blurred", handler: (p: { block: Block }) => void): Disposable;
  on(event: "selection.changed", handler: (p: { blocks: BlockId[] }) => void): Disposable;

  registerCommand(cmd: {
    id: string;
    title: string;
    description?: string;
    category?: string;
    icon?: string;
    when?: string;
    run(info: { editor: EditorApi }): void | Promise<void>;
  }): Disposable;
  registerKeybinding(keys: string, commandId: string): Disposable;
  registerSlashCommand(item: SlashItem): Disposable;
  registerCodeBlockRenderer(lang: string, r: CodeBlockRenderer): Disposable;
  registerMacroRenderer(name: string, r: MacroRenderer): Disposable;
  registerPanel(p: PanelDef): Disposable;
  registerMenuItem(target: "block", item: BlockMenuItemDef): Disposable;
  registerMenuItem(target: "page", item: PageMenuItemDef): Disposable;
  registerToolbarItem(item: ToolbarItemDef): Disposable;
  registerStatusItem(item: StatusItemDef): Disposable;

  readonly theme: {
    style(css: string): Disposable;
    vars(vars: Record<`--${string}`, string>): Disposable;
  };
  readonly editor: EditorApi;

  notify(
    message: string,
    opts?: { kind?: "info" | "success" | "warning" | "error"; timeout?: number },
  ): void;
  confirm(message: string): Promise<boolean>;
  prompt(
    message: string,
    opts?: { placeholder?: string; initial?: string },
  ): Promise<string | null>;
  modal(m: { title: string; mount(el: HTMLElement, api: { close(): void }): Disposable | void }): {
    close(): void;
  };

  readonly settings: {
    get<T = Json>(): T;
    onChange(cb: (next: Json, prev: Json) => void): Disposable;
  };
  /** Calls the plugin's own server half (`ctx.rpc.expose` on `ServerPluginContext`). */
  readonly rpc: { call<T extends Json = Json>(name: string, ...args: Json[]): Promise<T> };

  readonly log: Logger;
  readonly subscriptions: Disposable[];
  readonly experimental: Record<string, unknown>;
}
