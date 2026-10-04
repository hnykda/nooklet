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
  adoptAddressBarGraph,
  adoptLegacyReplica,
  apiBaseUrl,
  canPromoteGraph,
  chooseLocalOnly,
  createLocalOnlyGraph,
  graphEntryUrl,
  hasSyncTarget,
  initBootstrap,
  isLocalOnlyEntry,
  keepAsDeviceOnlyCopy,
  listGraphs,
  newLocalGraphName,
  removeGraph,
  replicaKey,
  resetBootstrapForTests,
  setActiveGraphId,
  setConnectedGraphToken,
  soleLegacyStateOwner,
  updateGraph,
} from "./bootstrap.js";
import { GRAPH_NAMES } from "./graph-names.js";

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

  it("B-618: an absolute address for the same-origin entry matches it, keeping its own form", () => {
    addGraph({ id: "here", label: "This graph", kind: "local", baseUrl: "/g/default" });
    setActiveGraphId("here");
    setConnectedGraphToken(`${location.origin}/g/default/`, "nk_new", "Home");
    expect(listGraphs()).toHaveLength(1);
    expect(activeGraph()).toMatchObject({
      id: "here",
      baseUrl: "/g/default",
      token: "nk_new",
      label: "Home",
    });
  });

  it("B-618: the server's label replaces a placeholder, never a label someone chose", () => {
    setConnectedGraphToken("https://h.example/g/work", "nk_a", "Work notes");
    expect(activeGraph()?.label).toBe("Work notes");
    updateGraph(activeGraph()?.id as string, { label: "Mine" });
    setConnectedGraphToken("https://h.example/g/work", "nk_b", "Work notes");
    expect(activeGraph()?.label).toBe("Mine");
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

  it("B-644: each new local graph gets its own curated name; existing names are left alone", () => {
    fakePlatform.name = "capacitor";
    addGraph({ id: "old", label: "This device", kind: "local" });
    chooseLocalOnly();
    chooseLocalOnly();
    createLocalOnlyGraph();
    const labels = listGraphs().map((g) => g.label);
    expect(labels[0]).toBe("This device");
    const fresh = labels.slice(1);
    expect(fresh).toHaveLength(3);
    for (const label of fresh) expect(GRAPH_NAMES).toContain(label);
    expect(new Set(fresh).size).toBe(3);
    // The desktop's This-Mac graphs are not in this list, but their names count as taken too.
    const taken = GRAPH_NAMES.filter((n) => !fresh.includes(n)).slice(1);
    expect(newLocalGraphName(taken)).toBe(
      GRAPH_NAMES.find((n) => !fresh.includes(n) && !taken.includes(n)),
    );
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

describe("adoptAddressBarGraph: the address bar's graph wins over another same-origin entry", () => {
  afterEach(() => history.replaceState(null, "", "/"));

  it("switches to the entry for /g/<slug>, adding one when this device has none", () => {
    addGraph({ id: "d", label: "default", kind: "local", baseUrl: "/g/default", token: "nk_d" });
    setActiveGraphId("d");
    history.replaceState(null, "", "/g/quiet-otter/journals");
    adoptAddressBarGraph();
    const entry = activeGraph();
    expect(entry?.id).not.toBe("d");
    expect(entry).toMatchObject({ baseUrl: "/g/quiet-otter", kind: "local" });
    expect(entry?.token).toBeUndefined();
    expect(apiBaseUrl()).toBe("/g/quiet-otter");

    // Back to the default graph's address: its existing entry (and token) is reused, not duplicated.
    history.replaceState(null, "", "/g/default/journals");
    adoptAddressBarGraph();
    expect(activeGraph()?.id).toBe("d");
    expect(listGraphs()).toHaveLength(2);
  });

  it("an absolute spelling of the same graph is the same graph", () => {
    addGraph({ id: "d", label: "x", kind: "local", baseUrl: `${location.origin}/g/default` });
    setActiveGraphId("d");
    history.replaceState(null, "", "/g/default/page/A");
    adoptAddressBarGraph();
    expect(activeGraph()?.id).toBe("d");
    expect(listGraphs()).toHaveLength(1);
  });

  it("leaves a local-only entry, another origin's graph, and Capacitor alone", () => {
    history.replaceState(null, "", "/g/other/journals");
    addGraph({ id: "l", label: "L", kind: "local" });
    setActiveGraphId("l");
    adoptAddressBarGraph();
    expect(activeGraph()?.id).toBe("l");

    addGraph({ id: "r", label: "R", kind: "remote", baseUrl: "https://elsewhere.example/g/x" });
    setActiveGraphId("r");
    adoptAddressBarGraph();
    expect(activeGraph()?.id).toBe("r");

    fakePlatform.name = "capacitor";
    addGraph({ id: "d", label: "D", kind: "local", baseUrl: "/g/default" });
    setActiveGraphId("d");
    adoptAddressBarGraph();
    expect(activeGraph()?.id).toBe("d");
    expect(listGraphs()).toHaveLength(3);
  });
});

describe("B-714: keeping a mismatched replica as a device-only copy", () => {
  const server = { id: "s", label: "Notes", kind: "remote" as const };

  it("re-points nothing on disk: the copy keeps the replica key, the server graph gets a new one", () => {
    fakePlatform.name = "capacitor";
    addGraph({ id: "other", label: "Elsewhere", kind: "local" });
    addGraph({
      ...server,
      baseUrl: "https://notes.example/g/alpha",
      token: "nk_old",
      graphInstanceId: "old-instance",
    });
    setActiveGraphId("s");
    const before = replicaKey(activeGraph());

    const { copy, server: added } = keepAsDeviceOnlyCopy("s", "new-instance", {
      addServerGraph: true,
    });

    // The copy IS the old entry: same id, so the same OPFS file, B-247 journal, checkpoint,
    // drafts and shelf (all keyed by `replicaKey`).
    expect(copy.id).toBe("s");
    expect(replicaKey(copy)).toBe(before);
    expect(copy).toMatchObject({
      label: "Notes (old copy)",
      kind: "local",
      graphInstanceId: "old-instance",
      detachedFrom: {
        address: "https://notes.example/g/alpha",
        graphInstanceId: "old-instance",
        replacedBy: "new-instance",
      },
    });
    expect(copy.baseUrl).toBeUndefined();
    expect(copy.token).toBeUndefined();
    expect(isLocalOnlyEntry(copy)).toBe(true);

    // The server's graph is a new entry, so a new, empty replica that syncs fresh, and it already
    // knows the server's current identity (no mismatch on the next load).
    expect(added?.id).toBeDefined();
    expect(added?.id).not.toBe("s");
    expect(replicaKey(added)).not.toBe(before);
    expect(added).toMatchObject({
      label: "Notes",
      kind: "remote",
      baseUrl: "https://notes.example/g/alpha",
      token: "nk_old",
      graphInstanceId: "new-instance",
    });
    expect(activeGraph()?.id).toBe(added?.id);
    expect(listGraphs().map((g) => g.id)).toEqual(["other", "s", added?.id]);

    // Opening the copy: no sync target (B-633), and it can never be given an address again.
    setActiveGraphId("s");
    expect(hasSyncTarget()).toBe(false);
    expect(canPromoteGraph(copy)).toBe(false);
    expect(canPromoteGraph({ id: "other", label: "Elsewhere", kind: "local" })).toBe(true);
    expect(() =>
      updateGraph("s", { baseUrl: "https://x.example/g/new", kind: "remote" }),
    ).toThrow();
    expect(activeGraph()?.baseUrl).toBeUndefined();
    updateGraph("s", { label: "Renamed" });
    expect(activeGraph()?.label).toBe("Renamed");
  });

  it("a legacy (un-namespaced) replica stays legacy; without the server graph the copy is active", () => {
    fakePlatform.name = "capacitor";
    addGraph({ ...server, baseUrl: "https://n.example/g/a", legacyReplica: true });
    setActiveGraphId("s");
    const { copy, server: added } = keepAsDeviceOnlyCopy("s", "new", { addServerGraph: false });
    expect(added).toBeUndefined();
    expect(copy.legacyReplica).toBe(true);
    expect(replicaKey(copy)).toBeUndefined();
    expect(activeGraph()?.id).toBe("s");
    expect(listGraphs()).toHaveLength(1);
  });

  it("names: a placeholder label uses the slug; a taken name is numbered", () => {
    addGraph({ id: "x", label: "default (old copy)", kind: "local" });
    addGraph({ id: "a", label: "This graph", kind: "local", baseUrl: "/g/default" });
    expect(keepAsDeviceOnlyCopy("a", "n", { addServerGraph: false }).copy.label).toBe(
      "default (old copy 2)",
    );
  });

  it("refuses an entry with no address, changing nothing", () => {
    addGraph({ id: "l", label: "L", kind: "local" });
    expect(() => keepAsDeviceOnlyCopy("l", "n", { addServerGraph: true })).toThrow();
    expect(listGraphs()).toEqual([{ id: "l", label: "L", kind: "local" }]);
  });

  it("initBootstrap asks no server for a local-only entry, so the copy is never 'mismatched'", async () => {
    // Web: the page is still under the server graph's `/g/<slug>`, which would answer.
    history.replaceState(null, "", "/g/alpha/journals");
    addGraph({ ...server, baseUrl: "/g/alpha", token: "nk_t", graphInstanceId: "old" });
    setActiveGraphId("s");
    keepAsDeviceOnlyCopy("s", "new", { addServerGraph: false });
    const fetchSpy = vi.fn(async () =>
      Response.json({ token: "nk_fresh", graphId: "new" }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const config = await initBootstrap();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(config.graphMismatch).toBeFalsy();
      expect(config.token).toBeNull();
      expect(activeGraph()?.token).toBeUndefined();
      expect(activeGraph()?.graphInstanceId).toBe("old");
    } finally {
      vi.unstubAllGlobals();
      history.replaceState(null, "", "/");
    }
  });
});
