/**
 * ADR 025: the graph list. Since B-709 it is the left sidebar's title, Logseq-style: the current
 * graph's name at the top of the sidebar (`./Sidebar.tsx`), and clicking it opens this menu. It
 * used to be a database icon in the top bar, which said nothing about WHICH graph was open and
 * added one more icon to a bar the owner wanted calmer.
 *
 * The menu is `position: fixed`, placed under the name when it opens (`placeUnder`): the sidebar
 * scrolls (`overflow-y: auto`), which would clip an absolutely positioned popover to its 15rem.
 * Rows are grouped by where the graph lives — this device (a phone's local-only replica), this Mac
 * (ADR 028's bundled server), a server — so the three kinds read apart before any address does.
 *
 * The three legal moves the ADR settled on:
 *  1. New local-only graph — Capacitor and the desktop app (`showLocalOption` below), never a plain
 *     browser tab: a tab always has SOME origin behind it (`data/bootstrap.ts#hasSyncTarget`'s own
 *     doc comment), so "no server at all" is not a real choice there. On the phone it is a replica
 *     with no server. On the desktop (B-643) it is a new graph on This Mac's bundled server, made
 *     by the shell (`platform/desktop-shell.ts#shellRequestUrl`, `main.rs#ShellRequest`): a replica
 *     inside the window's origin would belong to whichever server the window happens to show, and
 *     vanish with it (`docs/progress/desktop-local-graph.md` has the reasoning). The desktop's This-
 *     Mac graphs are also listed ("On this Mac") from any server the window is on.
 *  2. Add an existing remote graph — every platform: `data/connect-graph.ts#connectToGraph`, the
 *     exact verify-then-remember logic `ConnectView.tsx` already used, reused as-is.
 *  3. Promote a local-only graph to a new remote one — a per-row action on any `kind: "local"`
 *     entry (`data/connect-graph.ts#createGraphOnServer`): creates a genuinely empty graph with the
 *     server's ROOT token, then points this SAME entry at it (not a new one) — the device's own
 *     `pending_op` backlog drains to it on reload with no new sync-engine code needed, verified
 *     against `sync-client.test.ts`'s existing B-301 coverage before this was built.
 * Never a fourth: attaching local content to an EXISTING, already-populated different graph
 * (proposal 003's rejected merge) — neither move adds content to an entry that already resolves to
 * someone else's history; `connectToGraph` always ADDS a new list entry or matches by `baseUrl`,
 * and promote's target is created empty in the same call.
 *
 * B-618: rows are named by the server's own graph label (from `graph.overview`, which any graph
 * token can call), with the address under it, so two graphs on one server can be told apart. An
 * entry still on a placeholder label ("This graph"/"Remote graph", from before labels existed) is
 * relabelled the next time the switcher opens; a label the owner typed is never replaced.
 *
 * B-704: a server on ANOTHER origin cannot be added from a served page. The connect check is a
 * cross-origin request, and the server's CORS allowlist admits only the app shells' origins
 * (`capacitor://localhost`), so it fails as "Load failed". Inside the desktop shell the request is
 * handed to the shell instead (`add-server-graph`, as B-643's local-graph requests), which remembers
 * the server and restarts onto it, as its own Switch Server… → Add a server does; that server's own
 * page then asks for its token. In a plain browser tab the form says so and offers the server in a
 * new tab. Capacitor is unaffected: its origin is on every server's allowlist.
 */
import Check from "lucide-solid/icons/check";
import ChevronsUpDown from "lucide-solid/icons/chevrons-up-down";
import ExternalLink from "lucide-solid/icons/external-link";
import Laptop from "lucide-solid/icons/laptop";
import Pencil from "lucide-solid/icons/pencil";
import Plus from "lucide-solid/icons/plus";
import Server from "lucide-solid/icons/server";
import Smartphone from "lucide-solid/icons/smartphone";
import Trash2 from "lucide-solid/icons/trash-2";
import UploadCloud from "lucide-solid/icons/upload-cloud";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { confirmDialog } from "../app/confirm-dialog.js";
import {
  activeGraph,
  activeGraphId,
  canPromoteGraph,
  createLocalOnlyGraph,
  findGraphByAddress,
  type GraphListEntry,
  graphEntryUrl,
  isPlaceholderGraphLabel,
  listGraphs,
  newLocalGraphName,
  removeGraph,
  resolvedGraphAddress,
  setActiveGraphId,
  updateGraph,
} from "../data/bootstrap.js";
import {
  connectToGraph,
  createGraphOnServer,
  fetchGraphLabel,
  graphBaseUrl,
  graphSlugOf,
  listServerGraphs,
  parseServerUrl,
  type ServerGraph,
} from "../data/connect-graph.js";
import { forgetPendingCount, knownPendingCount } from "../data/pending-memo.js";
import { normalizeToken, tokenShapeProblem } from "../data/token-input.js";
import {
  DESKTOP_ERROR_EVENT,
  type DesktopLocalGraph,
  type DesktopShell,
  desktopShell,
  localGraphAddress,
  onBundledServer,
  shellRequestUrl,
} from "../platform/desktop-shell.js";
import { platform } from "../platform/index.js";
import { removalDialog } from "./graph-removal.js";
import "./graph-switcher.css";

/** The desktop's This-Mac graph as a row title: its default graph is "This Mac" itself, the name
 * the launcher's picker uses for it. */
function macGraphName(g: DesktopLocalGraph): string {
  return g.id === "default" ? "This Mac" : g.label;
}

type Mode = "list" | "add-choice" | "add-form" | "promote-form";

/** Where a graph lives, which is how the menu groups its rows (B-709): this device's own replica
 * with no server (Capacitor's local-only graphs), This Mac's bundled server (ADR 028, desktop only),
 * or any other server. */
export type GraphPlace = "device" | "mac" | "server";

export const GRAPH_PLACE_HEADING: Record<GraphPlace, string> = {
  device: "On this device",
  mac: "On this Mac",
  server: "On a server",
};

export function graphPlace(entry: GraphListEntry, shell: DesktopShell | null): GraphPlace {
  if (!entry.baseUrl) return "device";
  if (shell) {
    const address = resolvedGraphAddress(entry.baseUrl);
    try {
      if (address && new URL(address).origin === `http://127.0.0.1:${shell.port}`) return "mac";
    } catch {
      // Not an absolute address: not This Mac's either.
    }
  }
  return "server";
}

/** B-704: whether `url` is a server this page cannot verify from here, i.e. another origin. Never
 * true under Capacitor, whose `capacitor://localhost` every server's CORS allowlist admits. */
export function needsOwnOrigin(url: string, pageOrigin: string): boolean {
  if (platform.name === "capacitor") return false;
  try {
    return new URL(url).origin !== pageOrigin;
  } catch {
    return false;
  }
}

/** Where the fixed-position menu goes: under `anchor`, as wide as a phone drawer allows, and no
 * taller than the space left below it (it scrolls past that). */
export function placeUnder(
  anchor: { left: number; bottom: number },
  viewport: { width: number; height: number },
  margin = 8,
): { left: number; top: number; width: number; maxHeight: number } {
  const width = Math.min(288, viewport.width - 2 * margin);
  const left = Math.max(margin, Math.min(anchor.left, viewport.width - width - margin));
  const top = anchor.bottom + 4;
  return { left, top, width, maxHeight: Math.max(160, viewport.height - top - margin) };
}

/** What a row is called: the label, unless it is a placeholder nobody chose — then the graph's
 * slug says more (B-618). */
export function graphDisplayName(entry: GraphListEntry): string {
  if (!isPlaceholderGraphLabel(entry.label)) return entry.label;
  return graphSlugOf(entry.baseUrl) ?? entry.label;
}

/** The line under the name: where this graph lives. Same-origin entries show this page's host, so
 * the address reads the same however the entry happens to be stored. */
export function graphAddressLine(entry: GraphListEntry): string | undefined {
  const resolved = resolvedGraphAddress(entry.baseUrl);
  if (!resolved) return undefined;
  try {
    const url = new URL(resolved);
    return `${url.host}${url.pathname}`;
  } catch {
    return resolved;
  }
}

/** A reasonable starting graph id from a label someone already typed, editable before submit —
 * not itself validated against the server's `isValidGraphId` (`packages/server/src/graphs/
 * paths.ts`), which runs the real check and reports a real error if this guess is not enough. */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function GraphSwitcher(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [mode, setMode] = createSignal<Mode>("list");
  // Read at mount, not only on open: the sidebar's title is the active graph's name (B-709).
  const [graphs, setGraphs] = createSignal<GraphListEntry[]>(listGraphs());
  const [renamingId, setRenamingId] = createSignal<string | undefined>();
  const [renameDraft, setRenameDraft] = createSignal("");
  const [serverUrl, setServerUrl] = createSignal("");
  const [token, setToken] = createSignal("");
  const [error, setError] = createSignal<string | undefined>();
  const [busy, setBusy] = createSignal(false);
  const [promotingId, setPromotingId] = createSignal<string | undefined>();
  const [promoteServerUrl, setPromoteServerUrl] = createSignal("");
  const [promoteGraphId, setPromoteGraphId] = createSignal("");
  const [promoteRootToken, setPromoteRootToken] = createSignal("");
  const [serverGraphs, setServerGraphs] = createSignal<ServerGraph[] | undefined>();
  const [pickedNote, setPickedNote] = createSignal<string | undefined>();

  const [macGraphs, setMacGraphs] = createSignal<DesktopLocalGraph[]>([]);
  const [pendingNote, setPendingNote] = createSignal<string | undefined>();
  const [placement, setPlacement] = createSignal<ReturnType<typeof placeUnder> | undefined>();

  // Capacitor and the desktop app, never a plain browser tab — see this file's own header.
  const shell = desktopShell();
  const showLocalOption = platform.name === "capacitor" || shell !== null;

  /** This Mac's graphs that are not already a row above: on the bundled server's own page, the
   * ones this origin has opened are ordinary same-origin entries. */
  function unlistedMacGraphs(): DesktopLocalGraph[] {
    if (!shell) return [];
    return shell.localGraphs.filter((g) => !findGraphByAddress(localGraphAddress(shell, g.id)));
  }

  function refresh(): void {
    setGraphs(listGraphs());
    setMacGraphs(unlistedMacGraphs());
  }

  const activeEntry = createMemo(() => graphs().find((g) => g.id === activeGraphId()));
  /** The sidebar's title. With no entry yet (a first load before bootstrap adopts one), the page's
   * own place stands in: This Mac on the bundled server, else this server's host. */
  const titleText = (): string => {
    const entry = activeEntry();
    if (entry) return graphDisplayName(entry);
    if (shell && onBundledServer(shell)) return "This Mac";
    return typeof location === "undefined" ? "nooklet" : location.host || "nooklet";
  };
  const titlePlace = (): GraphPlace => {
    const entry = activeEntry();
    if (entry) return graphPlace(entry, shell);
    return shell && onBundledServer(shell) ? "mac" : "server";
  };
  /** Rows grouped by place, in a fixed order; empty groups are left out. */
  const grouped = createMemo(() =>
    (["device", "mac", "server"] as const)
      .map((place) => ({
        place,
        entries: graphs().filter((g) => graphPlace(g, shell) === place),
        mac: place === "mac" ? macGraphs() : [],
      }))
      .filter((group) => group.entries.length > 0 || group.mac.length > 0),
  );

  /** B-704: the add form's address is a server on another origin, which this page cannot reach. */
  const addTargetElsewhere = (): string | undefined => {
    const parsed = parseServerUrl(serverUrl());
    if ("error" in parsed) return undefined;
    const target = graphBaseUrl(parsed.url);
    return needsOwnOrigin(target, location.origin) ? target : undefined;
  };

  let trigger: HTMLButtonElement | undefined;
  function place(): void {
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPlacement(placeUnder(rect, { width: window.innerWidth, height: window.innerHeight }));
  }

  /** B-586: navigates to wherever the now-active entry actually lives, rather than blindly
   * reloading the current path — see `data/bootstrap.ts#graphEntryUrl`'s own doc comment for why a
   * bare reload silently strands the router/address bar on the PREVIOUS graph's `/g/<slug>` prefix
   * whenever the new one is same-origin but a different slug. `location.assign` still forces a real
   * reload even when the destination equals the current URL (the local-only/Capacitor case, where
   * there is no prefix to change), matching the old `location.reload()` behavior exactly there. */
  function goToActiveGraph(): void {
    const entry = activeGraph();
    if (!entry) {
      location.reload();
      return;
    }
    location.assign(graphEntryUrl(entry, location));
  }

  /** B-618: name placeholder-labelled entries after their server's graph. Best effort, once per
   * entry (a found label stops it being a placeholder), never blocking the list. */
  async function refreshPlaceholderLabels(): Promise<void> {
    const pending = listGraphs().filter(
      (g) => isPlaceholderGraphLabel(g.label) && g.baseUrl && g.token,
    );
    for (const entry of pending) {
      const label = await fetchGraphLabel(entry.baseUrl as string, entry.token as string);
      if (
        label &&
        isPlaceholderGraphLabel(listGraphs().find((g) => g.id === entry.id)?.label ?? "")
      ) {
        updateGraph(entry.id, { label });
        refresh();
      }
    }
  }

  function openSwitcher(): void {
    refresh();
    void refreshPlaceholderLabels();
    setMode("list");
    setRenamingId(undefined);
    setError(undefined);
    setPendingNote(undefined);
    setBusy(false);
    place();
    setOpen(true);
  }

  let wrap: HTMLDivElement | undefined;
  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && open()) setOpen(false);
    };
    // B-650: a tap or click outside closes it, as the "⋯" menu does (`./MoreMenu.tsx`). On a phone
    // there is no Escape, so the only way out was the button that opened it. `pointerdown`, so a
    // press on another top-bar control both closes this and works there.
    const onDown = (e: PointerEvent): void => {
      // The removal dialog (B-712) is rendered outside this component; working in it is not an
      // outside tap, so the menu is still there, updated, when it closes.
      const inDialog = (e.target as Element | null)?.closest?.(".confirm-dialog-overlay");
      if (open() && wrap && !inDialog && !wrap.contains(e.target as Node)) setOpen(false);
    };
    const onResize = (): void => {
      if (open()) place();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onResize);
    });
    if (!shell) return;
    // B-643: the shell could not do what was asked (`main.rs#report_to_page`).
    const onShellError = (e: Event): void => {
      const detail = (e as CustomEvent<unknown>).detail;
      setPendingNote(undefined);
      setBusy(false);
      setError(typeof detail === "string" && detail ? detail : "nooklet could not do that.");
    };
    window.addEventListener(DESKTOP_ERROR_EVENT, onShellError);
    onCleanup(() => window.removeEventListener(DESKTOP_ERROR_EVENT, onShellError));
  });

  function switchTo(id: string): void {
    if (id === activeGraphId()) {
      setOpen(false);
      return;
    }
    setActiveGraphId(id);
    // Same reload discipline as `ConnectView.tsx#connect`: the worker/sync transport are handed
    // their config once at startup, so restarting the page is the honest way onto a different one.
    goToActiveGraph();
  }

  function startRename(entry: GraphListEntry): void {
    setRenamingId(entry.id);
    setRenameDraft(entry.label);
  }

  function commitRename(id: string): void {
    const label = renameDraft().trim();
    if (label) updateGraph(id, { label });
    setRenamingId(undefined);
    refresh();
  }

  /** B-712: never one tap. What is lost, said plainly, and `delete` typed wherever data can be
   * lost (`./graph-removal.ts`). The in-app dialog, never `window.confirm` (B-491). */
  async function confirmRemove(entry: GraphListEntry): Promise<void> {
    const where = graphPlace(entry, shell);
    const address = resolvedGraphAddress(entry.baseUrl);
    let host: string | undefined;
    try {
      host = address ? new URL(address).host : undefined;
    } catch {
      host = undefined;
    }
    const ok = await confirmDialog(
      removalDialog({
        name: graphDisplayName(entry),
        place: where,
        host,
        pending: where === "device" ? undefined : knownPendingCount(entry),
      }),
    );
    if (!ok) return;
    removeGraph(entry.id);
    forgetPendingCount(entry.id);
    refresh();
  }

  async function addServer(e: Event): Promise<void> {
    e.preventDefault();
    const parsed = parseServerUrl(serverUrl());
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    // B-704: another origin cannot be verified from this page (see this file's header).
    const elsewhere = addTargetElsewhere();
    if (elsewhere) {
      if (shell) handServerToShell(elsewhere);
      // A browser tab: the form already says so and links the server instead of a Connect button.
      return;
    }
    // B-706: drop what was copied around the token (a sentence's `.`, backticks, a newline), show
    // what will be sent, and name a token of the wrong shape before the server can only say 401.
    const tokenValue = normalizeToken(token());
    if (!tokenValue) return;
    setToken(tokenValue);
    const problem = tokenShapeProblem(tokenValue, "device");
    if (problem) {
      setError(problem);
      return;
    }
    // B-618: the graph is already on this device — switch to it rather than adding it twice (each
    // entry has its own replica, so a duplicate is a second, separately-synced copy). Its token is
    // still verified and refreshed by `connectToGraph`, which matches the existing entry the same way.
    const existing = findGraphByAddress(graphBaseUrl(parsed.url));
    if (existing && existing.id === activeGraphId()) {
      setError(`${graphDisplayName(existing)} is already this graph.`);
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await connectToGraph(parsed.url, tokenValue);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    goToActiveGraph();
  }

  /** B-704: the desktop shell remembers the server and restarts onto it, exactly as its own Switch
   * Server… → Add a server does (`main.rs#ShellRequest::AddServerGraph`). No token travels: the
   * window then shows that server's own page, which asks for one (`ConnectView.tsx`). */
  function handServerToShell(url: string): void {
    setError(undefined);
    setBusy(true);
    setPendingNote(
      `Opening ${new URL(url).host}. nooklet restarts, then that server asks for its token…`,
    );
    location.assign(shellRequestUrl({ kind: "add-server-graph", url }));
  }

  /** B-618: offer the graphs the server hosts, when the token in the form can list them. */
  async function showServerGraphs(): Promise<void> {
    const parsed = parseServerUrl(serverUrl());
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    const rootToken = normalizeToken(token());
    setToken(rootToken);
    const problem = tokenShapeProblem(rootToken, "root"); // B-706
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await listServerGraphs(parsed.url, rootToken);
    setBusy(false);
    if (!result.ok) {
      setServerGraphs(undefined);
      setError(result.error);
      return;
    }
    setServerGraphs(result.graphs);
  }

  function pickServerGraph(g: ServerGraph): void {
    setServerUrl(g.url);
    setServerGraphs(undefined);
    // Whatever listed the graphs was the root token, which cannot open a graph itself.
    setToken("");
    setPickedNote(
      `Now paste a device token for ${g.label}: nooklet token create --graph ${g.id} --scope write --sync`,
    );
  }

  function addLocalOnly(): void {
    if (shell) {
      // B-643/B-644: a new graph on This Mac, named so it is unique among this list and This
      // Mac's own graphs. The shell makes it and restarts the app into it.
      const label = newLocalGraphName(shell.localGraphs.map((g) => g.label));
      setError(undefined);
      setBusy(true);
      setPendingNote(`Creating “${label}” on this Mac. nooklet restarts to open it…`);
      location.assign(shellRequestUrl({ kind: "new-local-graph", label }));
      return;
    }
    createLocalOnlyGraph();
    goToActiveGraph();
  }

  /** A This-Mac graph from the "On this Mac" group. On the bundled server's own page it is just
   * another graph on this origin (the address bar's graph is adopted at load, and the shell
   * remembers it for the next launch); from a remote server's page, the shell switches to This Mac,
   * which takes a restart. */
  function openMacGraph(g: DesktopLocalGraph): void {
    if (!shell) return;
    if (onBundledServer(shell)) {
      location.assign(`/g/${g.id}/`);
      return;
    }
    setBusy(true);
    setPendingNote(`Opening “${macGraphName(g)}”. nooklet restarts to open it…`);
    location.assign(shellRequestUrl({ kind: "open-local-graph", id: g.id }));
  }

  function startPromote(entry: GraphListEntry): void {
    setPromotingId(entry.id);
    setPromoteServerUrl("");
    setPromoteGraphId(slugify(entry.label) || "default");
    setPromoteRootToken("");
    setError(undefined);
    setMode("promote-form");
  }

  async function submitPromote(e: Event): Promise<void> {
    e.preventDefault();
    const id = promotingId();
    if (!id) return;
    // B-714: checked BEFORE the server graph is made — `updateGraph` refuses a detached copy only
    // after `createGraphOnServer` would already have created an empty graph on the server.
    const entry = listGraphs().find((g) => g.id === id);
    if (!entry || !canPromoteGraph(entry)) {
      setError("This graph cannot be given a server.");
      return;
    }
    const rootToken = normalizeToken(promoteRootToken());
    const graphId = promoteGraphId().trim();
    if (!rootToken || !graphId) return;
    setPromoteRootToken(rootToken);
    const problem = tokenShapeProblem(rootToken, "root"); // B-706
    if (problem) {
      setError(problem);
      return;
    }
    const parsed = parseServerUrl(promoteServerUrl());
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await createGraphOnServer(parsed.url, graphId, graphId, rootToken);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // The SAME entry, not a new one: this device's own local history (still sitting in full in
    // `pending_op`, since it has never had anywhere to push before) is what reconnects and drains
    // to the graph just created — see this file's header and `connect-graph.ts#createGraphOnServer`.
    updateGraph(id, { kind: "remote", baseUrl: result.baseUrl, token: result.token });
    setActiveGraphId(id);
    goToActiveGraph();
  }

  const placeIcon = (where: GraphPlace, size: number): JSX.Element =>
    where === "device" ? (
      <Smartphone size={size} aria-hidden="true" />
    ) : where === "mac" ? (
      <Laptop size={size} aria-hidden="true" />
    ) : (
      <Server size={size} aria-hidden="true" />
    );

  /** A row for a graph in this device's list: switch, rename, promote, remove. */
  const entryRow = (entry: GraphListEntry): JSX.Element => {
    const isActive = entry.id === activeGraphId();
    return (
      <li class="graph-switcher-row" classList={{ active: isActive }}>
        <Show
          when={renamingId() === entry.id}
          fallback={
            <button
              type="button"
              class="graph-switcher-name"
              aria-current={isActive ? "true" : undefined}
              onClick={() => switchTo(entry.id)}
            >
              <span class="graph-switcher-name-text">
                <span class="graph-switcher-label">{graphDisplayName(entry)}</span>
                <Show when={graphAddressLine(entry)}>
                  {(line) => <span class="graph-switcher-address">{line()}</span>}
                </Show>
              </span>
              <Show when={isActive}>
                <Check size={14} class="graph-switcher-current" aria-label="open now" />
              </Show>
            </button>
          }
        >
          <input
            class="graph-switcher-rename-input"
            value={renameDraft()}
            autofocus
            onInput={(e) => setRenameDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename(entry.id);
              if (e.key === "Escape") setRenamingId(undefined);
            }}
            onBlur={() => commitRename(entry.id)}
          />
        </Show>
        <span class="graph-switcher-row-actions">
          <button
            type="button"
            class="graph-switcher-icon-action"
            aria-label={`Rename ${graphDisplayName(entry)}`}
            title="Rename"
            onClick={() => startRename(entry)}
          >
            <Pencil size={13} />
          </button>
          {/* ADR 025 move 2: only a genuinely local-only entry (no baseUrl at all) has anything
                to promote — one already server-backed is already synced. B-714: a device-only copy
                of an earlier server graph holds only this device's unsynced tail, so promoting it
                would seed a server graph with a fragment; shown disabled, saying why. */}
          <Show
            when={canPromoteGraph(entry)}
            fallback={
              <Show when={entry.detachedFrom}>
                <button
                  type="button"
                  class="graph-switcher-icon-action"
                  disabled
                  aria-label={`Add a server for ${graphDisplayName(entry)} (not available: a device-only copy)`}
                  title="A device-only copy of an earlier server graph cannot be given a server: it holds only this device's unsynced changes, not the whole graph."
                >
                  <UploadCloud size={13} />
                </button>
              </Show>
            }
          >
            <button
              type="button"
              class="graph-switcher-icon-action"
              aria-label={`Add a server for ${graphDisplayName(entry)}`}
              title="Add a server for this graph"
              onClick={() => startPromote(entry)}
            >
              <UploadCloud size={13} />
            </button>
          </Show>
          <Show when={!isActive}>
            <button
              type="button"
              class="graph-switcher-icon-action"
              aria-label={`Remove ${graphDisplayName(entry)}`}
              title="Remove from this device"
              onClick={() => void confirmRemove(entry)}
            >
              <Trash2 size={13} />
            </button>
          </Show>
        </span>
      </li>
    );
  };

  /** A This-Mac graph this origin has no entry for (desktop only, B-643). */
  const macRow = (g: DesktopLocalGraph): JSX.Element => (
    <li class="graph-switcher-row">
      <button
        type="button"
        class="graph-switcher-name"
        disabled={busy()}
        onClick={() => openMacGraph(g)}
      >
        <span class="graph-switcher-name-text">
          <span class="graph-switcher-label">{macGraphName(g)}</span>
          <span class="graph-switcher-address">on this Mac</span>
        </span>
      </button>
    </li>
  );

  return (
    <div class="graph-switcher-wrap" ref={wrap}>
      {/* B-709: the sidebar's title. Its accessible name keeps "Switch graph" (what it does) after
          the visible name (what is open), so both a reader and a test find it by either. */}
      <button
        type="button"
        class="graph-switcher-title"
        ref={trigger}
        aria-label={`${titleText()}, switch graph`}
        title="Switch graph"
        aria-expanded={open()}
        aria-haspopup="dialog"
        onClick={() => (open() ? setOpen(false) : openSwitcher())}
      >
        <span class="graph-switcher-title-icon">{placeIcon(titlePlace(), 15)}</span>
        <span class="graph-switcher-title-text">{titleText()}</span>
        <ChevronsUpDown size={14} class="graph-switcher-title-chevron" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div
          class="graph-switcher-popover"
          role="dialog"
          aria-label="Switch graph"
          style={{
            left: `${placement()?.left ?? 8}px`,
            top: `${placement()?.top ?? 48}px`,
            width: `${placement()?.width ?? 288}px`,
            "max-height": `${placement()?.maxHeight ?? 480}px`,
          }}
        >
          <Show when={mode() === "list"}>
            <For each={grouped()}>
              {(group) => (
                <section class="graph-switcher-section" data-place={group.place}>
                  <p class="graph-switcher-group" id={`graph-switcher-${group.place}`}>
                    {placeIcon(group.place, 13)}
                    {GRAPH_PLACE_HEADING[group.place]}
                  </p>
                  <ul class="graph-switcher-list" aria-labelledby={`graph-switcher-${group.place}`}>
                    <For each={group.entries}>{entryRow}</For>
                    <For each={group.mac}>{macRow}</For>
                  </ul>
                </section>
              )}
            </For>
            <Show when={pendingNote()}>
              <p class="graph-switcher-hint" role="status">
                {pendingNote()}
              </p>
            </Show>
            <Show when={error()}>
              <p class="graph-switcher-error" role="alert">
                {error()}
              </p>
            </Show>
            <button
              type="button"
              class="graph-switcher-add"
              onClick={() => {
                setServerGraphs(undefined);
                setPickedNote(undefined);
                setError(undefined);
                setMode(showLocalOption ? "add-choice" : "add-form");
              }}
            >
              <Plus size={14} /> Add a graph
            </button>
          </Show>

          <Show when={mode() === "add-choice"}>
            <button type="button" class="graph-switcher-back" onClick={() => setMode("list")}>
              ‹ Back
            </button>
            <div class="graph-switcher-choice">
              <button
                type="button"
                class="graph-switcher-choice-option"
                disabled={busy()}
                onClick={addLocalOnly}
              >
                <Show when={shell} fallback={<Smartphone size={18} />}>
                  <Laptop size={18} />
                </Show>
                <span>
                  <strong>{shell ? "New graph on this Mac" : "Just this device"}</strong>
                  <p>
                    {shell
                      ? "Kept in nooklet's own folder on this Mac. Works offline."
                      : "A fresh, unsynced graph."}
                  </p>
                </span>
              </button>
              <button
                type="button"
                class="graph-switcher-choice-option"
                onClick={() => setMode("add-form")}
              >
                <Server size={18} />
                <span>
                  <strong>Sync with a server</strong>
                  <p>Connect to a nooklet server you already run.</p>
                </span>
              </button>
            </div>
            <Show when={pendingNote()}>
              <p class="graph-switcher-hint" role="status">
                {pendingNote()}
              </p>
            </Show>
            <Show when={error()}>
              <p class="graph-switcher-error" role="alert">
                {error()}
              </p>
            </Show>
          </Show>

          <Show when={mode() === "add-form"}>
            <button
              type="button"
              class="graph-switcher-back"
              onClick={() => setMode(showLocalOption ? "add-choice" : "list")}
            >
              ‹ Back
            </button>
            <form onSubmit={(e) => void addServer(e)}>
              <label class="graph-switcher-field">
                <span>Server address</span>
                <input
                  type="text"
                  inputmode="url"
                  autocomplete="off"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  placeholder="https://nooklet.example.com/g/work"
                  value={serverUrl()}
                  onInput={(e) => setServerUrl(e.currentTarget.value)}
                />
              </label>
              <p class="graph-switcher-hint">
                <code>/g/&lt;graph&gt;</code> at the end picks a graph; without it you get the
                server's default graph.
              </p>
              {/* B-704: a server on another origin asks for its token on its own page. */}
              <label class="graph-switcher-field" hidden={addTargetElsewhere() !== undefined}>
                <span>Device token</span>
                <input
                  type="text"
                  autocomplete="off"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  placeholder="nk_…"
                  value={token()}
                  onInput={(e) => setToken(e.currentTarget.value)}
                />
              </label>
              <Show when={pickedNote()}>
                <p class="graph-switcher-hint">{pickedNote()}</p>
              </Show>
              <Show when={error()}>
                <p class="graph-switcher-error" role="alert">
                  {error()}
                </p>
              </Show>
              <Show when={addTargetElsewhere()}>
                {(target) => (
                  <Show
                    when={shell}
                    fallback={
                      <div class="graph-switcher-elsewhere" role="note">
                        <p>
                          This page can only add graphs on {location.host}. A graph on{" "}
                          {new URL(target()).host} opens in its own tab, which asks for its device
                          token.
                        </p>
                        <a href={target()} target="_blank" rel="noopener noreferrer">
                          <ExternalLink size={14} aria-hidden="true" /> Open{" "}
                          {new URL(target()).host} in a new tab
                        </a>
                      </div>
                    }
                  >
                    <p class="graph-switcher-hint">
                      nooklet restarts onto this server; its page then asks for the device token.
                    </p>
                  </Show>
                )}
              </Show>
              <Show when={mode() === "add-form" && pendingNote()}>
                <p class="graph-switcher-hint" role="status">
                  {pendingNote()}
                </p>
              </Show>
              <Show when={!addTargetElsewhere() || shell}>
                <button
                  type="submit"
                  disabled={
                    busy() || !serverUrl().trim() || (!addTargetElsewhere() && !token().trim())
                  }
                >
                  {addTargetElsewhere()
                    ? busy()
                      ? "Restarting…"
                      : "Add and restart"
                    : busy()
                      ? "Checking…"
                      : "Connect"}
                </button>
              </Show>
              <button
                type="button"
                class="graph-switcher-link"
                hidden={addTargetElsewhere() !== undefined}
                disabled={busy() || !serverUrl().trim() || !token().trim()}
                onClick={() => void showServerGraphs()}
              >
                Show graphs on this server (root token)
              </button>
              <Show when={serverGraphs()}>
                {(list) => (
                  <ul class="graph-switcher-server-graphs" aria-label="Graphs on this server">
                    <Show when={list().length === 0}>
                      <li class="graph-switcher-hint">This server hosts no graphs yet.</li>
                    </Show>
                    <For each={list()}>
                      {(g) => (
                        <li>
                          <button type="button" onClick={() => pickServerGraph(g)}>
                            <span class="graph-switcher-label">{g.label}</span>
                            <span class="graph-switcher-address">
                              /g/{g.id}
                              {findGraphByAddress(g.url) ? " · already on this device" : ""}
                            </span>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                )}
              </Show>
            </form>
          </Show>

          <Show when={mode() === "promote-form"}>
            <button type="button" class="graph-switcher-back" onClick={() => setMode("list")}>
              ‹ Back
            </button>
            <p class="graph-switcher-promote-lede">
              Creates a new, empty graph on a server you run, then sends everything on this device
              to it. Needs the server's ROOT token — run <code>nooklet token root</code> on the
              machine running it — not a graph token, which can't create graphs.
            </p>
            <form onSubmit={(e) => void submitPromote(e)}>
              <label class="graph-switcher-field">
                <span>Server address</span>
                <input
                  type="text"
                  inputmode="url"
                  autocomplete="off"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  placeholder="https://nooklet.example.com"
                  value={promoteServerUrl()}
                  onInput={(e) => setPromoteServerUrl(e.currentTarget.value)}
                />
              </label>
              <label class="graph-switcher-field">
                <span>New graph id</span>
                <input
                  type="text"
                  autocomplete="off"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  placeholder="default"
                  value={promoteGraphId()}
                  onInput={(e) => setPromoteGraphId(e.currentTarget.value)}
                />
              </label>
              <label class="graph-switcher-field">
                <span>Root token</span>
                <input
                  type="text"
                  autocomplete="off"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  placeholder="nkroot_…"
                  value={promoteRootToken()}
                  onInput={(e) => setPromoteRootToken(e.currentTarget.value)}
                />
              </label>
              <Show when={error()}>
                <p class="graph-switcher-error" role="alert">
                  {error()}
                </p>
              </Show>
              <button
                type="submit"
                disabled={
                  busy() ||
                  !promoteServerUrl().trim() ||
                  !promoteGraphId().trim() ||
                  !promoteRootToken().trim()
                }
              >
                {busy() ? "Creating…" : "Add server"}
              </button>
            </form>
          </Show>
        </div>
      </Show>
    </div>
  );
}
