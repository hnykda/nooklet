/** E.3 Navigation and palette (category `Navigation`) — R40-R44. */
import type { EditorHost } from "../hosts/editor-host.js";
import type { NavigationHost } from "../hosts/nav-host.js";
import type { PaletteController } from "../palette/palette-controller.js";
import type { Command } from "../types.js";

export function createNavCommands(deps: {
  navigation: NavigationHost;
  palette: PaletteController;
  editor: EditorHost;
}): Command[] {
  const { navigation, palette, editor } = deps;
  return [
    {
      id: "palette.open",
      title: "Open command palette",
      category: "Navigation",
      defaultKeys: { mac: "Cmd+K", other: "Ctrl+K" },
      when: "true",
      run() {
        palette.toggle("mixed"); // R40: toggles closed if already open.
      },
    },
    {
      id: "nav.switchPage",
      title: "Switch page",
      category: "Navigation",
      defaultKeys: { mac: "Cmd+O", other: "Ctrl+O" },
      when: "true",
      run() {
        palette.open("pages"); // R41: same component, pre-scoped to pages/journals.
      },
    },
    {
      id: "nav.todayJournal",
      title: "Open today's journal",
      category: "Navigation",
      defaultKeys: { mac: "Cmd+J", other: "Ctrl+J" },
      when: "true",
      run() {
        navigation.openTodayJournal();
      },
    },
    {
      id: "nav.journals",
      title: "Open journals",
      category: "Navigation",
      defaultKeys: { mac: "Cmd+Shift+J", other: "Ctrl+Shift+J" },
      when: "true",
      run() {
        navigation.openJournals();
      },
    },
    {
      id: "nav.back",
      title: "Go back",
      category: "Navigation",
      defaultKeys: { mac: "Cmd+[", other: "Alt+Left" },
      when: "true",
      run() {
        navigation.back();
      },
    },
    {
      id: "nav.forward",
      title: "Go forward",
      category: "Navigation",
      defaultKeys: { mac: "Cmd+]", other: "Alt+Right" },
      when: "true",
      run() {
        navigation.forward();
      },
    },
    {
      id: "nav.followLink",
      title: "Follow link under cursor",
      category: "Navigation",
      defaultKeys: { mac: "Alt+Enter", other: "Alt+Enter" },
      when: "editorFocused && caretInLink",
      run() {
        const link = editor.getLinkAtCaret();
        if (link) navigation.followLink(link);
      },
    },
    {
      id: "search.open",
      title: "Open search",
      category: "Navigation",
      defaultKeys: { mac: "Cmd+Shift+F", other: "Ctrl+Shift+F" },
      when: "true",
      run() {
        navigation.openSearch();
      },
    },
    // ADR 015 §2.4: no default keybinding, no picker — "jump straight to a known page/block."
    // The primitives `ui_navigate`/`ui_highlight` (the live-UI-control MCP tools) wrap, also open
    // to a plugin through `ctx.exec`. Without a page or block id they do nothing, so they are
    // `requiresArgs` and the palette does not list them (B-105) — "Switch page" is the human form.
    {
      id: "nav.openPage",
      title: "Open page",
      category: "Navigation",
      defaultKeys: {},
      when: "true",
      requiresArgs: true,
      run(ctx) {
        const args = ctx.args as { page?: string; blockId?: string } | undefined;
        if (args?.page) navigation.openPageByRef(args.page, args.blockId);
      },
    },
    {
      id: "nav.revealBlock",
      title: "Reveal block",
      category: "Navigation",
      defaultKeys: {},
      when: "true",
      requiresArgs: true,
      run(ctx) {
        const args = ctx.args as { blockId?: string } | undefined;
        if (args?.blockId) navigation.revealBlock(args.blockId);
      },
    },
  ];
}
