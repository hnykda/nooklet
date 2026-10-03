/**
 * Where the client gets its own credentials, and which graph it talks to (ADR 025: a server hosts
 * N graphs under `/g/<id>/`, and this device holds a LIST of graphs — not one fixed server — even
 * though only one is ever "active"/rendered at a time; M5 is what builds the switcher UI on top of
 * this file's storage, this file is the data model alone).
 *
 * When the server serves this build (`packages/server/src/http/web-client.ts`), it injects
 * `window.__NOOKLET__` into the shell with a token minted for this process — but only for a
 * loopback caller, because over a LAN that would hand a write credential to anyone who loads the
 * page. When Vite serves it in development there is no injection, so the `VITE_*` env vars stand
 * in.
 *
 * Before this existed the client had no credential at all in a production build: `search`,
 * `page.backlinks`, `/sync/*` and `/ui/live` are all authenticated, so a served app rendered but
 * could never load references, search, or sync — and, because nothing surfaced the 401, it looked
 * like an permanent spinner rather than an error. `reason` exists so the diagnostics panel can say
 * *why* there is no token instead of just showing "disconnected".
 */

import { platform } from "../platform/index.js";

/**
 * One graph this device knows about. `id` is a LOCAL, device-generated id (not the server's own
 * routing slug in the `/g/<id>/` URL) — two entries could in principle point at graphs that happen
 * to share a slug on different hosts, so this device needs its own, independent identity for "the
 * thing shown as row 3 in the switcher."
 */
export interface GraphListEntry {
  id: string;
  label: string;
  /** Informational (M5's UI), not load-bearing here: whether this graph has a real server behind
   * it (`baseUrl` set) or is a bare local-only replica (no `baseUrl` — Capacitor only; web/desktop
   * always has a real origin behind it, see `samePathGraphPrefix()` below). */
  kind: "local" | "remote";
  /** Absolute (Capacitor pointed at a real server) or origin-relative (web/desktop, same origin —
   * e.g. `/g/default`) — always already includes the `/g/<slug>` prefix, so every existing
   * `${apiBaseUrl()}/api/v1/...`-shaped call site needs no change. Absent for a local-only entry. */
  baseUrl?: string;
  token?: string;
  /** The physical `graphInstanceId()` last seen for this entry (`../graph-identity.ts` on the
   * server) — mismatch detection, now per entry instead of one global key, since two entries can
   * legitimately hold different graphs. */
  graphInstanceId?: string;
  /** B-612: this entry's replica is the un-namespaced one (`/nooklet.sqlite3`, the checkpoint at
   * its old path, the unscoped journal scope), not `/nooklet-<id>.sqlite3`. Set on exactly one
   * entry ever: the one that adopted what a "Just this device" install wrote before local-only was
   * a list entry (`adoptLegacyReplica`). */
  legacyReplica?: true;
}

const GRAPHS_KEY = "nooklet.graphs";
const ACTIVE_GRAPH_KEY = "nooklet.activeGraphId";
/** Set once the un-namespaced replica has been given to a list entry, so it is adopted only once:
 * removing that entry later must not make a "fresh" local graph reappear with the old notes. */
const LEGACY_ADOPTED_KEY = "nooklet.legacyReplicaAdopted";

/**
 * The one name everything per-graph on this device is keyed by (ADR 025, B-611): the OPFS file and
 * writer lock (`db.worker.ts`), the B-247 journal (`db/unapplied-ops.ts`), the native checkpoint
 * (`db/capacitor-checkpoint.ts`), the journal draft copy (`journal-draft-store.ts`), the shelf.
 * `undefined` is the un-namespaced replica: the one a load with no active entry opens, and the one
 * a `legacyReplica` entry owns.
 */
export function replicaKey(entry: GraphListEntry | undefined): string | undefined {
  return entry && !entry.legacyReplica ? entry.id : undefined;
}

/** `replicaKey` as a non-empty string, for storage keys. `~` never collides with an entry id
 * (`newGraphEntryId`: a UUID or `graph-…`). */
export function replicaScope(key: string | undefined): string {
  return key ?? "~";
}

/**
 * B-611: state written before it was keyed by graph (the v1 journal, the one fixed checkpoint) can
 * only be given to a replica when exactly ONE replica could have written it. Otherwise it is
 * quarantined, never replayed: replaying it into the wrong graph is the leak this exists to stop.
 *
 * The candidates are every listed entry's replica, plus the un-namespaced one wherever a load could
 * have run with no entry: always under Capacitor ("Just this device" used to add none, B-612), and
 * on web/desktop only when the list is empty (there, `initBootstrap` adds an entry on the first
 * load that reaches a server, so a no-entry load means a first launch that never got one).
 * Returns the one candidate's scope (`replicaScope`), or `undefined` when it is ambiguous.
 */
export function soleLegacyStateOwner(): string | undefined {
  const graphs = readGraphs();
  const candidates = new Set(graphs.map((g) => replicaScope(replicaKey(g))));
  if (platform.name === "capacitor" || graphs.length === 0) candidates.add(replicaScope(undefined));
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function legacyAdopted(): boolean {
  try {
    return localStorage.getItem(LEGACY_ADOPTED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * B-612: gives the un-namespaced replica a list entry, once per device. Returns the entry, or
 * `undefined` when it was adopted before (the entry may have been removed since; it is not
 * resurrected). `ConnectView`'s "Just this device" (`chooseLocalOnly`) and the boot-time check for
 * an install stranded by B-612 (`main.tsx`) are the callers.
 */
export function adoptLegacyReplica(label = "This device"): GraphListEntry | undefined {
  if (legacyAdopted() || readGraphs().some((g) => g.legacyReplica)) return undefined;
  const entry: GraphListEntry = {
    id: newGraphEntryId(),
    label,
    kind: "local",
    legacyReplica: true,
  };
  addGraph(entry);
  try {
    localStorage.setItem(LEGACY_ADOPTED_KEY, "1");
  } catch {
    // Without the flag it could be adopted again after a removal; the entry itself is what matters.
  }
  return entry;
}

/**
 * B-612: "Just this device" from the set-up screen makes a real list entry and makes it active, so
 * the switcher can come back to it after a server graph is added. The first time on a device it
 * adopts the un-namespaced replica (the one this page load already opened with no entry, and the
 * one every pre-fix "Just this device" install wrote to), so nothing written there is stranded.
 * Returns whether the page must reload: only when the new entry's replica is not the open one.
 */
export function chooseLocalOnly(): { reload: boolean } {
  const adopted = adoptLegacyReplica();
  if (adopted) {
    setActiveGraphId(adopted.id);
    return { reload: false };
  }
  createLocalOnlyGraph("This device");
  return { reload: true };
}

/** A local-only entry has no server, so it needs no token and never shows the set-up screen. */
export function isLocalOnlyEntry(entry: GraphListEntry | undefined): boolean {
  return Boolean(entry && entry.kind === "local" && !entry.baseUrl);
}

function readGraphs(): GraphListEntry[] {
  try {
    const raw = localStorage.getItem(GRAPHS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as GraphListEntry[]) : [];
  } catch {
    return []; // private mode / storage disabled / corrupt JSON
  }
}

function writeGraphs(list: GraphListEntry[]): void {
  try {
    localStorage.setItem(GRAPHS_KEY, JSON.stringify(list));
  } catch {
    // Non-fatal: the list simply will not survive a reload.
  }
}

export function listGraphs(): GraphListEntry[] {
  return readGraphs();
}

export function activeGraphId(): string | undefined {
  try {
    return localStorage.getItem(ACTIVE_GRAPH_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setActiveGraphId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_GRAPH_KEY, id);
    else localStorage.removeItem(ACTIVE_GRAPH_KEY);
  } catch {
    // Non-fatal: falls back to "no active graph" next load.
  }
}

export function activeGraph(): GraphListEntry | undefined {
  const id = activeGraphId();
  return id ? readGraphs().find((g) => g.id === id) : undefined;
}

/** Adds a new entry, or replaces the existing one with the same `id` — the one write primitive
 * every other list mutation in this file goes through. */
export function addGraph(entry: GraphListEntry): void {
  writeGraphs([...readGraphs().filter((g) => g.id !== entry.id), entry]);
}

export function updateGraph(id: string, patch: Partial<Omit<GraphListEntry, "id">>): void {
  writeGraphs(readGraphs().map((g) => (g.id === id ? { ...g, ...patch } : g)));
}

export function removeGraph(id: string): void {
  writeGraphs(readGraphs().filter((g) => g.id !== id));
  if (activeGraphId() === id) setActiveGraphId(null);
}

/** `GraphMismatchView.tsx`, after the owner has discarded the stale local replica and confirmed
 * this device should now be a fresh copy of `graphId`: adopts it as the active entry's identity so
 * the next load doesn't flag the very state this screen just resolved as a mismatch again. */
export function rememberActiveGraphInstanceId(graphId: string): void {
  const entry = activeGraph();
  if (entry) updateGraph(entry.id, { graphInstanceId: graphId });
}

function newGraphEntryId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `graph-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * This page's own `/g/<slug>` prefix, when it is actually being served that way — the zero-config
 * fallback for a first launch with no graph list yet, extending pre-ADR-025's "empty string means
 * same origin" magic by one path segment. Never matches under Capacitor
 * (`capacitor://localhost/index.html` has no such prefix), so this needs no separate platform
 * check — it simply never fires there, exactly like the old bare-origin default never applied.
 *
 * Also `App.tsx`'s ONLY correct source for `<Router base>`: the router's base must match where
 * THIS PAGE was loaded from, never `apiBaseUrl()`/`activeGraph()?.baseUrl` — under Capacitor those
 * can be a different ORIGIN entirely (the remote graph's), which has nothing to do with where the
 * bundled static app itself is served from (`capacitor://localhost`, always base-less).
 */
const GRAPH_PATH_PREFIX_RE = /^\/g\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?=\/|$)/;

export function samePathGraphPrefix(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return GRAPH_PATH_PREFIX_RE.exec(location.pathname)?.[0];
}

/**
 * Strips a leading `/g/<slug>` (ADR 025) off a RAW pathname — `window.location.pathname`, or
 * anything else that isn't already router-relative — so app-relative parsing (`currentPageName`-
 * style helpers matching `/page/...`, `CommandLayer`'s `activeView` detection, ...) doesn't need
 * to duplicate this regex at every call site. A no-op on a path with no such prefix, so it's safe
 * to apply even where the caller doesn't know whether one is present.
 */
export function appRelativePathname(pathname: string): string {
  return pathname.replace(GRAPH_PATH_PREFIX_RE, "");
}

/**
 * B-586: where switching TO `entry` should actually navigate, not just reload in place. A plain
 * `location.reload()` only works when the new graph shares the page's current `/g/<slug>` prefix
 * (or there is no prefix at all, i.e. Capacitor) — reloading after switching to a DIFFERENT
 * same-origin slug leaves `location.pathname` (and so `samePathGraphPrefix()`/`<Router base>`, and
 * every `rawAnchorHref()` link generated afterward) stamped with the OLD graph's prefix forever,
 * while `apiBaseUrl()` quietly serves the new one — the next link click or bookmark then hits the
 * wrong graph for real, not just cosmetically. `entry.baseUrl` already carries the right prefix
 * (absolute for Capacitor, `/g/<slug>` for web/desktop — see `GraphListEntry` above); a local-only
 * entry (no `baseUrl`) has nothing to change, so this falls back to the current path unmodified.
 */
export function graphEntryUrl(entry: GraphListEntry, currentLocation: Location): string {
  const appPath = appRelativePathname(currentLocation.pathname);
  // Under Capacitor the app is the bundle at the shell's own origin, whatever graph is active: a
  // remote entry's `baseUrl` is the SERVER's address, and navigating the WebView there would leave
  // the app for that server's web client (Capacitor opens a non-allowlisted URL outside the
  // WebView). So the app-relative path is reloaded in place, and `apiBaseUrl()` does the rest.
  if (platform.name === "capacitor") {
    return `${appPath}${currentLocation.search}${currentLocation.hash}`;
  }
  const prefix = entry.baseUrl ?? samePathGraphPrefix() ?? "";
  return `${prefix}${appPath}${currentLocation.search}${currentLocation.hash}`;
}

/**
 * Where a device token is kept when the server did not inject one — i.e. any client that is not
 * on loopback: a phone, a laptop, anything reaching a self-hosted server over a LAN, a tailnet or
 * the internet. Applied to the CURRENTLY ACTIVE graph entry (or, on web/desktop with no entry
 * chosen yet, synthesizes one from this page's own `/g/<slug>` origin) — see `ConnectView.tsx`'s
 * `connect()`, the only caller. Not exported as a raw setter any more: which entry a token belongs
 * to matters now that there can be more than one, so callers go through this rather than a bare
 * `localStorage` key.
 */
export function setConnectedGraphToken(
  remoteBaseUrl: string | null,
  token: string,
  serverLabel?: string,
): void {
  if (remoteBaseUrl === null) {
    // Web/desktop path (`ConnectView.tsx`'s `showServerField` is false): apply the token to
    // whatever graph this page is already serving from.
    const entry = activeGraph();
    if (entry) {
      updateGraph(entry.id, { token, ...labelPatch(entry.label, serverLabel) });
      return;
    }
    const id = newGraphEntryId();
    addGraph({
      id,
      label: serverLabel ?? "This graph",
      kind: "local",
      baseUrl: samePathGraphPrefix(),
      token,
    });
    setActiveGraphId(id);
    return;
  }
  // `remoteBaseUrl` is the full address the owner typed in (Capacitor's connect screen, or the
  // switcher's "Add a graph" anywhere). B-618: matched by the graph it RESOLVES to, not the string
  // — the same-origin entry is stored as `/g/default` and the typed address is absolute, so an
  // exact compare added the graph this page is already showing a second time, with its own empty
  // replica. The existing entry keeps its own `baseUrl` form (same-origin stays relative).
  const existing = findGraphByAddress(remoteBaseUrl);
  const id = existing?.id ?? newGraphEntryId();
  addGraph({
    id,
    label: existing
      ? (labelPatch(existing.label, serverLabel).label ?? existing.label)
      : (serverLabel ?? "Remote graph"),
    kind: existing?.kind ?? "remote",
    baseUrl: existing?.baseUrl ?? remoteBaseUrl,
    token,
    graphInstanceId: existing?.graphInstanceId,
  });
  setActiveGraphId(id);
}

/**
 * B-618: the labels this file hands out when it knows nothing better. Every graph used to be one
 * of these, so a switcher with two graphs read "This graph" and "Remote graph". A label still equal
 * to one of them was never chosen by anyone, and the server's own label may replace it; a label the
 * owner typed (rename) never is.
 */
const PLACEHOLDER_LABELS: ReadonlySet<string> = new Set(["This graph", "Remote graph"]);

export function isPlaceholderGraphLabel(label: string): boolean {
  return PLACEHOLDER_LABELS.has(label);
}

function labelPatch(current: string, serverLabel: string | undefined): { label?: string } {
  return serverLabel && isPlaceholderGraphLabel(current) ? { label: serverLabel } : {};
}

/** `baseUrl` as an absolute URL without a trailing slash — same-origin entries (`/g/default`)
 * resolved against this page — so two spellings of one graph compare equal. */
export function resolvedGraphAddress(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  try {
    const origin = typeof location === "undefined" ? undefined : location.origin;
    return new URL(baseUrl, origin).toString().replace(/\/+$/, "");
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}

export function findGraphByAddress(baseUrl: string): GraphListEntry | undefined {
  const wanted = resolvedGraphAddress(baseUrl);
  return readGraphs().find((g) => g.baseUrl && resolvedGraphAddress(g.baseUrl) === wanted);
}

/**
 * ADR 025 move 1 — "new local-only graph": adds a genuinely bare entry (no `baseUrl` at all) and
 * makes it active. Meaningful only where "no server at all" is a real state to begin with —
 * Capacitor's B-563 "Just this device" — since web/desktop are always served BY some origin
 * (`hasSyncTarget()`'s own doc comment). `shell/GraphSwitcher.tsx` is the only caller, and only
 * offers this action under Capacitor.
 */
export function createLocalOnlyGraph(label: string): void {
  const id = newGraphEntryId();
  addGraph({ id, label, kind: "local" });
  setActiveGraphId(id);
}

export interface BootstrapConfig {
  /** Bearer token for this origin's API, or `null` when the server declined to issue one. */
  token: string | null;
  /** Why there is no token, when there isn't one. */
  reason?: string;
  /** Identity of the graph this server is serving (`server/src/graph-identity.ts`). */
  graphId?: string;
  /**
   * True when this device holds a replica of a DIFFERENT graph than the server is serving.
   *
   * The local replica lives in OPFS, keyed by origin — so pointing `127.0.0.1:6100` at another
   * data directory leaves the browser happily reusing the copy it already had. The symptom is
   * brutal to diagnose from the inside: the sidebar lists a thousand pages from the old graph
   * while search and backlinks answer from the new, empty one, and nothing anywhere says the two
   * halves disagree.
   */
  graphMismatch?: boolean;
  /**
   * The journal title format this graph was imported with, when it had one (ADR 018). A
   * suggestion for the initial value of the display setting, never an override of a choice the
   * reader has already made.
   */
  journalTitleFormat?: string;
  /**
   * B-608: the graph's task workflow (`now`/`todo`), imported from Logseq's `:preferred-workflow`
   * or inferred by the server from the graph's markers. A suggestion like `journalTitleFormat`.
   */
  taskWorkflow?: string;
}

interface InjectedWindow {
  __NOOKLET__?: {
    token?: string | null;
    reason?: string;
    graphId?: string;
    journalTitleFormat?: string;
  };
}

function injected(): { token?: string | null; reason?: string } | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as InjectedWindow).__NOOKLET__;
}

let cached: BootstrapConfig | undefined;

/**
 * Fetch this client's credentials from the server, then memoise them. Call once, before rendering
 * and before `initDb`.
 *
 * Why a fetch rather than reading the HTML: the service worker precaches `index.html` at BUILD
 * time, so from the second load onward the injected `window.__NOOKLET__` is whatever the build
 * contained — nothing. The app silently lost its token on every reload. The shell is static and
 * cacheable; a credential is neither.
 *
 * Falls back to whatever is available locally (a stored device token, the injected value, the dev
 * env var) when the request fails, so a genuinely offline launch still opens the local replica.
 *
 * B-564: `main.tsx` awaits this before anything renders, so a request that hangs rather than
 * fails fast would leave the app on a blank screen forever, not just this file's own fallback —
 * bounded for the same reason `sync/http-transport.ts`'s `SYNC_TIMEOUT_MS` and `api-client.ts`'s
 * `API_TIMEOUT_MS` are.
 *
 * ADR 025: also where a fresh device with no graph list yet gets one — on a successful response
 * with no active entry, this page's own graph (web/desktop: this origin's `/g/<slug>`; Capacitor:
 * never, since `apiBaseUrl()` has nothing to fetch until `ConnectView.tsx` sets one) is registered
 * and made active, the same zero-config experience the old bare-origin default gave for free.
 */
const SESSION_TIMEOUT_MS = 10_000;

export async function initBootstrap(): Promise<BootstrapConfig> {
  const base = apiBaseUrl();
  try {
    const res = await fetch(`${base}/api/session`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        token?: string | null;
        reason?: string;
        graphId?: string;
        journalTitleFormat?: string;
        taskWorkflow?: string;
      };
      const physicalGraphId = body.graphId;
      let entry = activeGraph();
      // A stored device token wins only when the server offers none: on loopback the server mints
      // a fresh token per process, and a token stored by an earlier run would be stale.
      const token = body.token ?? entry?.token ?? import.meta.env.VITE_NOOKLET_TOKEN ?? null;
      if (!entry && base) {
        // First launch with no list yet: adopt this page's own graph, exactly as the pre-ADR-025
        // bare-origin default did.
        const id = newGraphEntryId();
        entry = {
          id,
          label: "This graph",
          kind: platform.name === "capacitor" ? "remote" : "local",
          baseUrl: base,
          token: token ?? undefined,
          graphInstanceId: physicalGraphId,
        };
        addGraph(entry);
        setActiveGraphId(id);
      } else if (entry) {
        const patch: Partial<GraphListEntry> = {};
        if (token && token !== entry.token) patch.token = token;
        // A first run has nothing to compare against, so adopt whatever the server says. Only a
        // CHANGE from an already-known value is a mismatch.
        if (physicalGraphId && !entry.graphInstanceId) patch.graphInstanceId = physicalGraphId;
        if (Object.keys(patch).length > 0) updateGraph(entry.id, patch);
      }
      cached = {
        token,
        reason: token ? undefined : (body.reason ?? "no_token_available"),
        graphId: physicalGraphId,
        graphMismatch: Boolean(
          physicalGraphId && entry?.graphInstanceId && entry.graphInstanceId !== physicalGraphId,
        ),
        journalTitleFormat: body.journalTitleFormat,
        taskWorkflow: body.taskWorkflow,
      };
      return cached;
    }
  } catch {
    // Offline, or no server at this origin — fall through to local sources.
  }
  cached = undefined;
  return bootstrapConfig();
}

export function bootstrapConfig(): BootstrapConfig {
  if (cached) return cached;
  const w = injected();
  // The env var is the development path and a deliberate escape hatch: it lets a LAN/tailnet user
  // supply the token the server refused to inject.
  const envToken = import.meta.env.VITE_NOOKLET_TOKEN;
  // Injected first: on loopback the server mints a fresh token per process, so a token stored by
  // an earlier run would be stale. The active entry's token second, which is the path every
  // remote device takes.
  const token = w?.token ?? activeGraph()?.token ?? envToken ?? null;
  cached = {
    token,
    reason: token ? undefined : (w?.reason ?? "no_token_available"),
  };
  return cached;
}

export function authToken(): string | undefined {
  return bootstrapConfig().token ?? undefined;
}

/** The active graph's own base URL, falling through to this page's own `/g/<slug>` prefix (no
 * active entry chosen yet — the state `initBootstrap()` resolves on its very first call), then the
 * build-time dev env vars, then same-origin with no prefix at all (nothing configured anywhere,
 * e.g. Capacitor before `ConnectView.tsx` has ever run). */
export function apiBaseUrl(): string {
  const entry = activeGraph();
  return (
    (entry ? entry.baseUrl : undefined) ??
    samePathGraphPrefix() ??
    import.meta.env.VITE_API_BASE_URL ??
    import.meta.env.VITE_SYNC_BASE_URL ??
    ""
  );
}

/**
 * B-567: whether there is a real sync target at all, distinct from `apiBaseUrl()`'s own contract
 * of "empty string means same origin." On web/PWA/desktop, same-origin is always a real target —
 * the browser's own address bar already is the server, and a fresh device auto-registers it (see
 * `initBootstrap()`) the moment it's confirmed reachable. Under Capacitor, nothing is a real
 * target until an entry with a real `baseUrl` exists (B-563's "Just this device" adds none at
 * all). `main.tsx` uses this to decide whether to pass `initDb`'s `syncBaseUrl` at all —
 * `db/worker-api.ts#WorkerInitOptions.syncBaseUrl`'s own doc comment already says "omit to run
 * local-only", a contract nothing used to honor, which is why a device with nothing to reach paid
 * B-566's timeout on every single cold start rather than once.
 */
export function hasSyncTarget(): boolean {
  const entry = activeGraph();
  if (entry) return Boolean(entry.baseUrl);
  return platform.name !== "capacitor";
}

/** Test seam: reset the memoised config. */
export function resetBootstrapForTests(): void {
  cached = undefined;
}
