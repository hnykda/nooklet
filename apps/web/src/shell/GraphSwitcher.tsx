/**
 * ADR 025: the graph list, as a top-bar icon + anchored popover — the same shape
 * `CalendarButton.tsx`/`live/ConsentBadge.tsx` already use (a quick jump, not a destination, so no
 * full-screen modal). Placed next to `SyncIndicator`, since "which graph" and "is it synced" are
 * the same question asked two ways.
 *
 * The three legal moves the ADR settled on:
 *  1. New local-only graph — Capacitor only (`showLocalOption` below): a browser tab always has
 *     SOME origin behind it (`data/bootstrap.ts#hasSyncTarget`'s own doc comment), so "no server at
 *     all" is only ever a real choice under Capacitor.
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
 */
import DatabaseIcon from "lucide-solid/icons/database";
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
  type GraphListEntry,
  graphEntryUrl,
  listGraphs,
  removeGraph,
  setActiveGraphId,
  updateGraph,
} from "../data/bootstrap.js";
import { connectToGraph, createGraphOnServer, parseServerUrl } from "../data/connect-graph.js";
import { platform } from "../platform/index.js";
import "./graph-switcher.css";

type Mode = "list" | "add-choice" | "add-form" | "promote-form";

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

  // Only real on Capacitor — see this file's own header.
  const showLocalOption = platform.name === "capacitor";

  function refresh(): void {
    setGraphs(listGraphs());
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

  function openSwitcher(): void {
    refresh();
    setMode("list");
    setConfirmRemoveId(undefined);
    setRenamingId(undefined);
    setError(undefined);
    setOpen(true);
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && open()) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
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

  function addLocalOnly(): void {
    createLocalOnlyGraph("This device");
    goToActiveGraph();
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
    <div class="graph-switcher-wrap">
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
                          {entry.label}
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
                          aria-label={`Rename ${entry.label}`}
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
                            aria-label={`Add a server for ${entry.label}`}
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
                            aria-label={`Remove ${entry.label}`}
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
            <button
              type="button"
              class="graph-switcher-add"
              onClick={() => setMode(showLocalOption ? "add-choice" : "add-form")}
            >
              <Plus size={14} /> Add a graph
            </button>
          </Show>

          <Show when={mode() === "add-choice"}>
            <button type="button" class="graph-switcher-back" onClick={() => setMode("list")}>
              ‹ Back
            </button>
            <div class="graph-switcher-choice">
              <button type="button" class="graph-switcher-choice-option" onClick={addLocalOnly}>
                <Smartphone size={18} />
                <span>
                  <strong>Just this device</strong>
                  <p>A fresh, unsynced graph.</p>
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
                  placeholder="https://nooklet.example.com"
                  value={serverUrl()}
                  onInput={(e) => setServerUrl(e.currentTarget.value)}
                />
              </label>
              <label class="graph-switcher-field">
                <span>Device token</span>
                <input
                  type="password"
                  autocomplete="off"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  placeholder="nk_…"
                  value={token()}
                  onInput={(e) => setToken(e.currentTarget.value)}
                />
              </label>
              <Show when={error()}>
                <p class="graph-switcher-error" role="alert">
                  {error()}
                </p>
              </Show>
              <button type="submit" disabled={busy() || !serverUrl().trim() || !token().trim()}>
                {busy() ? "Checking…" : "Connect"}
              </button>
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
                  type="password"
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
