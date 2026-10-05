// @vitest-environment jsdom
/**
 * Proposal 005 / ADR 032: the desktop app's graph menu reads the SHELL's list, and its add form
 * reports every failure on the form. The shell itself is faked: `location.assign` is where a
 * request leaves the page (`platform/desktop-shell.ts#shellRequest`), and the shell's answer is a
 * `nooklet:desktop-reply` event, as `main.rs#reply` sends it.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addGraph, resetBootstrapForTests, setActiveGraphId } from "../data/bootstrap.js";
import { DESKTOP_REPLY_EVENT, type DesktopGraph } from "../platform/desktop-shell.js";
import { GraphSwitcher } from "./GraphSwitcher.js";
import { requestGraphMenu } from "./graph-menu-request.js";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

const MAC: DesktopGraph = {
  key: "mac:default",
  place: "mac",
  id: "default",
  label: "This Mac",
  address: "http://127.0.0.1:6100/g/default",
};
const OTTER: DesktopGraph = {
  key: "mac:quiet-otter",
  place: "mac",
  id: "quiet-otter",
  label: "Quiet Otter",
  address: "http://127.0.0.1:6100/g/quiet-otter",
};
const WORK: DesktopGraph = {
  key: "server:s1",
  place: "server",
  id: "s1",
  label: "Work",
  address: "https://notes.example.com/g/work",
};
const LAN: DesktopGraph = {
  key: "server:s2",
  place: "server",
  id: "s2",
  label: "192.168.1.5:6100",
  address: "http://192.168.1.5:6100/g/default",
};

const TOKEN = `nk_${"ab".repeat(24)}`;

let assign: ReturnType<typeof vi.fn>;

/** The page is at `href`, inside a shell that lists `graphs` (with what it answers, `flags`). */
function inShell(
  href: string,
  graphs: DesktopGraph[],
  flags: { deleteMac?: boolean; listServerGraphs?: boolean } = {},
): void {
  const url = new URL(href);
  assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href,
      origin: url.origin,
      host: url.host,
      pathname: url.pathname,
      search: "",
      hash: "",
      assign,
      reload: vi.fn(),
    },
  });
  Object.defineProperty(window, "__NOOKLET_DESKTOP__", {
    configurable: true,
    value: Object.freeze({
      platform: "macos",
      port: 6100,
      key: "k",
      graphs,
      graphToken: null,
      ...flags,
    }),
  });
}

/** The last request the page sent the shell, parsed. */
function lastRequest(): URL {
  const call = assign.mock.calls.at(-1);
  return new URL(String(call?.[0]));
}

function replyToLast(detail: {
  ok: boolean;
  error?: string;
  graphs?: DesktopGraph[];
  serverGraphs?: { id: string; label: string; address: string }[];
}): void {
  const req = lastRequest().searchParams.get("req");
  window.dispatchEvent(new CustomEvent(DESKTOP_REPLY_EVENT, { detail: { req, ...detail } }));
}

function openMenu(): ReturnType<typeof within> {
  fireEvent.click(screen.getByRole("button", { name: /switch graph$/i }));
  return within(screen.getByRole("dialog", { name: "Graphs" }));
}

beforeEach(() => {
  localStorage.clear();
  resetBootstrapForTests();
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
  delete (window as { __NOOKLET_DESKTOP__?: unknown }).__NOOKLET_DESKTOP__;
});

describe("the desktop graph menu (B-781: one list, the shell's)", () => {
  it("lists the shell's graphs under On this Mac and On servers (by host), not this origin's own list", () => {
    inShell("https://notes.example.com/g/work/journals", [MAC, OTTER, WORK, LAN]);
    // What an older version left in this origin's storage is not shown on desktop.
    addGraph({ id: "old", label: "Leftover", kind: "remote", baseUrl: "/g/work" });
    setActiveGraphId("old");
    render(() => <GraphSwitcher />);
    expect(screen.getByRole("button", { name: "Work, switch graph" })).toBeTruthy();
    const menu = openMenu();
    expect(menu.getByRole("list", { name: "On this Mac" }).textContent).toContain("Quiet Otter");
    expect(menu.getByRole("list", { name: "On servers: notes.example.com" }).textContent).toContain(
      "Work",
    );
    expect(menu.getByRole("list", { name: "On servers: 192.168.1.5:6100" })).toBeTruthy();
    expect(menu.queryByText("Leftover")).toBeNull();
    expect(menu.getByRole("button", { current: true }).textContent).toContain("Work");
    // No phone words (B-783).
    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).not.toMatch(/device|Just this|On a server/i);
  });

  it("B-785: picking a graph navigates to its address (the shell routes it); the open one just closes", () => {
    inShell("http://127.0.0.1:6100/g/default/journals", [MAC, OTTER, WORK]);
    render(() => <GraphSwitcher />);
    let menu = openMenu();
    fireEvent.click(menu.getByRole("button", { name: /^This Mac/ }));
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    menu = openMenu();
    fireEvent.click(menu.getByRole("button", { name: /^Work/ }));
    expect(assign).toHaveBeenCalledWith("https://notes.example.com/g/work");
  });

  it("renames through the shell and shows the list it answers with", async () => {
    inShell("http://127.0.0.1:6100/g/default", [MAC, WORK]);
    render(() => <GraphSwitcher />);
    const menu = openMenu();
    fireEvent.click(menu.getByRole("button", { name: "Rename Work" }));
    const input = menu.getByLabelText("New name for Work");
    fireEvent.input(input, { target: { value: "Job" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(assign).toHaveBeenCalledOnce();
    expect(lastRequest().pathname).toBe("/rename");
    expect(lastRequest().searchParams.get("graph")).toBe("server:s1");
    expect(lastRequest().searchParams.get("label")).toBe("Job");
    replyToLast({ ok: true, graphs: [MAC, { ...WORK, label: "Job" }] });
    await waitFor(() => expect(menu.getByRole("button", { name: /^Job/ })).toBeTruthy());
  });

  it("offers removal only for server graphs that are not open, and reports the shell's refusal", async () => {
    inShell("https://notes.example.com/g/work", [MAC, OTTER, WORK, LAN]);
    render(() => <GraphSwitcher />);
    const menu = openMenu();
    expect(menu.queryByRole("button", { name: "Remove This Mac" })).toBeNull();
    expect(menu.queryByRole("button", { name: "Remove Quiet Otter" })).toBeNull();
    expect(menu.queryByRole("button", { name: "Remove Work" })).toBeNull();
    fireEvent.click(menu.getByRole("button", { name: "Remove 192.168.1.5:6100" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("keeps the graph");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(lastRequest().pathname).toBe("/remove"));
    expect(lastRequest().searchParams.get("graph")).toBe("server:s2");
    replyToLast({ ok: false, error: "That graph is not in the list any more." });
    await waitFor(() =>
      expect(menu.getByRole("alert").textContent).toBe("That graph is not in the list any more."),
    );
  });

  it("B-786: a This-Mac graph is deleted only after 'delete' is typed, through the shell, and the menu says it is in the Trash", async () => {
    inShell("http://127.0.0.1:6100/g/default", [MAC, OTTER, WORK], { deleteMac: true });
    render(() => <GraphSwitcher />);
    const menu = openMenu();
    // Not the open graph (This Mac, which is also `default`), not a server graph.
    expect(menu.queryByRole("button", { name: "Delete This Mac" })).toBeNull();
    expect(menu.queryByRole("button", { name: "Delete Work" })).toBeNull();
    fireEvent.click(menu.getByRole("button", { name: "Delete Quiet Otter" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("only copy");
    expect(dialog.textContent).toContain("Trash");
    const go = within(dialog).getByRole("button", { name: "Move to Trash" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(go);
    expect(assign).not.toHaveBeenCalled();
    fireEvent.input(within(dialog).getByRole("textbox"), { target: { value: "delete" } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(lastRequest().pathname).toBe("/delete-mac-graph"));
    expect(lastRequest().searchParams.get("graph")).toBe("mac:quiet-otter");
    replyToLast({ ok: true, graphs: [MAC, WORK] });
    await waitFor(() => expect(menu.queryByRole("button", { name: /^Quiet Otter/ })).toBeNull());
    expect(menu.getByRole("status").textContent).toBe("“Quiet Otter” is in the Trash.");
  });

  it("B-786: Cancel deletes nothing, and the shell's refusal is shown", async () => {
    inShell("http://127.0.0.1:6100/g/default", [MAC, OTTER], { deleteMac: true });
    render(() => <GraphSwitcher />);
    const menu = openMenu();
    fireEvent.click(menu.getByRole("button", { name: "Delete Quiet Otter" }));
    let dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(assign).not.toHaveBeenCalled();
    fireEvent.click(menu.getByRole("button", { name: "Delete Quiet Otter" }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.input(within(dialog).getByRole("textbox"), { target: { value: "delete" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(lastRequest().pathname).toBe("/delete-mac-graph"));
    replyToLast({
      ok: false,
      error: "This graph is open. Open another graph first.",
      graphs: [MAC, OTTER],
    });
    await waitFor(() => expect(menu.getByRole("alert").textContent).toContain("is open"));
    expect(menu.getByRole("button", { name: /^Quiet Otter/ })).toBeTruthy();
  });

  it("B-786: not offered for the open graph, the last one, on a server's page, or by an older shell", () => {
    // The open graph.
    inShell("http://127.0.0.1:6100/g/quiet-otter", [MAC, OTTER], { deleteMac: true });
    render(() => <GraphSwitcher />);
    expect(openMenu().queryByRole("button", { name: /^Delete / })).toBeNull();
    cleanup();
    // The last graph on this Mac (the page is some other graph).
    inShell("http://127.0.0.1:6100/g/x", [OTTER, WORK], { deleteMac: true });
    render(() => <GraphSwitcher />);
    expect(openMenu().queryByRole("button", { name: /^Delete / })).toBeNull();
    cleanup();
    // A server's page: whatever that server serves must not delete folders on this Mac.
    inShell("https://notes.example.com/g/work", [MAC, OTTER, WORK], { deleteMac: true });
    render(() => <GraphSwitcher />);
    expect(openMenu().queryByRole("button", { name: /^Delete / })).toBeNull();
    cleanup();
    // A shell that does not answer the request.
    inShell("http://127.0.0.1:6100/g/default", [MAC, OTTER, WORK]);
    render(() => <GraphSwitcher />);
    expect(openMenu().queryByRole("button", { name: /^Delete / })).toBeNull();
  });

  it("Graphs… in the native menu opens it, even when the sidebar mounts it afterwards", () => {
    inShell("http://127.0.0.1:6100/g/default", [MAC]);
    requestGraphMenu();
    render(() => <GraphSwitcher />);
    expect(screen.getByRole("dialog", { name: "Graphs" })).toBeTruthy();
    expect(document.body.classList.contains("sidebar-open")).toBe(true);
    document.body.classList.remove("sidebar-open");
  });
});

describe("the desktop add form (B-782: one form, errors on it)", () => {
  function openAdd(flags: { listServerGraphs?: boolean } = {}): ReturnType<typeof within> {
    inShell("http://127.0.0.1:6100/g/default", [MAC, WORK], flags);
    render(() => <GraphSwitcher />);
    const menu = openMenu();
    fireEvent.click(menu.getByRole("button", { name: "Add a graph" }));
    return menu;
  }

  function connectSection(menu: ReturnType<typeof within>): ReturnType<typeof within> {
    return within(menu.getByRole("region", { name: "Connect to a server" }));
  }

  it("Create on this Mac takes a name and asks the shell; a failure is said on the form", async () => {
    const menu = openAdd();
    const mac = within(menu.getByRole("region", { name: "Create on this Mac" }));
    const name = mac.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).not.toBe("");
    expect(name.value).not.toBe("This Mac");
    fireEvent.input(name, { target: { value: "Garden" } });
    fireEvent.click(mac.getByRole("button", { name: "Create" }));
    expect(lastRequest().pathname).toBe("/new-local-graph");
    expect(lastRequest().searchParams.get("label")).toBe("Garden");
    expect(lastRequest().searchParams.get("key")).toBe("k");
    replyToLast({ ok: false, error: "graph create failed" });
    await waitFor(() => expect(mac.getByRole("alert").textContent).toBe("graph create failed"));
  });

  it("a token of the wrong shape is named before anything is sent (B-706)", () => {
    const server = connectSection(openAdd());
    fireEvent.input(server.getByLabelText("Server address"), {
      target: { value: "https://notes.example.com/g/work" },
    });
    fireEvent.input(server.getByLabelText("Device token or pairing link"), {
      target: { value: `nkroot_${"a".repeat(48)}` },
    });
    fireEvent.click(server.getByRole("button", { name: "Connect" }));
    expect(server.getByRole("alert").textContent).toContain("root token");
    expect(assign).not.toHaveBeenCalled();
  });

  it("an address without http(s) is named before anything is sent", () => {
    const server = connectSection(openAdd());
    fireEvent.input(server.getByLabelText("Server address"), {
      target: { value: "notes.example.com" },
    });
    fireEvent.input(server.getByLabelText("Device token or pairing link"), {
      target: { value: TOKEN },
    });
    fireEvent.click(server.getByRole("button", { name: "Connect" }));
    expect(server.getByRole("alert").textContent).toContain("http://");
    expect(assign).not.toHaveBeenCalled();
  });

  it("the shell checks address and token in one request; unreachable and rejected come back to the form", async () => {
    const server = connectSection(openAdd());
    fireEvent.input(server.getByLabelText("Server address"), {
      target: { value: " https://notes.example.com/ " },
    });
    // B-706: what surrounds a pasted token is dropped, and the field shows what is sent.
    fireEvent.input(server.getByLabelText("Device token or pairing link"), {
      target: { value: `\`${TOKEN}\`.` },
    });
    fireEvent.click(server.getByRole("button", { name: "Connect" }));
    const sent = lastRequest();
    expect(sent.pathname).toBe("/connect-server");
    expect(sent.searchParams.get("address")).toBe("https://notes.example.com");
    expect(sent.searchParams.get("token")).toBe(TOKEN);
    expect((server.getByLabelText("Device token or pairing link") as HTMLInputElement).value).toBe(
      TOKEN,
    );
    expect(server.getByRole("button", { name: "Connecting…" })).toBeTruthy();
    // The page itself never contacts the server: that would be cross-origin (B-704).
    expect(fetchMock).not.toHaveBeenCalled();

    replyToLast({ ok: false, error: "Couldn't reach notes.example.com: Connection refused" });
    await waitFor(() => expect(server.getByRole("alert").textContent).toContain("Couldn't reach"));
    fireEvent.click(server.getByRole("button", { name: "Connect" }));
    replyToLast({
      ok: false,
      error: "That token was rejected. Check it was copied whole, and not revoked.",
    });
    await waitFor(() => expect(server.getByRole("alert").textContent).toContain("rejected"));
  });

  it("a pasted pairing link fills the address, asks this Mac's name, and sends the code", () => {
    const server = connectSection(openAdd());
    const code = "nkp_abcdefghijklmnopqrstuv";
    fireEvent.input(server.getByLabelText("Device token or pairing link"), {
      target: { value: `https://notes.example.com/g/work/pair#code=${code}` },
    });
    expect((server.getByLabelText("Server address") as HTMLInputElement).value).toBe(
      "https://notes.example.com/g/work",
    );
    fireEvent.input(server.getByLabelText("Name this Mac"), { target: { value: "Studio" } });
    fireEvent.click(server.getByRole("button", { name: "Connect" }));
    const sent = lastRequest();
    expect(sent.searchParams.get("code")).toBe(code);
    expect(sent.searchParams.get("device")).toBe("Studio");
    expect(sent.searchParams.get("token")).toBeNull();
  });

  const ROOT = `nkroot_${"cd".repeat(24)}`;

  it("B-787: with a root token, the shell lists the server's graphs; picking one fills the address and drops the root token", async () => {
    const server = connectSection(openAdd({ listServerGraphs: true }));
    fireEvent.input(server.getByLabelText("Server address"), {
      target: { value: "https://notes.example.com" },
    });
    fireEvent.input(server.getByLabelText("Device token or pairing link"), {
      target: { value: ` ${ROOT}. ` },
    });
    fireEvent.click(
      server.getByRole("button", { name: "Show graphs on this server (root token)" }),
    );
    const sent = lastRequest();
    expect(sent.origin).toBe("http://nooklet-desktop.invalid");
    expect(sent.pathname).toBe("/list-server-graphs");
    expect(sent.searchParams.get("address")).toBe("https://notes.example.com");
    expect(sent.searchParams.get("token")).toBe(ROOT);
    expect(server.getByRole("button", { name: "Listing…" })).toBeTruthy();
    // The page itself never contacts the server (cross-origin, B-704).
    expect(fetchMock).not.toHaveBeenCalled();
    replyToLast({
      ok: true,
      serverGraphs: [
        { id: "work", label: "Work", address: "https://notes.example.com/g/work" },
        { id: "garden", label: "Garden", address: "https://notes.example.com/g/garden" },
      ],
    });
    const list = within(await server.findByRole("list", { name: "Graphs on this server" }));
    expect(list.getByRole("button", { name: /^Work/ }).textContent).toContain(
      "already on this Mac",
    );
    fireEvent.click(list.getByRole("button", { name: /^Garden/ }));
    expect((server.getByLabelText("Server address") as HTMLInputElement).value).toBe(
      "https://notes.example.com/g/garden",
    );
    // The root token is gone from the form: it cannot open a graph, and it is never kept.
    expect((server.getByLabelText("Device token or pairing link") as HTMLInputElement).value).toBe(
      "",
    );
    expect(server.getByRole("status").textContent).toContain("nooklet token create --graph garden");
    expect(server.queryByRole("list", { name: "Graphs on this server" })).toBeNull();
    expect(JSON.stringify({ ...localStorage })).not.toContain(ROOT);
    // Connecting then sends the picked graph's DEVICE token, as any connect.
    fireEvent.input(server.getByLabelText("Device token or pairing link"), {
      target: { value: TOKEN },
    });
    fireEvent.click(server.getByRole("button", { name: "Connect" }));
    expect(lastRequest().pathname).toBe("/connect-server");
    expect(lastRequest().searchParams.get("address")).toBe("https://notes.example.com/g/garden");
    expect(lastRequest().searchParams.get("token")).toBe(TOKEN);
  });

  it("B-787: a device token in the field is named before anything is sent; a refusal comes back to the form", async () => {
    const server = connectSection(openAdd({ listServerGraphs: true }));
    fireEvent.input(server.getByLabelText("Server address"), {
      target: { value: "https://notes.example.com" },
    });
    fireEvent.input(server.getByLabelText("Device token or pairing link"), {
      target: { value: TOKEN },
    });
    fireEvent.click(
      server.getByRole("button", { name: "Show graphs on this server (root token)" }),
    );
    expect(server.getByRole("alert").textContent).toContain("That's a device token");
    expect(assign).not.toHaveBeenCalled();
    fireEvent.input(server.getByLabelText("Device token or pairing link"), {
      target: { value: ROOT },
    });
    fireEvent.click(
      server.getByRole("button", { name: "Show graphs on this server (root token)" }),
    );
    replyToLast({ ok: false, error: "That root token was rejected." });
    await waitFor(() => expect(server.getByRole("alert").textContent).toContain("rejected"));
    expect(server.queryByRole("list", { name: "Graphs on this server" })).toBeNull();
  });

  it("B-787: not offered by a shell that does not answer it", () => {
    const server = connectSection(openAdd());
    expect(server.queryByRole("button", { name: /Show graphs on this server/ })).toBeNull();
  });
});
