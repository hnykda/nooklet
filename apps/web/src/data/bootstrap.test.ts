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
  apiBaseUrl,
  hasSyncTarget,
  listGraphs,
  removeGraph,
  resetBootstrapForTests,
  setActiveGraphId,
  setConnectedGraphToken,
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
