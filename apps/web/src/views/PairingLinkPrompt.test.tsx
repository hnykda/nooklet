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
    // Only the pairing wording: no "needs a token to reach <this page's host>" (seen on the
    // Simulator as "…reach localhost", which is not the server being confirmed).
    expect(screen.queryByText(/needs a token to reach/)).toBeNull();
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

  it("B-655: a link with a one-time code asks for a device name, redeems the code, then connects with the new token", async () => {
    const CODE = "nkp_abcdefghijklmnopqrstuv";
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: TOKEN, token_id: "t1", scope: "write", sync: true }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const reload = mockReload();
    render(() => <PairingLinkPrompt />);
    deepLink.cb?.(
      `nooklet://connect?url=${encodeURIComponent("https://n.example.ts.net/g/default")}&code=${CODE}`,
    );
    await screen.findByRole("dialog");
    expect(screen.queryByLabelText("Device token")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled(); // never by itself
    const name = screen.getByLabelText("Name this device") as HTMLInputElement;
    fireEvent.input(name, { target: { value: "Test phone" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());

    const [redeemUrl, redeemInit] = fetchMock.mock.calls[0] ?? [];
    expect(redeemUrl).toBe("https://n.example.ts.net/g/default/api/v1/pairing.redeem");
    expect(JSON.parse(String(redeemInit?.body))).toEqual({ code: CODE, label: "Test phone" });
    // No credential on the redeem: it is the one call made without one.
    expect(new Headers(redeemInit?.headers).has("authorization")).toBe(false);
    expect(activeGraph()).toMatchObject({
      kind: "remote",
      baseUrl: "https://n.example.ts.net/g/default",
      token: TOKEN,
    });
  });

  it("B-655: an expired or used code says so and stores nothing", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "x" } }), {
        status: 401,
      }),
    );
    render(() => <PairingLinkPrompt />);
    deepLink.cb?.(
      `nooklet://connect?url=${encodeURIComponent("https://n.example.ts.net")}&code=nkp_abcdefghijklmnopqrstuv`,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no longer valid");
    expect(listGraphs()).toEqual([]);
  });

  it("ignores nooklet:// links that are not pairing links", () => {
    render(() => <PairingLinkPrompt />);
    deepLink.cb?.("nooklet://page/Foo");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
