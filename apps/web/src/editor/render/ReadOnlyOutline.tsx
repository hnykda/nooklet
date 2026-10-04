/**
 * Blocks rendered as the outliner renders them — marker, priority, content through
 * `BlockContentView`, property chips, date chips, children nested under a bullet that folds — but
 * READ-ONLY: a row clicks through to its block, and nothing here writes. Built for `{{embed}}`
 * (`./EmbedView.tsx`, B-210) and shared with the references panel (`../../views/ReferenceItem.tsx`,
 * B-550), which is why it lives apart from both: one read-only subtree renderer, not two that drift.
 *
 * Expand/collapse is view-local: a toggle flips a node against its stored `collapsed` in this view
 * only. An embed or a reference is a window onto blocks that live elsewhere, and the page they live
 * on keeps the state its owner left it in.
 *
 * Rows are keyed by id (`./embedRows.ts` says why): a re-read of the graph hands over new node
 * objects, and keying by object would rebuild every row — and forget every local toggle — on every
 * edit anywhere.
 */

import { classifyBlockContent, formatDayTime } from "@nooklet/core";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { BlockTreeNode } from "../../data/types.js";
import { BlockProperties } from "../BlockProperties.js";
import { DateChips } from "../DateChips.js";
import { deriveNumbering, isNumbered } from "../numbering.js";
import { TaskMarkerIcon } from "../TaskMarkerIcon.js";
import { EMBED_ROW_CAP, visibleEmbedRows } from "./embedRows.js";
import { BlockContentView, type RenderCtx } from "./tokens.js";
import "./embed.css";

export function halt(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}

export function ReadOnlyOutline(props: {
  roots: readonly BlockTreeNode[];
  /** The roots show their children whatever their stored `collapsed` says. A block embed wants
   * this (embedding a block is asking to see what hangs off it); a reference does not — it shows
   * the block as its page does. Deeper nodes always start from their stored state. */
  rootsOpen?: boolean;
  /** Rows rendered at most; past it a "N more blocks" button calls `onMore`. */
  cap?: number;
  /** Ordinals of numbered roots (`list:: number`, OUT-17). A root's number depends on its siblings
   * on its page, which this view does not hold, so the caller that read the page supplies it
   * (B-551); children are numbered here from the tree itself. */
  rootOrdinals?: ReadonlyMap<string, number>;
  ctx: RenderCtx;
  onMore: () => void;
}): JSX.Element {
  const [flipped, setFlipped] = createSignal<ReadonlySet<string>>(new Set());
  const byId = createMemo(() => {
    const map = new Map<string, BlockTreeNode>();
    const walk = (nodes: readonly BlockTreeNode[]): void => {
      for (const node of nodes) {
        map.set(node.id, node);
        walk(node.children);
      }
    };
    walk(props.roots);
    return map;
  });
  const rootIds = createMemo(() => new Set(props.roots.map((b) => b.id)));
  // Numbered-list ordinals, the outline's own rule (`../numbering.ts`): per sibling group, so every
  // group of children is complete here; roots come from the caller (B-551).
  const ordinals = createMemo(() => {
    const out = new Map<string, number>(props.rootOrdinals ?? []);
    const walk = (nodes: readonly BlockTreeNode[]): void => {
      for (const node of nodes) {
        if (node.children.length === 0) continue;
        const numbered = deriveNumbering(
          node.children.map((c) => c.id),
          (id) => isNumbered(byId().get(id)),
        );
        for (const [id, n] of numbered) out.set(id, n);
        walk(node.children);
      }
    };
    walk(props.roots);
    return out;
  });
  const isOpen = (node: { id: string; collapsed: boolean }, isRoot: boolean): boolean =>
    (isRoot && props.rootsOpen ? true : !node.collapsed) !== flipped().has(node.id);
  const rows = createMemo(() => visibleEmbedRows(props.roots, isOpen, props.cap ?? EMBED_ROW_CAP));
  const toggle = (id: string): void => {
    setFlipped((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <ul class="vr-embed-outline">
        <For each={rows().ids}>
          {(id) => (
            <OutlineRow
              id={id}
              node={() => byId().get(id)}
              depth={rows().depth.get(id) ?? 0}
              ordinal={ordinals().get(id)}
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
            props.onMore();
          }}
        >
          {rows().hidden === 1 ? "1 more block" : `${rows().hidden} more blocks`}
        </button>
      </Show>
    </>
  );
}

const NO_PROPERTIES: Readonly<Record<string, string>> = Object.freeze({});

function OutlineRow(props: {
  /** The `<For>` key itself — a plain string, so nothing derived from it is re-evaluated when a
   * re-read replaces the node objects. */
  id: string;
  node: () => BlockTreeNode | undefined;
  depth: number;
  /** `list:: number` ordinal, when the block is numbered. */
  ordinal: number | undefined;
  open: boolean;
  onToggle: () => void;
  ctx: RenderCtx;
}): JSX.Element {
  // Memo on the string first: a re-read of the graph hands over new node objects with the same
  // text, and re-classifying (and re-rendering) every row on every keystroke elsewhere is the cost
  // this avoids.
  const text = createMemo(() => props.node()?.content ?? "");
  const content = createMemo(() => classifyBlockContent(text()));
  const marker = () => props.node()?.marker ?? null;
  const priority = () => props.node()?.priority ?? null;
  const hasChildren = (): boolean => (props.node()?.children.length ?? 0) > 0;
  // The dates as `BlockTree` hands them to `BlockRowView`: the ADR 011 text form.
  const scheduled = (): string | null => {
    const n = props.node();
    return n?.scheduledDay != null ? formatDayTime(n.scheduledDay, n.scheduledTime) : null;
  };
  const deadline = (): string | null => {
    const n = props.node();
    return n?.deadlineDay != null ? formatDayTime(n.deadlineDay, n.deadlineTime) : null;
  };

  const toBlock = (): void => props.ctx.onNavigate?.({ kind: "block", id: props.id });

  const go = (e: MouseEvent | KeyboardEvent): void => {
    // A real link inside the row (`https://…`, an asset) keeps its own default — the tab it opens.
    // `halt` below would cancel it and send the click to the block instead (B-216). Stopped all the
    // same, or a host block would take the click as "edit me". `[[page]]` links never get here:
    // `NavLink` stops its click first.
    if (e.target instanceof Element && e.target.closest("a[href]")) {
      e.stopPropagation();
      return;
    }
    // Before anything else: a host `.vr-block-view` treats a click as "edit me", and a row here is
    // a way to its own block, not into the block that embeds it.
    halt(e);
    const pageId = props.node()?.pageId;
    if (e.shiftKey && props.ctx.onShelfOpen && pageId) {
      props.ctx.onShelfOpen({ kind: "block", id: props.id, pageId });
      return;
    }
    toBlock();
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
            aria-label={props.open ? "Collapse in this view" : "Expand in this view"}
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
              <TaskMarkerIcon marker={m()} />
            </span>
          )}
        </Show>
        <Show when={priority()}>
          {(p) => <span class={`vr-priority vr-priority-${p()}`}>{p()}</span>}
        </Show>
        <Show when={props.ordinal !== undefined}>
          <span class="vr-list-number">{props.ordinal}.</span>
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
          {/* A click on the chips (not on a link in a value) bubbles to the row: to the block. */}
          <BlockProperties
            properties={props.node()?.properties ?? NO_PROPERTIES}
            onNavigate={props.ctx.onNavigate}
            onActivate={() => {}}
          />
        </div>
        {/* Read-only: a chip's click would open the date picker, which writes. It goes to the
            block instead — where the date can be changed. */}
        <DateChips
          blockId={props.id}
          scheduled={scheduled()}
          deadline={deadline()}
          marker={marker()}
          repeat={props.node()?.repeat ?? null}
          onLocked={toBlock}
        />
      </div>
    </li>
  );
}
