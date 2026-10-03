// @vitest-environment jsdom
/**
 * The graph list (ADR 025) and `apiBaseUrl()`'s precedence: the active entry's own address wins
 * over this page's own `/g/<slug>` prefix (the zero-config fallback for a fresh device with no
 * list yet), which wins over a build-time default, which wins over bare same-origin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeGraph,
  addGraph,
  adoptLegacyReplica,
  apiBaseUrl,
  chooseLocalOnly,
  graphEntryUrl,
  hasSyncTarget,
  isLocalOnlyEntry,
  listGraphs,
  removeGraph,
  replicaKey,
  resetBootstrapForTests,
  setActiveGraphId,
  setConnectedGraphToken,
  soleLegacyStateOwner,
  updateGraph,
} from "./bootstrap.js";

const fakePlatform = vi.hoisted(() => ({ name: "web" as "web" | "capacitor" }));
vi.mock("../platform/index.js", () => ({ platform: fakePlatform }));

beforeEach(() => {
  localStorage.clear();
  resetBootstrapForTests();
  fakePlatform.name = "web";
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("graph list", () => {
  it("round-trips add/update/remove, and clears the active pointer when the active entry is removed", () => {
    addGraph({ id: "a", label: "A", kind: "remote", baseUrl: "https://a.example.com" });
    setActiveGraphId("a");
    expect(activeGraph()).toEqual({
      id: "a",
      label: "A",
      kind: "remote",
      baseUrl: "https://a.example.com",
    });

    updateGraph("a", { label: "Renamed A" });
    expect(activeGraph()?.label).toBe("Renamed A");

    removeGraph("a");
    expect(listGraphs()).toEqual([]);
    expect(activeGraph()).toBeUndefined();
  });

  it("adding an entry with an existing id replaces it rather than duplicating", () => {
    addGraph({ id: "a", label: "A", kind: "remote" });
    addGraph({ id: "a", label: "A renamed", kind: "remote" });
    expect(listGraphs()).toHaveLength(1);
    expect(listGraphs()[0]?.label).toBe("A renamed");
  });
});

describe("setConnectedGraphToken", () => {
  it("web/desktop (remoteBaseUrl null): applies the token to the current active entry", () => {
    addGraph({ id: "a", label: "This graph", kind: "local" });
    setActiveGraphId("a");
    setConnectedGraphToken(null, "nk_new");
    expect(activeGraph()?.token).toBe("nk_new");
    expect(listGraphs()).toHaveLength(1);
  });

  it("web/desktop with no active entry yet: creates one with no baseUrl (jsdom has no /g/ path)", () => {
    setConnectedGraphToken(null, "nk_abc");
    expect(activeGraph()?.token).toBe("nk_abc");
    expect(activeGraph()?.baseUrl).toBeUndefined();
  });

  it("Capacitor (remoteBaseUrl set): creates a remote entry and makes it active", () => {
    setConnectedGraphToken("https://phone-configured.example.com", "nk_abc");
    expect(activeGraph()?.baseUrl).toBe("https://phone-configured.example.com");
    expect(activeGraph()?.token).toBe("nk_abc");
    expect(activeGraph()?.kind).toBe("remote");
  });

  it("reconnecting to the same address updates the existing entry instead of duplicating it", () => {
    setConnectedGraphToken("https://nooklet.example.com", "nk_old");
    const firstId = activeGraph()?.id;
    setConnectedGraphToken("https://nooklet.example.com", "nk_new");
    expect(listGraphs()).toHaveLength(1);
    expect(activeGraph()?.id).toBe(firstId);
    expect(activeGraph()?.token).toBe("nk_new");
  });
});

describe("apiBaseUrl() precedence", () => {
  it("is same-origin (empty string) with nothing configured and no /g/ path", () => {
    expect(apiBaseUrl()).toBe("");
  });

  it("falls back to VITE_API_BASE_URL when nothing is stored", () => {
    vi.stubEnv("VITE_API_BASE_URL", "http://dev.test:6100");
    expect(apiBaseUrl()).toBe("http://dev.test:6100");
  });

  it("falls back to VITE_SYNC_BASE_URL when VITE_API_BASE_URL is unset", () => {
    vi.stubEnv("VITE_SYNC_BASE_URL", "http://sync.test:6100");
    expect(apiBaseUrl()).toBe("http://sync.test:6100");
  });

  it("the active graph's own baseUrl wins over either build-time env var", () => {
    vi.stubEnv("VITE_API_BASE_URL", "http://dev.test:6100");
    setConnectedGraphToken("https://phone-configured.example.com", "nk_abc");
    expect(apiBaseUrl()).toBe("https://phone-configured.example.com");
  });
});

describe("hasSyncTarget()", () => {
  it("is true on web/desktop with no active entry yet (implicit same-origin)", () => {
    fakePlatform.name = "web";
    expect(hasSyncTarget()).toBe(true);
  });

  it("is false on Capacitor with no active entry (B-563 'Just this device')", () => {
    fakePlatform.name = "capacitor";
    expect(hasSyncTarget()).toBe(false);
  });

  it("is true once an entry with a real baseUrl is active, on any platform", () => {
    fakePlatform.name = "capacitor";
    setConnectedGraphToken("https://nooklet.example.com", "nk_abc");
    expect(hasSyncTarget()).toBe(true);
  });

  it("is false for an active local-only entry (no baseUrl)", () => {
    addGraph({ id: "local1", label: "Local", kind: "local" });
    setActiveGraphId("local1");
    expect(hasSyncTarget()).toBe(false);
  });
});

describe('B-612: "Just this device" is a real list entry', () => {
  it("the first choice adopts the un-namespaced replica this load already opened, no reload", () => {
    fakePlatform.name = "capacitor";
    expect(chooseLocalOnly()).toEqual({ reload: false });
    const entry = activeGraph();
    expect(entry).toMatchObject({ kind: "local", legacyReplica: true });
    expect(entry?.baseUrl).toBeUndefined();
    expect(replicaKey(entry)).toBeUndefined();
    expect(isLocalOnlyEntry(entry)).toBe(true);
  });

  it("is adopted once only: removing that entry does not make a later local graph inherit it", () => {
    fakePlatform.name = "capacitor";
    const first = adoptLegacyReplica();
    expect(first).toBeDefined();
    removeGraph(first?.id as string);
    expect(adoptLegacyReplica()).toBeUndefined();
    // So the next "Just this device" is a fresh, namespaced replica, which needs a reload to open.
    expect(chooseLocalOnly()).toEqual({ reload: true });
    expect(replicaKey(activeGraph())).toBe(activeGraph()?.id);
  });

  it("a stranded install (remote entry active) gets its local data back as a second entry", () => {
    fakePlatform.name = "capacitor";
    addGraph({ id: "r", label: "Remote graph", kind: "remote", baseUrl: "https://s.example/g/x" });
    setActiveGraphId("r");
    adoptLegacyReplica();
    expect(listGraphs().map((g) => g.label)).toEqual(["Remote graph", "This device"]);
    expect(activeGraph()?.id).toBe("r");
  });
});

describe("B-611: who could have written state from before it was keyed by graph", () => {
  it("Capacitor with no entries, or only the adopted local one: the un-namespaced replica", () => {
    fakePlatform.name = "capacitor";
    expect(soleLegacyStateOwner()).toBe("~");
    adoptLegacyReplica();
    expect(soleLegacyStateOwner()).toBe("~");
  });

  it("Capacitor with a server entry: ambiguous (the leak scenario), so nobody", () => {
    fakePlatform.name = "capacitor";
    addGraph({ id: "r", label: "R", kind: "remote", baseUrl: "https://s.example/g/x" });
    expect(soleLegacyStateOwner()).toBeUndefined();
  });

  it("web with one entry: that entry; with two: nobody", () => {
    addGraph({ id: "a", label: "A", kind: "local", baseUrl: "/g/default" });
    expect(soleLegacyStateOwner()).toBe("a");
    addGraph({ id: "b", label: "B", kind: "remote", baseUrl: "/g/work" });
    expect(soleLegacyStateOwner()).toBeUndefined();
  });
});

describe("graphEntryUrl under Capacitor", () => {
  it("reloads the app in place instead of navigating the WebView to the server's address", () => {
    fakePlatform.name = "capacitor";
    const loc = { pathname: "/journals", search: "", hash: "" } as Location;
    const remote = {
      id: "r",
      label: "R",
      kind: "remote" as const,
      baseUrl: "https://s.example/g/x",
    };
    expect(graphEntryUrl(remote, loc)).toBe("/journals");
  });
});
