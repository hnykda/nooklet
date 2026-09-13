/**
 * The rendered (non-editing) view of `{{embed [[Page]]}}` / `{{embed ((id))}}` (B-210): the
 * embedded page's blocks, or the embedded block and its subtree, as a READ-ONLY outline inside the
 * host block. A row clicks through to that block (Shift+click shelves it, as on an outliner row);
 * the source line above the outline opens the page it lives on. Editing happens where the blocks
 * live — an editable transclusion would need a second `BlockTree` with its own surface, and that
 * is a separate piece of work (docs/review/2026-09-12-exposure-audit.md §2 item 8).
 *
 * Loaded lazily by `tokens.tsx` behind its own Suspense, like `QueryFenceView`; the placeholder box
 * is the fallback while the chunk and the first read land.
 *
 * Termination, twice over:
 *  - depth: an embed rendered inside `MAX_REF_DEPTH` levels of embeds/refs shows a link instead of
 *    its content (the contract's "depth-limited to 2", shared with `((block refs))`);
 *  - cycles: `RenderCtx.embedPath` carries the blocks already being rendered; an embed whose tree
 *    contains one of them says so instead of rendering (`embedRows.ts#embedReachesPath`). Depth
 *    alone would terminate, but a page embedding itself would still paint itself inside itself.
 *
 * Clicks that are not on a row, a link or a toggle — the frame, the gap beside the source line —
 * fall through to the host block and put it in edit mode, which is the only way to reach the
 * `{{embed …}}` text of a block that is nothing but an embed.
 */

import { classifyBlockContent } from "@nooklet/core";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { type EmbedData, type EmbedTarget, useEmbed } from "../../data/embeds.js";
import { displayPageName, displayRefName } from "../../data/page-title.js";
import type { BlockTreeNode } from "../../data/types.js";
import { MARKER_GLYPH } from "../BlockRowView.js";
import { EMBED_ROW_CAP, embedReachesPath, visibleEmbedRows } from "./embedRows.js";
import { BlockContentView, MAX_REF_DEPTH, type RenderCtx } from "./tokens.js";
import "./embed.css";

type Props = { target: EmbedTarget; from: number; to: number; ctx: RenderCtx };

function halt(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}

function targetText(t: EmbedTarget): string {
  return t.kind === "page" ? `[[${displayRefName(t.name)}]]` : `((${t.id}))`;
}

/** A link to the embed's target itself, for the states that show no content. */
function TargetLink(props: { target: EmbedTarget; ctx: RenderCtx }): JSX.Element {
  const go = (e: MouseEvent): void => {
    halt(e);
    props.ctx.onNavigate?.(props.target);
  };
  return (
    <Show
      when={props.target.kind === "page" ? props.target : undefined}
      fallback={
        <button type="button" class="vr-embed-target" onClick={go}>
          {targetText(props.target)}
        </button>
      }
    >
      {(page) => (
        <a
          class="vr-embed-target vr-page-ref"
          href={`/page/${encodeURIComponent(page().name)}`}
          onClick={(e) => {
            if (props.ctx.onNavigate) go(e);
          }}
        >
          {targetText(page())}
        </a>
      )}
    </Show>
  );
}

function Frame(props: Props & { state?: string; children: JSX.Element }): JSX.Element {
  return (
    <div
      class={`vr-embed vr-embed-${props.target.kind}${props.state ? ` vr-embed-${props.state}` : ""}`}
      data-from={props.from}
      data-to={props.to}
    >
      {props.children}
    </div>
  );
}

export default function EmbedView(props: Props): JSX.Element {
  return (
    <Show
      when={(props.ctx.refDepth ?? 0) < MAX_REF_DEPTH}
      fallback={
        <Frame {...props} state="limit">
          <span class="vr-embed-note">Embed: </span>
          <TargetLink target={props.target} ctx={props.ctx} />
        </Frame>
      }
    >
      <LiveEmbed {...props} />
    </Show>
  );
}

function LiveEmbed(props: Props): JSX.Element {
  const data = useEmbed(() => props.target);
  // `.latest`, not `data()`: after the first read, a re-read (every write to the graph triggers
  // one) keeps showing the current tree instead of suspending back to the placeholder.
  const state = (): EmbedData | undefined => data.latest;

  const roots = createMemo((): readonly BlockTreeNode[] => {
    const s = state();
    if (s?.status === "page") return s.blocks;
    if (s?.status === "block") return [s.node];
    return [];
  });
  const cycle = createMemo(() => embedReachesPath(roots(), props.ctx.embedPath ?? []));

  return (
    <Show
      when={state()}
      fallback={
        <Frame {...props}>
          <span class="vr-embed-note">Embed: {targetText(props.target)}</span>
        </Frame>
      }
    >
      {(s) => (
        <Show
          when={(s().status === "page" || s().status === "block") && !cycle()}
          fallback={
            <Frame {...props} state={cycle() ? "cycle" : s().status}>
              <span class="vr-embed-note">
                {cycle()
                  ? "Not shown — this embed contains the block it is written in: "
                  : s().status === "missing"
                    ? props.target.kind === "page"
                      ? "Embedded page doesn't exist yet: "
                      : "Embedded block not found: "
                    : `Could not load embed (${(s() as { message?: string }).message ?? ""}): `}
              </span>
              <TargetLink target={props.target} ctx={props.ctx} />
            </Frame>
          }
        >
          <Frame {...props}>
            <EmbedOutline data={s() as Extract<EmbedData, { page: unknown }>} {...props} />
          </Frame>
        </Show>
      )}
    </Show>
  );
}

function EmbedOutline(props: Props & { data: Extract<EmbedData, { page: unknown }> }): JSX.Element {
  // View-local expand/collapse: flipping a toggle here never writes `collapsed` — the embed is a
  // read-only window, and the block's own page keeps the state its owner left it in.
  const [flipped, setFlipped] = createSignal<ReadonlySet<string>>(new Set());
  const byId = createMemo(() => {
    const map = new Map<string, BlockTreeNode>();
    const walk = (nodes: readonly BlockTreeNode[]): void => {
      for (const node of nodes) {
        map.set(node.id, node);
        walk(node.children);
      }
    };
    walk(props.data.status === "page" ? props.data.blocks : [props.data.node]);
    return map;
  });
  // A block embed's root is open whatever it says: embedding a block is asking to see what hangs
  // off it, and the owner's own embeds point at blocks folded away on their original day. A page
  // embed's top-level blocks keep their stored state, like the page does.
  const rootOpen = (): boolean => props.data.status === "block";
  const isOpen = (node: { id: string; collapsed: boolean }, isRoot: boolean): boolean =>
    (isRoot && rootOpen() ? true : !node.collapsed) !== flipped().has(node.id);
  const rows = createMemo(() =>
    visibleEmbedRows(
      props.data.status === "page" ? props.data.blocks : [props.data.node],
      isOpen,
      EMBED_ROW_CAP,
    ),
  );
  const toggle = (id: string): void => {
    setFlipped((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const pageName = (): string => props.data.page.name;
  const rootIds = createMemo(
    () =>
      new Set(
        props.data.status === "page" ? props.data.blocks.map((b) => b.id) : [props.data.node.id],
      ),
  );

  return (
    <>
      <div class="vr-embed-head">
        <a
          class="vr-embed-source"
          href={`/page/${encodeURIComponent(pageName())}`}
          onClick={(e) => {
            if (!props.ctx.onNavigate) return;
            halt(e);
            props.ctx.onNavigate({ kind: "page", name: pageName() });
          }}
        >
          {displayPageName(props.data.page)}
        </a>
      </div>
      <Show when={rows().ids.length > 0} fallback={<div class="vr-embed-note">Empty page.</div>}>
        <ul class="vr-embed-outline">
          <For each={rows().ids}>
            {(id) => (
              <EmbedRow
                id={id}
                pageId={props.data.page.id}
                node={() => byId().get(id)}
                depth={rows().depth.get(id) ?? 0}
                open={(() => {
                  const node = byId().get(id);
                  return node ? isOpen(node, rootIds().has(id)) : false;
                })()}
                onToggle={() => toggle(id)}
                ctx={props.ctx}
              />
            )}
          </For>
        </ul>
        <Show when={rows().hidden > 0}>
          <button
            type="button"
            class="vr-embed-more"
            onClick={(e) => {
              halt(e);
              props.ctx.onNavigate?.(
                props.data.status === "page"
                  ? { kind: "page", name: pageName() }
                  : { kind: "block", id: props.data.node.id },
              );
            }}
          >
            {rows().hidden === 1 ? "1 more block" : `${rows().hidden} more blocks`}
          </button>
        </Show>
      </Show>
    </>
  );
}

function EmbedRow(props: {
  /** The `<For>` key itself — a plain string, so nothing derived from it is re-evaluated when a
   * re-read replaces the node objects. */
  id: string;
  /** The page the embedded block lives on — not the host's (B-215). */
  pageId: string;
  node: () => BlockTreeNode | undefined;
  depth: number;
  open: boolean;
  onToggle: () => void;
  ctx: RenderCtx;
}): JSX.Element {
  // Memo on the string first: a re-read of the graph hands over new node objects with the same
  // text, and re-classifying (and re-rendering) every embedded row on every keystroke elsewhere is
  // the cost this avoids.
  const text = createMemo(() => props.node()?.content ?? "");
  const content = createMemo(() => classifyBlockContent(text()));
  const marker = () => props.node()?.marker ?? null;
  const priority = () => props.node()?.priority ?? null;
  const hasChildren = (): boolean => (props.node()?.children.length ?? 0) > 0;

  const go = (e: MouseEvent | KeyboardEvent): void => {
    // Before anything else: the host `.vr-block-view` treats a click as "edit me", and an embedded
    // row is a way to the embedded block, not into the block that embeds it.
    halt(e);
    if (e.shiftKey && props.ctx.onShelfOpen) {
      props.ctx.onShelfOpen({ kind: "block", id: props.id, pageId: props.pageId });
      return;
    }
    props.ctx.onNavigate?.({ kind: "block", id: props.id });
  };

  return (
    <li class="vr-embed-item" data-embed-block-id={props.id} style={{ "--depth": props.depth }}>
      {/* biome-ignore lint/a11y/useSemanticElements: a row navigates to its block but hosts rendered rich content (links, checkboxes, tables) that cannot live inside an <a> — same reasoning as the query fence's result rows. */}
      <div
        class="vr-embed-row"
        role="link"
        tabIndex={props.ctx.onNavigate ? 0 : undefined}
        onClick={go}
        onKeyDown={(e) => {
          if (e.key === "Enter") go(e);
        }}
      >
        <Show when={hasChildren()} fallback={<span class="vr-embed-bullet" aria-hidden="true" />}>
          <button
            type="button"
            class="vr-embed-toggle"
            aria-expanded={props.open}
            aria-label={props.open ? "Collapse in this embed" : "Expand in this embed"}
            onClick={(e) => {
              halt(e);
              props.onToggle();
            }}
            onKeyDown={(e) => {
              // Enter on the toggle is the toggle's own click, not the row's navigation.
              if (e.key === "Enter") e.stopPropagation();
            }}
          >
            <span
              class="vr-embed-bullet"
              classList={{ "vr-embed-bullet-collapsed": !props.open }}
            />
          </button>
        </Show>
        <Show when={marker()}>
          {(m) => (
            <span class={`vr-marker vr-marker-${m()}`} role="img" aria-label={`Task: ${m()}`}>
              {MARKER_GLYPH[m()] ?? "☐"}
            </span>
          )}
        </Show>
        <Show when={priority()}>
          {(p) => <span class={`vr-priority vr-priority-${p()}`}>{p()}</span>}
        </Show>
        <div class="vr-embed-content" dir="auto">
          <BlockContentView
            content={content()}
            ctx={{
              ...props.ctx,
              source: text(),
              refDepth: (props.ctx.refDepth ?? 0) + 1,
              // This row's own block joins the path, so an embed written inside it that would
              // render this row again is caught (`embedRows.ts#embedReachesPath`).
              embedPath: [...(props.ctx.embedPath ?? []), props.id],
            }}
          />
        </div>
      </div>
    </li>
  );
}
