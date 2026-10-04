// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_MENU_EVENT,
  desktopShell,
  listenToDesktopMenu,
  shellRequestUrl,
} from "./desktop-shell.js";

type ShellWindow = Window & { __NOOKLET_DESKTOP__?: unknown };

/** What `shell_script` in apps/desktop/src-tauri/src/main.rs defines, byte for byte in shape. */
function injectShell(value: unknown): void {
  Object.defineProperty(window, "__NOOKLET_DESKTOP__", { value, configurable: true });
}

function menu(detail: unknown): void {
  window.dispatchEvent(new CustomEvent(DESKTOP_MENU_EVENT, { detail }));
}

afterEach(() => {
  delete (window as ShellWindow).__NOOKLET_DESKTOP__;
});

describe("desktopShell", () => {
  it("is null in a browser", () => {
    expect(desktopShell(window)).toBeNull();
  });

  it("reads the flag the Tauri shell injects", () => {
    injectShell(Object.freeze({ platform: "macos", port: 6420 }));
    expect(desktopShell(window)).toEqual({
      platform: "macos",
      port: 6420,
      localGraphs: [],
      downloads: false,
    });
  });

  it("B-736: knows whether the shell saves downloads", () => {
    injectShell(Object.freeze({ platform: "macos", port: 6420, downloads: true }));
    expect(desktopShell(window)?.downloads).toBe(true);
  });

  it("B-643: reads This Mac's graphs, dropping malformed ones", () => {
    injectShell({
      platform: "macos",
      port: 6100,
      localGraphs: [{ id: "default", label: "default" }, { id: 3 }, null, { id: "q", label: "Q" }],
    });
    expect(desktopShell(window)?.localGraphs).toEqual([
      { id: "default", label: "default" },
      { id: "q", label: "Q" },
    ]);
  });

  it("ignores a malformed flag rather than half-trusting it", () => {
    injectShell({ platform: "macos" });
    expect(desktopShell(window)).toBeNull();
    injectShell("desktop");
    expect(desktopShell(window)).toBeNull();
  });
});

describe("shellRequestUrl (B-643)", () => {
  it("addresses the reserved host main.rs#parse_shell_request reads, with the label encoded", () => {
    expect(shellRequestUrl({ kind: "new-local-graph", label: "Quiet Otter & co" })).toBe(
      "http://nooklet-desktop.invalid/new-local-graph?label=Quiet+Otter+%26+co",
    );
    expect(shellRequestUrl({ kind: "open-local-graph", id: "quiet-otter" })).toBe(
      "http://nooklet-desktop.invalid/open-local-graph?id=quiet-otter",
    );
  });

  it("B-704: an add-server request carries the address, encoded (main.rs reads `url`)", () => {
    expect(
      shellRequestUrl({ kind: "add-server-graph", url: "https://notes.example.com/g/work" }),
    ).toBe(
      "http://nooklet-desktop.invalid/add-server-graph?url=https%3A%2F%2Fnotes.example.com%2Fg%2Fwork",
    );
  });
});

describe("listenToDesktopMenu (B-533)", () => {
  it("routes Settings… and Keyboard Shortcuts from the native menu", () => {
    injectShell({ platform: "macos", port: 6100 });
    const settings = vi.fn();
    const shortcuts = vi.fn();
    const stop = listenToDesktopMenu({ settings, shortcuts }, window);

    menu("settings");
    expect(settings).toHaveBeenCalledTimes(1);
    expect(shortcuts).not.toHaveBeenCalled();
    menu("shortcuts");
    expect(shortcuts).toHaveBeenCalledTimes(1);
    // Items the shell handles itself (reload, docs, report-bug) and junk are not the client's.
    menu("reload");
    menu({ action: "settings" });
    expect(settings).toHaveBeenCalledTimes(1);

    stop();
    menu("settings");
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("listens to nothing outside the desktop shell", () => {
    const settings = vi.fn();
    const stop = listenToDesktopMenu({ settings, shortcuts: vi.fn() }, window);
    menu("settings");
    expect(settings).not.toHaveBeenCalled();
    stop();
  });
});
