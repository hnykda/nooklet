/**
 * The graph menu in the desktop app (proposal 005, ADR 032): the left sidebar's title, as on every
 * platform (B-709), but its rows are the SHELL's list — This Mac's graphs and the server graphs this
 * Mac knows, from `__NOOKLET_DESKTOP__.graphs` — not the list this origin keeps in its own storage.
 * One list for the whole app, the same from every graph's page (B-781).
 *
 * Two groups, in words a person would use: **On this Mac** and **On servers** (one sub-list per
 * server, headed by its host). No phone words: no "device", no "Just this device", no promote
 * (B-783).
 *
 * - Picking a graph navigates the window to its address; the shell routes it (a This-Mac graph
 *   opens in this window, a server graph in a new one that carries its token). No restart (B-785).
 * - Rename and remove are shell requests; the shell answers with the list as it now is. A server
 *   graph is removed (forgotten; the server keeps it), never the one open.
 * - A graph on This Mac is DELETED (B-786): its folder is the graph, so the B-712 dialog asks for
 *   `delete` typed, and the shell retires it on its server and moves the folder to the Trash. Not
 *   offered for the open graph, `default` (This Mac's main graph) or the last one, and only on the
 *   bundled server's own page — the shell refuses all of those itself too (`main.rs`).
 * - "Add a graph" is `DesktopAddGraph`.
 * - The native menu's Graphs… opens this (`graph-menu-request.ts`).
 */
import Check from "lucide-solid/icons/check";
import ChevronsUpDown from "lucide-solid/icons/chevrons-up-down";
import Laptop from "lucide-solid/icons/laptop";
import Pencil from "lucide-solid/icons/pencil";
import Plus from "lucide-solid/icons/plus";
import Server from "lucide-solid/icons/server";
import Trash2 from "lucide-solid/icons/trash-2";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { confirmDialog } from "../app/confirm-dialog.js";
import {
  currentDesktopGraph,
  type DesktopGraph,
  type DesktopShell,
  onBundledServer,
  shellRequest,
} from "../platform/desktop-shell.js";
import { DesktopAddGraph } from "./DesktopAddGraph.js";
import {
  canDeleteMacGraph,
  groupDesktopGraphs,
  hostOf,
  serverGraphPath,
} from "./desktop-graphs.js";
import { graphMenuRequests, takeGraphMenuRequest } from "./graph-menu-request.js";
import { macDeletionDialog } from "./graph-removal.js";
import { placeUnder } from "./place-under.js";
import "./graph-switcher.css";
import "./desktop-graphs.css";

export function DesktopGraphMenu(props: { shell: DesktopShell }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  const [graphs, setGraphs] = createSignal<DesktopGraph[]>(props.shell.graphs);
  const [renaming, setRenaming] = createSignal<string | undefined>();
  const [renameDraft, setRenameDraft] = createSignal("");
  const [error, setError] = createSignal<string | undefined>();
  const [notice, setNotice] = createSignal<string | undefined>();
  const [placement, setPlacement] = createSignal<ReturnType<typeof placeUnder> | undefined>();

  const current = createMemo(() => currentDesktopGraph(graphs()));
  const grouped = createMemo(() => groupDesktopGraphs(graphs()));
  const titleText = (): string =>
    current()?.label ?? (onBundledServer(props.shell) ? "This Mac" : location.host || "nooklet");
  const titleOnMac = (): boolean =>
    current() ? current()?.place === "mac" : onBundledServer(props.shell);

  let trigger: HTMLButtonElement | undefined;
  let wrap: HTMLDivElement | undefined;

  function place(): void {
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPlacement(placeUnder(rect, { width: window.innerWidth, height: window.innerHeight }));
  }

  function openMenu(): void {
    setAdding(false);
    setRenaming(undefined);
    setError(undefined);
    setNotice(undefined);
    place();
    setOpen(true);
  }

  // Graphs… in the native menu (`graph-menu-request.ts`), whether it came before this mounted.
  createEffect(() => {
    graphMenuRequests();
    if (takeGraphMenuRequest()) openMenu();
  });

  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && open()) setOpen(false);
    };
    const onDown = (e: PointerEvent): void => {
      // The removal dialog is rendered outside this component; working in it is not an outside tap.
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
  });

  function pick(graph: DesktopGraph): void {
    if (graph.key === current()?.key) {
      setOpen(false);
      return;
    }
    // The shell routes this navigation (`main.rs#on_navigation`).
    location.assign(graph.address);
  }

  async function commitRename(graph: DesktopGraph): Promise<void> {
    // Enter, then the blur of the input it unmounts: commit once.
    if (renaming() !== graph.key) return;
    const label = renameDraft().trim();
    setRenaming(undefined);
    if (!label || label === graph.label) return;
    const reply = await shellRequest(props.shell, { kind: "rename", graph: graph.key, label });
    if (reply.graphs) setGraphs(reply.graphs);
    if (!reply.ok) setError(reply.error ?? "nooklet could not rename that graph.");
  }

  async function remove(graph: DesktopGraph): Promise<void> {
    const ok = await confirmDialog({
      title: `Remove ${graph.label} from this Mac?`,
      message: [
        `The server at ${hostOf(graph.address)} keeps the graph; nothing is deleted there, and other devices are not affected.`,
        "This Mac forgets its address and its token. To open it again, add it with a token.",
        "Changes made here that have not synced yet stay on this Mac, and are sent if you add the graph again.",
      ],
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    const reply = await shellRequest(props.shell, { kind: "remove", graph: graph.key });
    if (reply.graphs) setGraphs(reply.graphs);
    if (!reply.ok) setError(reply.error ?? "nooklet could not remove that graph.");
  }

  async function deleteMac(graph: DesktopGraph): Promise<void> {
    if (!(await confirmDialog(macDeletionDialog({ name: graph.label, id: graph.id })))) return;
    setError(undefined);
    setNotice(undefined);
    const reply = await shellRequest(props.shell, { kind: "delete-mac-graph", graph: graph.key });
    if (reply.graphs) setGraphs(reply.graphs);
    if (reply.ok) setNotice(`“${graph.label}” is in the Trash.`);
    else setError(reply.error ?? "nooklet could not delete that graph.");
  }

  const deletable = (graph: DesktopGraph): boolean =>
    canDeleteMacGraph(graph, {
      shellCanDelete: props.shell.deleteMac,
      onBundledServer: onBundledServer(props.shell),
      currentKey: current()?.key,
      macCount: grouped().mac.length,
    });

  const row = (graph: DesktopGraph, under: string): JSX.Element => {
    const isCurrent = (): boolean => graph.key === current()?.key;
    return (
      <li class="graph-switcher-row" classList={{ active: isCurrent() }}>
        <Show
          when={renaming() === graph.key}
          fallback={
            <button
              type="button"
              class="graph-switcher-name"
              aria-current={isCurrent() ? "true" : undefined}
              onClick={() => pick(graph)}
            >
              <span class="graph-switcher-name-text">
                <span class="graph-switcher-label">{graph.label}</span>
                <span class="graph-switcher-address">{under}</span>
              </span>
              <Show when={isCurrent()}>
                <Check size={14} class="graph-switcher-current" aria-label="open now" />
              </Show>
            </button>
          }
        >
          <input
            class="graph-switcher-rename-input"
            aria-label={`New name for ${graph.label}`}
            value={renameDraft()}
            autofocus
            onInput={(e) => setRenameDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename(graph);
              if (e.key === "Escape") setRenaming(undefined);
            }}
            onBlur={() => void commitRename(graph)}
          />
        </Show>
        <span class="graph-switcher-row-actions">
          <button
            type="button"
            class="graph-switcher-icon-action"
            aria-label={`Rename ${graph.label}`}
            title="Rename"
            onClick={() => {
              setRenameDraft(graph.label);
              setRenaming(graph.key);
            }}
          >
            <Pencil size={13} />
          </button>
          <Show when={graph.place === "server" && !isCurrent()}>
            <button
              type="button"
              class="graph-switcher-icon-action"
              aria-label={`Remove ${graph.label}`}
              title="Remove from this Mac"
              onClick={() => void remove(graph)}
            >
              <Trash2 size={13} />
            </button>
          </Show>
          <Show when={deletable(graph)}>
            <button
              type="button"
              class="graph-switcher-icon-action"
              aria-label={`Delete ${graph.label}`}
              title="Delete from this Mac (moves it to the Trash)"
              onClick={() => void deleteMac(graph)}
            >
              <Trash2 size={13} />
            </button>
          </Show>
        </span>
      </li>
    );
  };

  return (
    <div class="graph-switcher-wrap" ref={wrap}>
      <button
        type="button"
        class="graph-switcher-title"
        ref={trigger}
        aria-label={`${titleText()}, switch graph`}
        title="Switch graph"
        aria-expanded={open()}
        aria-haspopup="dialog"
        onClick={() => (open() ? setOpen(false) : openMenu())}
      >
        <span class="graph-switcher-title-icon">
          <Show when={titleOnMac()} fallback={<Server size={15} aria-hidden="true" />}>
            <Laptop size={15} aria-hidden="true" />
          </Show>
        </span>
        <span class="graph-switcher-title-text">{titleText()}</span>
        <ChevronsUpDown size={14} class="graph-switcher-title-chevron" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div
          class="graph-switcher-popover"
          role="dialog"
          aria-label="Graphs"
          style={{
            left: `${placement()?.left ?? 8}px`,
            top: `${placement()?.top ?? 48}px`,
            width: `${placement()?.width ?? 288}px`,
            "max-height": `${placement()?.maxHeight ?? 480}px`,
          }}
        >
          <Show
            when={!adding()}
            fallback={
              <>
                <button type="button" class="graph-switcher-back" onClick={() => setAdding(false)}>
                  ‹ Back
                </button>
                <DesktopAddGraph shell={props.shell} />
              </>
            }
          >
            <Show when={grouped().mac.length > 0}>
              <section class="graph-switcher-section" data-place="mac">
                <p class="graph-switcher-group" id="desktop-graphs-mac">
                  <Laptop size={13} aria-hidden="true" />
                  On this Mac
                </p>
                <ul class="graph-switcher-list" aria-labelledby="desktop-graphs-mac">
                  <For each={grouped().mac}>{(g) => row(g, "on this Mac")}</For>
                </ul>
              </section>
            </Show>
            <Show when={grouped().servers.length > 0}>
              <section class="graph-switcher-section" data-place="server">
                <p class="graph-switcher-group" id="desktop-graphs-servers">
                  <Server size={13} aria-hidden="true" />
                  On servers
                </p>
                <For each={grouped().servers}>
                  {(group) => (
                    <>
                      <p class="desktop-graph-host">{group.host}</p>
                      <ul class="graph-switcher-list" aria-label={`On servers: ${group.host}`}>
                        <For each={group.graphs}>{(g) => row(g, serverGraphPath(g.address))}</For>
                      </ul>
                    </>
                  )}
                </For>
              </section>
            </Show>
            <Show when={error()}>
              <p class="graph-switcher-error" role="alert">
                {error()}
              </p>
            </Show>
            <Show when={notice()}>
              <p class="graph-switcher-hint" role="status">
                {notice()}
              </p>
            </Show>
            <button
              type="button"
              class="graph-switcher-add"
              onClick={() => {
                setError(undefined);
                setNotice(undefined);
                setAdding(true);
              }}
            >
              <Plus size={14} /> Add a graph
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
