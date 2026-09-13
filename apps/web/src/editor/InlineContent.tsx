/**
 * `InlineContent` — the second half of this package's required public interface (alongside
 * `BlockTree`), reused by other views for reference snippets/search hits: tokenizes `content`
 * (`tokenizeContent`) and renders it via the same rendering contract every block uses
 * (`render/tokens.tsx`, `docs/spec/markdown-grammar.md` §4), so a search result or a backlink
 * snippet looks pixel-identical to the real block. Read-only: no click-to-edit, no surface — just
 * the rendering contract's `onNavigate` for wikilink/tag/blockref clicks.
 */

import { tokenizeContent } from "@nooklet/core";
import { createMemo } from "solid-js";
import { InlineTokens, type NavigateTarget, type RenderCtx } from "./render/tokens.js";

export function InlineContent(props: {
  content: string;
  onNavigate?: (t: NavigateTarget) => void;
  /** Renders `((id))` as the referenced block's text (`../data/block-ref-cache.ts#resolveBlockRef`).
   * A prop rather than an import: this component is also rendered where no replica exists (unit
   * tests of views) and must not pull the worker client in. Absent = the muted `((id))`
   * placeholder. */
  resolveBlockRef?: RenderCtx["resolveBlockRef"];
}) {
  const tokens = createMemo(() => tokenizeContent(props.content));
  return (
    <InlineTokens
      tokens={tokens()}
      ctx={{
        source: props.content,
        onNavigate: props.onNavigate,
        resolveBlockRef: props.resolveBlockRef,
      }}
    />
  );
}
