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
 *
 * The outline itself — rows, folding, the row cap — is `./ReadOnlyOutline.tsx`, shared with the
 * references panel (B-550).
 */

import { createMemo, type JSX, Show } from "solid-js";
import { type EmbedData, type EmbedTarget, useEmbed } from "../../data/embeds.js";
import { displayPageName, displayRefName } from "../../data/page-title.js";
import type { BlockTreeNode } from "../../data/types.js";
import { pageRoutePath } from "../../routes/page-path.js";
import { EMBED_ROW_CAP, embedReachesPath } from "./embedRows.js";
import { halt, ReadOnlyOutline } from "./ReadOnlyOutline.js";
import { MAX_REF_DEPTH, type RenderCtx } from "./tokens.js";
import "./embed.css";

type Props = { target: EmbedTarget; from: number; to: number; ctx: RenderCtx };

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
          href={pageRoutePath(page().name)}
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
  const roots = createMemo((): readonly BlockTreeNode[] =>
    props.data.status === "page" ? props.data.blocks : [props.data.node],
  );
  const pageName = (): string => props.data.page.name;

  return (
    <>
      <div class="vr-embed-head">
        <a
          class="vr-embed-source"
          href={pageRoutePath(pageName())}
          onClick={(e) => {
            if (!props.ctx.onNavigate) return;
            halt(e);
            props.ctx.onNavigate({ kind: "page", name: pageName() });
          }}
        >
          {displayPageName(props.data.page)}
        </a>
      </div>
      <Show when={roots().length > 0} fallback={<div class="vr-embed-note">Empty page.</div>}>
        {/* A block embed's root is open whatever it says: embedding a block is asking to see what
            hangs off it, and the owner's own embeds point at blocks folded away on their original
            day. A page embed's top-level blocks keep their stored state, like the page does. */}
        <ReadOnlyOutline
          roots={roots()}
          rootsOpen={props.data.status === "block"}
          cap={EMBED_ROW_CAP}
          ctx={props.ctx}
          onMore={() =>
            props.ctx.onNavigate?.(
              props.data.status === "page"
                ? { kind: "page", name: pageName() }
                : { kind: "block", id: props.data.node.id },
            )
          }
        />
      </Show>
    </>
  );
}
