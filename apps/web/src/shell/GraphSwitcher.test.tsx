// @vitest-environment jsdom
/**
 * ADR 025: the graph list — since B-709 the left sidebar's title (the open graph's name) and the
 * menu it opens. Covers the client-only parts of all three legal moves (switch,
 * rename, remove; "just this device"; the add-a-server and promote forms' wiring to `fetch` and
 * the graph list) — not `connect-graph.ts`'s own request-shaping, which has no test of its own yet
 * but is exercised here through real (mocked) `fetch` calls, and not the server's own `/graphs`
 * behavior, which `packages/server/src/graphs/mount.test.ts` already covers.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeGraph,
  addGraph,
  listGraphs,
  resetBootstrapForTests,
  setActiveGraphId,
} from "../data/bootstrap.js";
import { GRAPH_NAMES } from "../data/graph-names.js";

const fakePlatform = vi.hoisted(() => ({ name: "web" as "web" | "capacitor" }));
vi.mock("../platform/index.js", () => ({ platform: fakePlatform }));

import { GraphSwitcher } from "./GraphSwitcher.js";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** jsdom's `Location.prototype.assign` is not configurable — replace `location` wholesale, same as
 * `ConnectView.test.tsx`. B-586: `GraphSwitcher` navigates via `location.assign` (not `.reload`) so
 * that switching to a same-origin graph under a different `/g/<slug>` actually lands there, rather
 * than reloading whatever path the browser happened to be on. */
function mockAssign(): ReturnType<typeof vi.fn> {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, assign },
  });
  return assign;
}

beforeEach(() => {
  localStorage.clear();
  resetBootstrapForTests();
  fakePlatform.name = "web";
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
});

function openSwitcher(): void {
  fireEvent.click(screen.getByRole("button", { name: /switch graph$/i }));
}

/** The open menu: the title above it carries the active graph's name too. */
function menu(): ReturnType<typeof within> {
  return within(screen.getByRole("dialog", { name: "Switch graph" }));
}

describe("GraphSwitcher", () => {
  it("is a title button, closed until clicked, empty list when nothing is stored", () => {
    render(() => <GraphSwitcher />);
    const button = screen.getByRole("button", { name: /switch graph$/i });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Switch graph" })).toBeTruthy();
  });

  it("lists every graph, marking the active one, and switching to a different one navigates to it", () => {
    addGraph({ id: "a", label: "Graph A", kind: "remote", baseUrl: "/g/a" });
    addGraph({ id: "b", label: "Graph B", kind: "remote", baseUrl: "/g/b" });
    setActiveGraphId("a");
    const assign = mockAssign();
    render(() => <GraphSwitcher />);
    openSwitcher();

    expect(menu().getByText("Graph A")).toBeTruthy();
    expect(menu().getByText("Graph B")).toBeTruthy();

    fireEvent.click(menu().getByText("Graph B"));
    expect(activeGraph()?.id).toBe("b");
    // B-586: navigates to the NEW graph's own prefix, not just a reload of the current path.
    expect(assign).toHaveBeenCalledWith("/g/b/");
  });

  it("clicking the already-active graph just closes the popover — no navigation", () => {
    addGraph({ id: "a", label: "Graph A", kind: "remote", baseUrl: "/g/a" });
    setActiveGraphId("a");
    const assign = mockAssign();
    render(() => <GraphSwitcher />);
    openSwitcher();

    fireEvent.click(menu().getByText("Graph A"));
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renames a graph in place", () => {
    addGraph({ id: "a", label: "Old Name", kind: "remote", baseUrl: "/g/a" });
    setActiveGraphId("a");
    render(() => <GraphSwitcher />);
    openSwitcher();

    fireEvent.click(screen.getByRole("button", { name: "Rename Old Name" }));
    const input = screen.getByDisplayValue("Old Name");
    fireEvent.input(input, { target: { value: "New Name" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(menu().getByText("New Name")).toBeTruthy();
    // The sidebar's title follows the rename.
    expect(screen.getByRole("button", { name: "New Name, switch graph" })).toBeTruthy();
    expect(listGraphs().find((g) => g.id === "a")?.label).toBe("New Name");
  });

  it("removes a non-active graph after a confirm step, but offers no remove action on the active one", async () => {
    addGraph({ id: "a", label: "Graph A", kind: "remote", baseUrl: "/g/a" });
    addGraph({ id: "b", label: "Graph B", kind: "remote", baseUrl: "/g/b" });
    setActiveGraphId("a");
    // B-712: Graph B was last open here with nothing unsynced, so a plain confirm.
    localStorage.setItem("nooklet.pendingCount.b", "0");
    render(() => <GraphSwitcher />);
    openSwitcher();

    expect(screen.queryByRole("button", { name: "Remove Graph A" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove Graph B" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("keeps “Graph B”");
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(listGraphs().map((g) => g.id)).toEqual(["a"]));
    // The menu stays open and shows the change.
    expect(menu().queryByText("Graph B")).toBeNull();
  });

  it("B-712: a local-only graph needs 'delete' typed; Cancel keeps it", async () => {
    fakePlatform.name = "capacitor";
    addGraph({ id: "a", label: "Open One", kind: "local" });
    addGraph({ id: "b", label: "Pocket", kind: "local" });
    setActiveGraphId("a");
    render(() => <GraphSwitcher />);
    openSwitcher();

    fireEvent.click(screen.getByRole("button", { name: "Remove Pocket" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("only copy");
    const go = within(dialog).getByRole("button", { name: "Delete forever" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    const field = within(dialog).getByRole("textbox");
    fireEvent.input(field, { target: { value: "delet" } });
    expect(go.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(listGraphs()).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Remove Pocket" }));
    const again = await screen.findByRole("alertdialog");
    fireEvent.input(within(again).getByRole("textbox"), { target: { value: " Delete " } });
    const armed = within(again).getByRole("button", {
      name: "Delete forever",
    }) as HTMLButtonElement;
    expect(armed.disabled).toBe(false);
    fireEvent.click(armed);
    await waitFor(() => expect(listGraphs().map((g) => g.id)).toEqual(["a"]));
  });

  it("B-714: a device-only copy of an earlier server graph cannot be promoted (shown disabled)", () => {
    fakePlatform.name = "capacitor";
    addGraph({ id: "a", label: "Open One", kind: "local" });
    addGraph({
      id: "copy",
      label: "Old Copy",
      kind: "local",
      detachedFrom: { address: "https://home.example.com/g/x", replacedBy: "other", at: "t" },
    });
    setActiveGraphId("a");
    render(() => <GraphSwitcher />);
    openSwitcher();
    expect(screen.getByRole("button", { name: "Add a server for Open One" })).toBeTruthy();
    const blocked = screen.getByRole("button", {
      name: /Add a server for Old Copy \(not available/,
    }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(blocked.title).toContain("only this device's unsynced changes");
  });

  it("B-712: a server graph with unsynced changes says how many and needs 'delete'", async () => {
    addGraph({ id: "a", label: "Graph A", kind: "remote", baseUrl: "/g/a" });
    addGraph({ id: "b", label: "Graph B", kind: "remote", baseUrl: "/g/b" });
    setActiveGraphId("a");
    localStorage.setItem("nooklet.pendingCount.b", "4");
    render(() => <GraphSwitcher />);
    openSwitcher();
    fireEvent.click(screen.getByRole("button", { name: "Remove Graph B" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "4 changes made on this device have not reached the server",
    );
    expect(
      (within(dialog).getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  });

  it("a plain browser tab: 'Add a graph' goes straight to the server form, no local-only choice", () => {
    render(() => <GraphSwitcher />);
    openSwitcher();
    fireEvent.click(screen.getByText("Add a graph"));

    expect(screen.getByLabelText("Server address")).toBeTruthy();
    expect(screen.queryByText("Just this device")).toBeNull();
  });

  it("Capacitor: 'Add a graph' shows the just-this-device vs sync-with-a-server choice first", () => {
    fakePlatform.name = "capacitor";
    render(() => <GraphSwitcher />);
    openSwitcher();
    fireEvent.click(screen.getByText("Add a graph"));

    expect(screen.getByText("Just this device")).toBeTruthy();
    expect(screen.getByText("Sync with a server")).toBeTruthy();
  });

  it("Capacitor: 'Just this device' adds a bare local-only entry and reloads", () => {
    fakePlatform.name = "capacitor";
    const assign = mockAssign();
    render(() => <GraphSwitcher />);
    openSwitcher();
    fireEvent.click(screen.getByText("Add a graph"));
    fireEvent.click(screen.getByText("Just this device"));

    expect(assign).toHaveBeenCalledOnce();
    const entry = listGraphs()[0];
    expect(entry?.kind).toBe("local");
    expect(entry?.baseUrl).toBeUndefined();
    expect(activeGraph()?.id).toBe(entry?.id);
    // B-644: not "This device" any more, a curated name.
    expect(GRAPH_NAMES).toContain(entry?.label);
  });

  describe("B-643: the desktop app", () => {
    function injectShell(localGraphs: { id: string; label: string }[]): void {
      Object.defineProperty(window, "__NOOKLET_DESKTOP__", {
        configurable: true,
        value: Object.freeze({ platform: "macos", port: 6100, localGraphs }),
      });
    }
    afterEach(() => {
      delete (window as { __NOOKLET_DESKTOP__?: unknown }).__NOOKLET_DESKTOP__;
    });

    it("offers a new graph on this Mac, named uniquely, and asks the shell to make it", () => {
      injectShell([{ id: "default", label: "default" }]);
      addGraph({ id: "r", label: "Remote", kind: "remote", baseUrl: "/g/default" });
      setActiveGraphId("r");
      const assign = mockAssign();
      render(() => <GraphSwitcher />);
      openSwitcher();
      fireEvent.click(screen.getByText("Add a graph"));
      expect(screen.getByText("Sync with a server")).toBeTruthy();
      fireEvent.click(screen.getByText("New graph on this Mac"));

      expect(assign).toHaveBeenCalledOnce();
      const url = new URL(assign.mock.calls[0]?.[0] as string);
      expect(url.origin).toBe("http://nooklet-desktop.invalid");
      expect(url.pathname).toBe("/new-local-graph");
      expect(GRAPH_NAMES).toContain(url.searchParams.get("label"));
      // Nothing is added to this origin's list: the graph lives on This Mac's server.
      expect(listGraphs()).toHaveLength(1);
      expect(screen.getByRole("status").textContent).toContain(url.searchParams.get("label"));
    });

    it("a name already used by a This-Mac graph is not handed out again", () => {
      const all = GRAPH_NAMES.slice(1).map((label, i) => ({ id: `g${i}`, label }));
      injectShell(all);
      const assign = mockAssign();
      render(() => <GraphSwitcher />);
      openSwitcher();
      fireEvent.click(screen.getByText("Add a graph"));
      fireEvent.click(screen.getByText("New graph on this Mac"));
      expect(new URL(assign.mock.calls[0]?.[0] as string).searchParams.get("label")).toBe(
        GRAPH_NAMES[0],
      );
    });

    it("lists This Mac's graphs from a remote server's page; picking one asks the shell to open it", () => {
      injectShell([
        { id: "default", label: "default" },
        { id: "quiet-otter", label: "Quiet Otter" },
      ]);
      const assign = mockAssign();
      render(() => <GraphSwitcher />);
      openSwitcher();
      const group = screen.getByRole("list", { name: "On this Mac" });
      expect(group.textContent).toContain("This Mac");
      expect(group.textContent).toContain("Quiet Otter");
      fireEvent.click(screen.getByText("Quiet Otter"));
      expect(assign).toHaveBeenCalledWith(
        "http://nooklet-desktop.invalid/open-local-graph?id=quiet-otter",
      );
    });

    it("shows the shell's error when it could not make the graph", async () => {
      injectShell([]);
      mockAssign();
      render(() => <GraphSwitcher />);
      openSwitcher();
      fireEvent.click(screen.getByText("Add a graph"));
      fireEvent.click(screen.getByText("New graph on this Mac"));
      window.dispatchEvent(new CustomEvent("nooklet:desktop-error", { detail: "disk full" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("disk full"));
      expect(screen.queryByRole("status")).toBeNull();
    });
  });

  it("add-a-server form: verifies against the typed address, adds a new entry, and navigates there", async () => {
    // Capacitor: its origin is on every server's CORS allowlist, so any server is added in-page.
    fakePlatform.name = "capacitor";
    fetchMock.mockResolvedValueOnce(ok({}));
    const assign = mockAssign();
    render(() => <GraphSwitcher />);
    openSwitcher();
    fireEvent.click(screen.getByText("Add a graph"));
    fireEvent.click(screen.getByText("Sync with a server"));

    fireEvent.input(screen.getByLabelText("Server address"), {
      target: { value: "https://nooklet.example.com" },
    });
    fireEvent.input(screen.getByLabelText("Device token"), { target: { value: "nk_abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    // Capacitor reloads its own bundle in place (`bootstrap.ts#graphEntryUrl`); the new entry is
    // what `apiBaseUrl()` follows. A bare origin means that server's default graph
    // (`connect-graph.ts#graphBaseUrl`).
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://nooklet.example.com/g/default/api/v1/graph.overview");
    expect(listGraphs().some((g) => g.baseUrl === "https://nooklet.example.com/g/default")).toBe(
      true,
    );
  });

  it("add-a-server form: a rejected token shows the same message ConnectView uses, and adds nothing", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    render(() => <GraphSwitcher />);
    openSwitcher();
    fireEvent.click(screen.getByText("Add a graph"));
    // A graph on this page's own server: the one kind a browser tab can add in-page (B-704).
    fireEvent.input(screen.getByLabelText("Server address"), {
      target: { value: `${location.origin}/g/work` },
    });
    fireEvent.input(screen.getByLabelText("Device token"), { target: { value: "nk_bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await screen.findByText(/rejected/);
    expect(listGraphs()).toEqual([]);
  });

  it("promote is offered only on a genuinely local-only entry (no baseUrl), not one already server-backed", () => {
    addGraph({ id: "local", label: "Local Only", kind: "local" });
    addGraph({ id: "remote", label: "Already Remote", kind: "remote", baseUrl: "/g/remote" });
    setActiveGraphId("local");
    render(() => <GraphSwitcher />);
    openSwitcher();

    expect(screen.getByRole("button", { name: "Add a server for Local Only" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a server for Already Remote" })).toBeNull();
  });

  it("promote form: creates the graph with the root token, points the SAME entry at it, and navigates there", async () => {
    addGraph({ id: "local", label: "Local Only", kind: "local" });
    setActiveGraphId("local");
    fetchMock.mockResolvedValueOnce(
      ok({ id: "promoted", label: "promoted", token: "nk_new_token", graphId: "physical-id" }),
    );
    const assign = mockAssign();
    render(() => <GraphSwitcher />);
    openSwitcher();

    fireEvent.click(screen.getByRole("button", { name: "Add a server for Local Only" }));
    fireEvent.input(screen.getByLabelText("Server address"), {
      target: { value: "https://home.example.com" },
    });
    fireEvent.input(screen.getByLabelText("New graph id"), { target: { value: "promoted" } });
    fireEvent.input(screen.getByLabelText("Root token"), {
      target: { value: "nkroot_abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));

    // B-586: the newly created graph's own address, not the local-only entry's old (nonexistent)
    // location.
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://home.example.com/g/promoted/"),
    );
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://home.example.com/graphs");
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer nkroot_abc",
    );
    // Same entry id, not a new one — the whole point is this device's existing local content
    // reconnects to the newly created graph, not that it gets a second, empty entry.
    expect(listGraphs()).toHaveLength(1);
    const entry = listGraphs()[0];
    expect(entry?.id).toBe("local");
    expect(entry?.kind).toBe("remote");
    expect(entry?.baseUrl).toBe("https://home.example.com/g/promoted");
    expect(entry?.token).toBe("nk_new_token");
  });

  describe("B-709: the sidebar's title and grouped rows", () => {
    afterEach(() => {
      delete (window as { __NOOKLET_DESKTOP__?: unknown }).__NOOKLET_DESKTOP__;
    });

    it("the title is the open graph's name, and its row is marked as the open one", () => {
      addGraph({ id: "a", label: "Garden Notes", kind: "remote", baseUrl: "/g/a" });
      addGraph({ id: "b", label: "Work", kind: "remote", baseUrl: "/g/b" });
      setActiveGraphId("a");
      render(() => <GraphSwitcher />);
      const title = screen.getByRole("button", { name: "Garden Notes, switch graph" });
      expect(title.textContent).toContain("Garden Notes");
      openSwitcher();
      const current = menu().getByRole("button", { current: true });
      expect(current.textContent).toContain("Garden Notes");
      expect(menu().getByRole("button", { name: /^Work/ }).getAttribute("aria-current")).toBeNull();
    });

    it("groups this device's local graphs apart from server graphs (Capacitor)", () => {
      fakePlatform.name = "capacitor";
      addGraph({ id: "l", label: "Pocket", kind: "local" });
      addGraph({ id: "r", label: "Home", kind: "remote", baseUrl: "https://home.example.com/g/x" });
      setActiveGraphId("l");
      render(() => <GraphSwitcher />);
      openSwitcher();
      expect(menu().getByRole("list", { name: "On this device" }).textContent).toContain("Pocket");
      const servers = menu().getByRole("list", { name: "On a server" });
      expect(servers.textContent).toContain("Home");
      expect(servers.textContent).not.toContain("Pocket");
    });

    it("desktop: This Mac's graphs, listed or not, sit under 'On this Mac', apart from servers", () => {
      Object.defineProperty(window, "__NOOKLET_DESKTOP__", {
        configurable: true,
        value: Object.freeze({
          platform: "macos",
          port: 6100,
          localGraphs: [
            { id: "default", label: "default" },
            { id: "quiet-otter", label: "Quiet Otter" },
          ],
        }),
      });
      addGraph({
        id: "m",
        label: "Mac default",
        kind: "remote",
        baseUrl: "http://127.0.0.1:6100/g/default",
      });
      addGraph({ id: "s", label: "Remote", kind: "remote", baseUrl: "/g/s" });
      setActiveGraphId("s");
      render(() => <GraphSwitcher />);
      openSwitcher();
      const mac = menu().getByRole("list", { name: "On this Mac" });
      expect(mac.textContent).toContain("Mac default");
      expect(mac.textContent).toContain("Quiet Otter");
      expect(menu().getByRole("list", { name: "On a server" }).textContent).toContain("Remote");
    });
  });

  describe("B-704: a server on another origin", () => {
    function injectShell(): void {
      Object.defineProperty(window, "__NOOKLET_DESKTOP__", {
        configurable: true,
        value: Object.freeze({ platform: "macos", port: 6100, localGraphs: [] }),
      });
    }
    afterEach(() => {
      delete (window as { __NOOKLET_DESKTOP__?: unknown }).__NOOKLET_DESKTOP__;
    });

    it("a browser tab says it cannot add it here and links it in a new tab, sending nothing", () => {
      render(() => <GraphSwitcher />);
      openSwitcher();
      fireEvent.click(screen.getByText("Add a graph"));
      fireEvent.input(screen.getByLabelText("Server address"), {
        target: { value: "https://other.example.com/g/work" },
      });
      expect(screen.getByRole("note").textContent).toContain("can only add graphs on");
      const link = screen.getByRole("link", { name: /Open other\.example\.com in a new tab/ });
      expect(link.getAttribute("href")).toBe("https://other.example.com/g/work");
      expect(link.getAttribute("target")).toBe("_blank");
      expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
      expect((screen.getByLabelText("Device token").closest("label") as HTMLElement).hidden).toBe(
        true,
      );
      fireEvent.submit(screen.getByLabelText("Server address").closest("form") as HTMLFormElement);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a graph on this page's own server is still added in-page", async () => {
      fetchMock.mockResolvedValueOnce(ok({ graph: { label: "Work" } }));
      const assign = mockAssign();
      render(() => <GraphSwitcher />);
      openSwitcher();
      fireEvent.click(screen.getByText("Add a graph"));
      fireEvent.input(screen.getByLabelText("Server address"), {
        target: { value: `${location.origin}/g/work` },
      });
      expect(screen.queryByRole("note")).toBeNull();
      fireEvent.input(screen.getByLabelText("Device token"), { target: { value: "nk_abc" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      await waitFor(() => expect(assign).toHaveBeenCalledOnce());
      expect(String(assign.mock.calls[0]?.[0])).toMatch(/\/g\/work\/$/);
    });

    it("the desktop app hands it to the shell, with no token and no fetch", () => {
      injectShell();
      const assign = mockAssign();
      render(() => <GraphSwitcher />);
      openSwitcher();
      fireEvent.click(screen.getByText("Add a graph"));
      fireEvent.click(screen.getByText("Sync with a server"));
      fireEvent.input(screen.getByLabelText("Server address"), {
        target: { value: "https://other.example.com" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add and restart" }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(assign).toHaveBeenCalledOnce();
      const url = new URL(assign.mock.calls[0]?.[0] as string);
      expect(url.origin).toBe("http://nooklet-desktop.invalid");
      expect(url.pathname).toBe("/add-server-graph");
      // A bare origin is its default graph, as everywhere else (`connect-graph.ts#graphBaseUrl`).
      expect(url.searchParams.get("url")).toBe("https://other.example.com/g/default");
      expect(listGraphs()).toEqual([]);
      expect(screen.getByRole("status").textContent).toContain("other.example.com");
    });

    it("the desktop app shows the shell's refusal", async () => {
      injectShell();
      mockAssign();
      render(() => <GraphSwitcher />);
      openSwitcher();
      fireEvent.click(screen.getByText("Add a graph"));
      fireEvent.click(screen.getByText("Sync with a server"));
      fireEvent.input(screen.getByLabelText("Server address"), {
        target: { value: "https://other.example.com" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add and restart" }));
      window.dispatchEvent(
        new CustomEvent("nooklet:desktop-error", { detail: "could not save that" }),
      );
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toBe("could not save that"),
      );
    });
  });
});
