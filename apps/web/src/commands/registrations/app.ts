/** E.6 App-level (category `App`) — R51-R52. */
import type { AppHost } from "../hosts/nav-host.js";
import type { Command } from "../types.js";

export function createAppCommands(deps: { app: AppHost }): Command[] {
  const { app } = deps;
  return [
    {
      id: "edit.undo",
      title: "Undo",
      category: "App",
      defaultKeys: { mac: "Cmd+Z", other: "Ctrl+Z" },
      when: "true",
      run() {
        app.undo();
      },
    },
    {
      id: "edit.redo",
      title: "Redo",
      category: "App",
      defaultKeys: { mac: "Cmd+Shift+Z", other: "Ctrl+Shift+Z" },
      when: "true",
      run() {
        app.redo();
      },
    },
    {
      id: "app.toggleSidebar",
      title: "Toggle sidebar",
      category: "App",
      defaultKeys: { mac: "Cmd+\\", other: "Ctrl+\\" },
      when: "true",
      run() {
        app.toggleSidebar();
      },
    },
    {
      id: "app.openSettings",
      title: "Open settings",
      category: "App",
      defaultKeys: { mac: "Cmd+,", other: "Ctrl+," },
      when: "true",
      run() {
        app.openSettings();
      },
    },
    {
      id: "app.openPluginManager",
      title: "Open plugin manager",
      category: "App",
      defaultKeys: {},
      when: "true",
      run() {
        app.openPluginManager();
      },
    },
    {
      id: "app.showShortcuts",
      title: "Show keyboard shortcuts",
      category: "App",
      defaultKeys: {},
      // B-564: no keyboard to press any of them with on a touch-primary device.
      when: "!mobile",
      run() {
        app.openShortcuts();
      },
    },
    {
      id: "app.openDiagnostics",
      title: "Open diagnostics",
      category: "App",
      defaultKeys: {},
      when: "true",
      run() {
        app.openDiagnostics();
      },
    },
    {
      id: "sync.now",
      title: "Sync now",
      category: "App",
      defaultKeys: {},
      when: "true",
      async run() {
        await app.syncNow();
      },
    },
    {
      id: "app.toggleTheme",
      title: "Toggle theme",
      category: "App",
      defaultKeys: {},
      when: "true",
      run() {
        app.toggleTheme();
      },
    },
    {
      id: "app.hideKeyboard",
      title: "Hide keyboard",
      category: "App",
      defaultKeys: {},
      when: "mobile && editorFocused",
      run() {
        app.hideKeyboard();
      },
    },
  ];
}
