// @vitest-environment jsdom
/**
 * B-603: a `nooklet://connect` link opens the connect screen pre-filled and waits for a tap; it
 * never connects by itself, and connecting adds a server graph without dropping local ones.
 */
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deepLink = vi.hoisted(() => ({ cb: undefined as ((url: string) => void) | undefined }));
const fakePlatform = vi.hoisted(() => ({
  name: "capacitor" as const,
  deepLinks: {
    onOpen(cb: (url: string) => void) {
      deepLink.cb = cb;
      return () => {
        deepLink.cb = undefined;
      };
    },
  },
}));
vi.mock("../platform/index.js", () => ({ platform: fakePlatform }));

import {
  activeGraph,
  createLocalOnlyGraph,
  listGraphs,
  resetBootstrapForTests,
} from "../data/bootstrap.js";
import { PairingLinkPrompt } from "./PairingLinkPrompt.js";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

const TOKEN = `nk_${"b".repeat(48)}`;
const LINK = `nooklet://connect?url=${encodeURIComponent("http://192.168.1.5:6100")}&token=${TOKEN}`;

function mockReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
  return reload;
}

beforeEach(() => {
  localStorage.clear();
  resetBootstrapForTests();
  fetchMock.mockReset();
});
afterEach(() => cleanup());

describe("PairingLinkPrompt (B-603)", () => {
  it("shows nothing until a link arrives, then the pre-filled confirm screen — and contacts nothing", async () => {
    render(() => <PairingLinkPrompt />);
    expect(screen.queryByRole("dialog")).toBeNull();

    deepLink.cb?.(LINK);
    await screen.findByRole("dialog");
    expect(screen.getByText("Connect to this server?")).toBeTruthy();
    expect(screen.getByTestId("pairing-server").textContent).toBe("http://192.168.1.5:6100");
    expect((screen.getByLabelText("Server address") as HTMLInputElement).value).toBe(
      "http://192.168.1.5:6100",
    );
    expect((screen.getByLabelText("Device token") as HTMLInputElement).value).toBe(TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(activeGraph()).toBeUndefined();
  });

  it("Connect adds the server graph and keeps an existing local-only graph", async () => {
    createLocalOnlyGraph("On this phone");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const reload = mockReload();
    render(() => <PairingLinkPrompt />);
    deepLink.cb?.(LINK);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://192.168.1.5:6100/g/default/api/v1/graph.overview",
    );
    const graphs = listGraphs();
    expect(graphs.map((g) => g.kind).sort()).toEqual(["local", "remote"]);
    expect(activeGraph()).toMatchObject({
      kind: "remote",
      baseUrl: "http://192.168.1.5:6100/g/default",
      token: TOKEN,
    });
  });

  it("Cancel dismisses without storing anything", async () => {
    render(() => <PairingLinkPrompt />);
    deepLink.cb?.(LINK);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(listGraphs()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains a malformed pairing link instead of opening the form", async () => {
    render(() => <PairingLinkPrompt />);
    deepLink.cb?.(`nooklet://connect?url=javascript:alert(1)&token=${TOKEN}`);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("http://");
    expect(screen.queryByLabelText("Device token")).toBeNull();
  });

  it("ignores nooklet:// links that are not pairing links", () => {
    render(() => <PairingLinkPrompt />);
    deepLink.cb?.("nooklet://page/Foo");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
