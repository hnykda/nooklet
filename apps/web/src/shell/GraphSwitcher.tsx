/**
 * ADR 025: the graph list, as a top-bar icon + anchored popover — the same shape
 * `CalendarButton.tsx`/`live/ConsentBadge.tsx` already use (a quick jump, not a destination, so no
 * full-screen modal). Placed next to `SyncIndicator`, since "which graph" and "is it synced" are
 * the same question asked two ways.
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
 */
import DatabaseIcon from "lucide-solid/icons/database";
import Laptop from "lucide-solid/icons/laptop";
import Pencil from "lucide-solid/icons/pencil";
import Plus from "lucide-solid/icons/plus";
import Server from "lucide-solid/icons/server";
import Smartphone from "lucide-solid/icons/smartphone";
import Trash2 from "lucide-solid/icons/trash-2";
import UploadCloud from "lucide-solid/icons/upload-cloud";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import {
  activeGraph,
  activeGraphId,
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
import {
  DESKTOP_ERROR_EVENT,
  type DesktopLocalGraph,
  desktopShell,
  localGraphAddress,
  onBundledServer,
  shellRequestUrl,
} from "../platform/desktop-shell.js";
import { platform } from "../platform/index.js";
import "./graph-switcher.css";

/** The desktop's This-Mac graph as a row title: its default graph is "This Mac" itself, the name
 * the launcher's picker uses for it. */
function macGraphName(g: DesktopLocalGraph): string {
  return g.id === "default" ? "This Mac" : g.label;
}

type Mode = "list" | "add-choice" | "add-form" | "promote-form";

/** A reasonable starting graph id from a label someone already typed, editable before submit —
 * not itself validated against the server's `isValidGraphId` (`packages/server/src/graphs/
 * paths.ts`), which runs the real check and reports a real error if this guess is not enough. */
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
  const [graphs, setGraphs] = createSignal<GraphListEntry[]>([]);
  const [renamingId, setRenamingId] = createSignal<string | undefined>();
  const [renameDraft, setRenameDraft] = createSignal("");
  const [confirmRemoveId, setConfirmRemoveId] = createSignal<string | undefined>();
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
    setConfirmRemoveId(undefined);
    setRenamingId(undefined);
    setError(undefined);
    setPendingNote(undefined);
    setBusy(false);
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
      if (open() && wrap && !wrap.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
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

  function doRemove(id: string): void {
    removeGraph(id);
    setConfirmRemoveId(undefined);
    refresh();
  }

  async function addServer(e: Event): Promise<void> {
    e.preventDefault();
    const tokenValue = token().trim();
    if (!tokenValue) return;
    const parsed = parseServerUrl(serverUrl());
    if ("error" in parsed) {
      setError(parsed.error);
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

  /** B-618: offer the graphs the server hosts, when the token in the form can list them. */
  async function showServerGraphs(): Promise<void> {
    const parsed = parseServerUrl(serverUrl());
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await listServerGraphs(parsed.url, token().trim());
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
    const rootToken = promoteRootToken().trim();
    const graphId = promoteGraphId().trim();
    if (!rootToken || !graphId) return;
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

  return (
    <div class="graph-switcher-wrap" ref={wrap}>
      <button
        type="button"
        class="app-icon-button"
        aria-label="Switch graph"
        title="Switch graph"
        aria-expanded={open()}
        aria-haspopup="dialog"
        onClick={() => (open() ? setOpen(false) : openSwitcher())}
      >
        <DatabaseIcon size={17} />
      </button>
      <Show when={open()}>
        <div class="graph-switcher-popover" role="dialog" aria-label="Switch graph">
          <Show when={mode() === "list"}>
            <ul class="graph-switcher-list">
              <For each={graphs()}>
                {(entry) => (
                  <li
                    class="graph-switcher-row"
                    classList={{ active: entry.id === activeGraphId() }}
                  >
                    <Show
                      when={renamingId() === entry.id}
                      fallback={
                        <button
                          type="button"
                          class="graph-switcher-name"
                          onClick={() => switchTo(entry.id)}
                        >
                          {entry.kind === "remote" ? (
                            <Server size={14} aria-hidden="true" />
                          ) : (
                            <Smartphone size={14} aria-hidden="true" />
                          )}
                          <span class="graph-switcher-name-text">
                            <span class="graph-switcher-label">{graphDisplayName(entry)}</span>
                            <Show when={graphAddressLine(entry)}>
                              {(line) => <span class="graph-switcher-address">{line()}</span>}
                            </Show>
                          </span>
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
                    <Show
                      when={confirmRemoveId() !== entry.id}
                      fallback={
                        <span class="graph-switcher-confirm">
                          <button type="button" onClick={() => doRemove(entry.id)}>
                            Remove
                          </button>
                          <button type="button" onClick={() => setConfirmRemoveId(undefined)}>
                            Cancel
                          </button>
                        </span>
                      }
                    >
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
                        {/* ADR 025 move 2: only a genuinely local-only entry (no baseUrl at all)
                            has anything to promote — one already server-backed is already synced. */}
                        <Show when={entry.kind === "local" && !entry.baseUrl}>
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
                        <Show when={entry.id !== activeGraphId()}>
                          <button
                            type="button"
                            class="graph-switcher-icon-action"
                            aria-label={`Remove ${graphDisplayName(entry)}`}
                            title="Remove from this device"
                            onClick={() => setConfirmRemoveId(entry.id)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </Show>
                      </span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
            <Show when={macGraphs().length > 0}>
              <p class="graph-switcher-group" id="graph-switcher-mac">
                On this Mac
              </p>
              <ul class="graph-switcher-list" aria-labelledby="graph-switcher-mac">
                <For each={macGraphs()}>
                  {(g) => (
                    <li class="graph-switcher-row">
                      <button
                        type="button"
                        class="graph-switcher-name"
                        disabled={busy()}
                        onClick={() => openMacGraph(g)}
                      >
                        <Laptop size={14} aria-hidden="true" />
                        <span class="graph-switcher-name-text">
                          <span class="graph-switcher-label">{macGraphName(g)}</span>
                          <span class="graph-switcher-address">on this Mac</span>
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
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
              <label class="graph-switcher-field">
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
              <button type="submit" disabled={busy() || !serverUrl().trim() || !token().trim()}>
                {busy() ? "Checking…" : "Connect"}
              </button>
              <button
                type="button"
                class="graph-switcher-link"
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
