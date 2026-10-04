// @vitest-environment jsdom
/**
 * The "server address" field only exists under Capacitor (no address bar of its own — see
 * `ConnectView.tsx`'s doc comment) and must not regress the web/PWA path, which still relies on
 * the relative fetch resolving against the page's own origin.
 */
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakePlatform = vi.hoisted(() => ({ name: "web" as "web" | "capacitor" }));
vi.mock("../platform/index.js", () => ({ platform: fakePlatform }));

import { activeGraph, resetBootstrapForTests } from "../data/bootstrap.js";
import { ConnectView } from "./ConnectView.js";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

function ok(): Response {
  return new Response(JSON.stringify({}), { status: 200 });
}

/** jsdom's `Location.prototype.reload` is not configurable, so `vi.spyOn` on the live object
 * fails with "Cannot redefine property" — replace the whole `location` instead. */
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

afterEach(() => {
  cleanup();
  fakePlatform.name = "web";
});

describe("web/PWA: unchanged, no server-address field", () => {
  it("has no server-address field and posts to a relative path", async () => {
    fakePlatform.name = "web";
    fetchMock.mockResolvedValueOnce(ok());
    const reload = mockReload();

    render(() => <ConnectView />);
    expect(screen.queryByLabelText("Server address")).toBeNull();

    fireEvent.input(screen.getByLabelText("Device token"), { target: { value: "nk_abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByRole("button", { name: "Connect" }); // settles after reload() no-ops

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/graph.overview");
    expect(activeGraph()?.token).toBe("nk_abc");
    expect(activeGraph()?.baseUrl).toBeUndefined();
    expect(reload).toHaveBeenCalled();
  });

  it("on /g/<slug>, verifies against that graph, not the server's default", async () => {
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, pathname: "/g/work/journals", reload: vi.fn() },
    });
    try {
      fakePlatform.name = "web";
      fetchMock.mockResolvedValueOnce(ok());
      render(() => <ConnectView />);
      fireEvent.input(screen.getByLabelText("Device token"), { target: { value: "nk_work" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      await screen.findByRole("button", { name: "Connect" });
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/g/work/api/v1/graph.overview");
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });
});

describe("Capacitor: a server-address field is required first", () => {
  it("shows the field, and Connect is disabled until both are filled", () => {
    fakePlatform.name = "capacitor";
    render(() => <ConnectView />);
    const button = () => screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expect(button().disabled).toBe(true);

    fireEvent.input(screen.getByLabelText("Server address"), {
      target: { value: "https://nooklet.example.com" },
    });
    expect(button().disabled).toBe(true); // token still empty

    fireEvent.input(screen.getByLabelText("Device token"), { target: { value: "nk_abc" } });
    expect(button().disabled).toBe(false);
  });

  it("rejects an address with no http(s) scheme, without ever calling fetch", async () => {
    fakePlatform.name = "capacitor";
    render(() => <ConnectView />);
    fireEvent.input(screen.getByLabelText("Server address"), {
      target: { value: "nooklet.example.com" },
    });
    fireEvent.input(screen.getByLabelText("Device token"), { target: { value: "nk_abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("http://");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verifies against the entered address (absolute URL, trailing slash stripped), then stores both", async () => {
    fakePlatform.name = "capacitor";
    fetchMock.mockResolvedValueOnce(ok());
    const reload = mockReload();

    render(() => <ConnectView />);
    fireEvent.input(screen.getByLabelText("Server address"), {
      target: { value: "https://nooklet.example.com/" },
    });
    fireEvent.input(screen.getByLabelText("Device token"), { target: { value: "nk_abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByRole("button", { name: "Connect" });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    // A bare origin is stored as `/g/default`: a WebSocket never follows the server's bare-origin
    // 307, so storing the bare origin left live sync never connecting.
    expect(url).toBe("https://nooklet.example.com/g/default/api/v1/graph.overview");
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer nk_abc",
    );
    expect(activeGraph()?.baseUrl).toBe("https://nooklet.example.com/g/default");
    expect(activeGraph()?.token).toBe("nk_abc");
    expect(reload).toHaveBeenCalled();
  });

  it("names the address it could not reach, and stores neither on failure", async () => {
    fakePlatform.name = "capacitor";
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(() => <ConnectView />);
    fireEvent.input(screen.getByLabelText("Server address"), {
      target: { value: "https://unreachable.example.com" },
    });
    fireEvent.input(screen.getByLabelText("Device token"), { target: { value: "nk_abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("https://unreachable.example.com");
    expect(activeGraph()).toBeUndefined();
  });

  it("rejects an invalid token without storing the address it did reach", async () => {
    fakePlatform.name = "capacitor";
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    render(() => <ConnectView />);
    fireEvent.input(screen.getByLabelText("Server address"), {
      target: { value: "https://nooklet.example.com" },
    });
    fireEvent.input(screen.getByLabelText("Device token"), { target: { value: "nk_bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    const alert = await screen.findByRole("alert");
    // A bare address is checked against the default graph: the hint is about the address.
    expect(alert.textContent).toContain("isn't valid for the server's default graph");
    expect(alert.textContent).toContain("https://nooklet.example.com/g/work");
    expect(activeGraph()).toBeUndefined();
  });

  it("a refused token for an address that names a graph keeps the copy-or-revoked message", async () => {
    fakePlatform.name = "capacitor";
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    render(() => <ConnectView />);
    fireEvent.input(screen.getByLabelText("Server address"), {
      target: { value: "https://nooklet.example.com/g/work" },
    });
    fireEvent.input(screen.getByLabelText("Device token"), { target: { value: "nk_bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "That token was rejected. Check it was copied whole, and not revoked.",
    );
  });
});

describe("B-563: choice screen precedes the form whenever a skip path exists", () => {
  it("with onSkip, starts on the choice screen — no form fields yet", () => {
    render(() => <ConnectView onSkip={() => {}} />);
    expect(screen.getByRole("heading", { name: "Just this device" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sync with a server" })).toBeTruthy();
    expect(screen.queryByLabelText("Device token")).toBeNull();
  });

  it("without onSkip, skips the choice screen and goes straight to the form", () => {
    render(() => <ConnectView />);
    expect(screen.queryByRole("heading", { name: "Just this device" })).toBeNull();
    expect(screen.getByLabelText("Device token")).toBeTruthy();
  });

  it("choosing 'Just this device' calls onSkip", () => {
    const onSkip = vi.fn();
    render(() => <ConnectView onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: /Just this device/s }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("choosing 'Sync with a server' reveals the form, and Back returns to the choice", () => {
    render(() => <ConnectView onSkip={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Sync with a server/s }));
    expect(screen.getByLabelText("Device token")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "‹ Back" }));
    expect(screen.getByRole("heading", { name: "Just this device" })).toBeTruthy();
    expect(screen.queryByLabelText("Device token")).toBeNull();
  });
});

describe("B-613 × B-603: re-pair wins over a pairing link", () => {
  const repair = {
    connectBase: "https://home.example/g/default",
    displayUrl: "https://home.example/g/default",
    sessionBase: "https://home.example/g/default",
    graphSlug: "default",
    onCancel: () => {},
  };

  it("a link for another server cannot change the address, and its token is not used", () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: null }), { status: 200 }));
    render(() => (
      <ConnectView
        repair={repair}
        prefill={{ serverUrl: "https://evil.example/g/default", token: "nk_evil" }}
      />
    ));
    const address = screen.getByLabelText("Server address") as HTMLInputElement;
    expect(address.value).toBe("https://home.example/g/default");
    expect(address.readOnly).toBe(true);
    expect((screen.getByLabelText("Device token") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("https://evil.example/g/default")).toBeNull();
  });

  it("a link for the same graph (bare origin) pre-fills only the token", () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: null }), { status: 200 }));
    render(() => (
      <ConnectView
        repair={repair}
        prefill={{ serverUrl: "https://home.example/", token: "nk_new" }}
      />
    ));
    expect((screen.getByLabelText("Server address") as HTMLInputElement).value).toBe(
      "https://home.example/g/default",
    );
    expect((screen.getByLabelText("Device token") as HTMLInputElement).value).toBe("nk_new");
  });
});
