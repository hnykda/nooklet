// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentDesktopGraph,
  DESKTOP_MENU_EVENT,
  DESKTOP_REPLY_EVENT,
  type DesktopGraph,
  desktopShell,
  listenToDesktopMenu,
  shellRequest,
  shellRequestUrl,
} from "./desktop-shell.js";

type ShellWindow = Window & { __NOOKLET_DESKTOP__?: unknown };

/** What `shell_script` in apps/desktop/src-tauri/src/main.rs defines, in shape. */
function injectShell(value: unknown): void {
  Object.defineProperty(window, "__NOOKLET_DESKTOP__", { value, configurable: true });
}

function menu(detail: unknown): void {
  window.dispatchEvent(new CustomEvent(DESKTOP_MENU_EVENT, { detail }));
}

const MAC: DesktopGraph = {
  key: "mac:default",
  place: "mac",
  id: "default",
  label: "This Mac",
  address: "http://127.0.0.1:6100/g/default",
};
const WORK: DesktopGraph = {
  key: "server:s1",
  place: "server",
  id: "s1",
  label: "Work",
  address: "https://notes.example.com/g/work",
};

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
      downloads: false,
      reveal: false,
      deleteMac: false,
      listServerGraphs: false,
      key: "",
      graphs: [],
      graphToken: null,
    });
  });

  it("B-736: knows whether the shell saves downloads", () => {
    injectShell(Object.freeze({ platform: "macos", port: 6420, downloads: true }));
    expect(desktopShell(window)?.downloads).toBe(true);
  });

  it("B-789: knows whether the shell can show an asset in Finder (an older one cannot)", () => {
    injectShell(Object.freeze({ platform: "macos", port: 6420, downloads: true }));
    expect(desktopShell(window)?.reveal).toBe(false);
    delete (window as ShellWindow).__NOOKLET_DESKTOP__;
    injectShell(Object.freeze({ platform: "macos", port: 6420, downloads: true, reveal: true }));
    expect(desktopShell(window)?.reveal).toBe(true);
    expect(
      shellRequestUrl({ kind: "reveal-asset", graph: "mac:default", asset: "abc1" }, "k", "r"),
    ).toBe(
      "http://nooklet-desktop.invalid/reveal-asset?key=k&req=r&graph=mac%3Adefault&asset=abc1",
    );
  });

  it("B-786/B-787: knows whether the shell deletes This-Mac graphs and lists servers (an older one does neither)", () => {
    injectShell(Object.freeze({ platform: "macos", port: 6420, reveal: true }));
    expect(desktopShell(window)?.deleteMac).toBe(false);
    expect(desktopShell(window)?.listServerGraphs).toBe(false);
    delete (window as ShellWindow).__NOOKLET_DESKTOP__;
    injectShell(
      Object.freeze({ platform: "macos", port: 6420, deleteMac: true, listServerGraphs: true }),
    );
    expect(desktopShell(window)?.deleteMac).toBe(true);
    expect(desktopShell(window)?.listServerGraphs).toBe(true);
    expect(shellRequestUrl({ kind: "delete-mac-graph", graph: "mac:garden" }, "k", "r")).toBe(
      "http://nooklet-desktop.invalid/delete-mac-graph?key=k&req=r&graph=mac%3Agarden",
    );
  });

  it("B-781: reads the shell's graph list, its request key and the graph's token, dropping malformed rows", () => {
    injectShell({
      platform: "macos",
      port: 6100,
      key: "k123",
      graphToken: "nk_abc",
      graphs: [MAC, { ...WORK, place: "phone" }, null, { key: "x" }, WORK],
    });
    const shell = desktopShell(window);
    expect(shell?.graphs).toEqual([MAC, WORK]);
    expect(shell?.key).toBe("k123");
    expect(shell?.graphToken).toBe("nk_abc");
    injectShell({ platform: "macos", port: 6100, graphToken: "" });
    expect(desktopShell(window)?.graphToken).toBeNull();
  });

  it("ignores a malformed flag rather than half-trusting it", () => {
    injectShell({ platform: "macos" });
    expect(desktopShell(window)).toBeNull();
    injectShell("desktop");
    expect(desktopShell(window)).toBeNull();
  });
});

describe("currentDesktopGraph", () => {
  it("is the graph whose address this page is at or under, never one that only shares a prefix", () => {
    const graphs = [MAC, WORK];
    const at = (href: string) => currentDesktopGraph(graphs, new URL(href));
    expect(at("https://notes.example.com/g/work/journals")?.key).toBe("server:s1");
    expect(at("https://notes.example.com/g/work")?.key).toBe("server:s1");
    expect(at("https://notes.example.com/g/workshop")).toBeUndefined();
    expect(at("http://127.0.0.1:6100/g/default/page/A")?.key).toBe("mac:default");
    expect(at("http://127.0.0.1:6200/g/default")).toBeUndefined();
  });
});

describe("shellRequest (ADR 032)", () => {
  it("addresses the reserved host with the window's key and a request id (main.rs#parse_shell_request)", () => {
    expect(
      shellRequestUrl(
        {
          kind: "connect-server",
          address: "https://notes.example.com/g/work",
          token: "nk_abc",
        },
        "k1",
        "r1",
      ),
    ).toBe(
      "http://nooklet-desktop.invalid/connect-server?key=k1&req=r1&address=https%3A%2F%2Fnotes.example.com%2Fg%2Fwork&token=nk_abc",
    );
    expect(shellRequestUrl({ kind: "new-local-graph", label: "Quiet Otter & co" }, "k", "r")).toBe(
      "http://nooklet-desktop.invalid/new-local-graph?key=k&req=r&label=Quiet+Otter+%26+co",
    );
    expect(shellRequestUrl({ kind: "remove", graph: "server:s1" }, "k", "r")).toBe(
      "http://nooklet-desktop.invalid/remove?key=k&req=r&graph=server%3As1",
    );
  });

  it("resolves with the reply to ITS request only, and the list that came with it", async () => {
    const assign = vi.fn();
    const win = Object.assign(new EventTarget(), { location: { assign } }) as unknown as Window;
    const shell = {
      platform: "macos",
      port: 6100,
      downloads: true,
      reveal: true,
      deleteMac: true,
      listServerGraphs: true,
      key: "k",
      graphs: [],
      graphToken: null,
    };
    const pending = shellRequest(shell, { kind: "rename", graph: "server:s1", label: "Job" }, win);
    const sent = new URL(String(assign.mock.calls[0]?.[0]));
    const req = sent.searchParams.get("req");
    expect(sent.pathname).toBe("/rename");
    win.dispatchEvent(
      new CustomEvent(DESKTOP_REPLY_EVENT, { detail: { req: "other", ok: false, error: "x" } }),
    );
    win.dispatchEvent(
      new CustomEvent(DESKTOP_REPLY_EVENT, {
        detail: { req, ok: true, error: null, graphs: [{ ...WORK, label: "Job" }, { bad: 1 }] },
      }),
    );
    await expect(pending).resolves.toEqual({
      ok: true,
      error: undefined,
      graphs: [{ ...WORK, label: "Job" }],
    });
  });
});

describe("list-server-graphs (B-787)", () => {
  it("sends the root token to the shell only, and reads the graphs it answers with", async () => {
    const assign = vi.fn();
    const win = Object.assign(new EventTarget(), { location: { assign } }) as unknown as Window;
    const shell = {
      platform: "macos",
      port: 6100,
      downloads: true,
      reveal: true,
      deleteMac: true,
      listServerGraphs: true,
      key: "k",
      graphs: [],
      graphToken: null,
    };
    const root = `nkroot_${"ab".repeat(24)}`;
    const pending = shellRequest(
      shell,
      { kind: "list-server-graphs", address: "https://notes.example.com", token: root },
      win,
    );
    const sent = new URL(String(assign.mock.calls[0]?.[0]));
    expect(sent.origin).toBe("http://nooklet-desktop.invalid");
    expect(sent.pathname).toBe("/list-server-graphs");
    expect(sent.searchParams.get("token")).toBe(root);
    const work = { id: "work", label: "Work", address: "https://notes.example.com/g/work" };
    win.dispatchEvent(
      new CustomEvent(DESKTOP_REPLY_EVENT, {
        detail: { req: sent.searchParams.get("req"), ok: true, serverGraphs: [work, { id: 1 }] },
      }),
    );
    await expect(pending).resolves.toEqual({ ok: true, serverGraphs: [work] });
  });
});

describe("listenToDesktopMenu (B-533)", () => {
  it("routes Settings…, Graphs… and Keyboard Shortcuts from the native menu", () => {
    injectShell({ platform: "macos", port: 6100 });
    const settings = vi.fn();
    const shortcuts = vi.fn();
    const graphs = vi.fn();
    const stop = listenToDesktopMenu({ settings, shortcuts, graphs }, window);

    menu("settings");
    expect(settings).toHaveBeenCalledTimes(1);
    expect(shortcuts).not.toHaveBeenCalled();
    menu("shortcuts");
    expect(shortcuts).toHaveBeenCalledTimes(1);
    menu("graphs");
    expect(graphs).toHaveBeenCalledTimes(1);
    // Items the shell handles itself (reload, docs, report-bug) and junk are not the client's.
    menu("reload");
    menu("switch-server");
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
