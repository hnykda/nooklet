/**
 * Renders `tokenizeContent`/`classifyBlockContent`'s output as HTML, per the rendering contract
 * table (`docs/spec/markdown-grammar.md` §4) — exact CSS class names, one component per token/
 * content kind. Used by `InlineContent.tsx` (reference snippets/search hits) and by the read-only
 * `BlockView` inside `BlockRowView.tsx` (every block that is not the one currently being edited).
 *
 * Every rendered node carries `data-from`/`data-to` (the tokenizer's own offsets into the block's
 * `content` string) so a click on the rendered view can compute an exact source-string caret
 * offset without Logseq's diff-based heuristic (research/04-editor.md §3.3): walk up from the
 * clicked DOM position to the nearest `[data-from]` and add the in-token character offset. See
 * `caret.ts#resolveClickOffset`.
 *
 * `RenderCtx.source` is the whole content string being rendered — carried on the context (rather
 * than threaded as a separate prop through every recursive call) so a `text` token nested inside
 * `strong`/`em`/a link label/etc. can still slice its own characters out of it; every token's
 * `start`/`end` is an absolute offset into that one string regardless of nesting depth (the
 * tokenizer's own invariant, markdown-grammar.md Definitions).
 *
 * Known gaps, flagged here and in `BlockTree.tsx`'s summary rather than silently faked:
 *  - `wikilink`/`linkToPage` `.vr-ref-new` (page doesn't exist) needs a page-existence index this
 *    milestone's data seam does not expose; every ref renders as "resolved" (no `.vr-ref-new`)
 *    until a page-index prop is threaded through.
 *  - `blockRef`/`linkToBlock`'s "inline render of the target block's own tokens" needs a
 *    cross-page block lookup, likewise not in the data seam yet; falls back to a muted
 *    `((id))`-style placeholder unless the caller supplies `resolveBlockRef`.
 *  - `embed` renders a placeholder (not a live nested `BlockTree`) — same gap (needs a
 *    page-name/block-id -> page/tree resolver the data seam doesn't expose yet).
 */
import {
  type Align,
  type BlockContent,
  type InlineToken as Tok,
  tokenizeContent,
} from "@nooklet/core";

import { For, Show } from "solid-js";
import { assetUrl } from "./asset-url.js";

export type NavigateTarget = { kind: "page"; name: string } | { kind: "block"; id: string };
export type Navigate = (t: NavigateTarget) => void;

export interface RenderCtx {
  /** The full string these tokens' offsets are relative to. */
  source: string;
  onNavigate?: Navigate;
  /** Shift+click on a `[[page]]`/`#tag` link opens that page on the right-hand shelf instead of
   * navigating to it (`../../app/shelf.ts`). Only page links are wired: a `((block-ref))` would
   * need its own page id, which this renderer has no way to resolve. Absent = plain navigation. */
  onShelfOpen?: Navigate;
  /** Depth-limited recursive rendering for blockRef/embed (rendering contract: "depth-limited to
   * 2"); defaults to 0 and increments on recursion — callers normally never set this. */
  refDepth?: number;
  resolveBlockRef?: (id: string) => { content: string } | undefined;
  /** Deferred syntax-highlighting seam (BUILD item 1's "clearly-marked seam" option) — returns
   * highlighted HTML for `code`/`lang`, or `null` to fall back to plain text. Not wired to any
   * highlighter in this milestone; see `BlockTree.tsx`'s doc comment for why. */
  highlightCode?: (code: string, lang: string) => string | null;
}

const MAX_REF_DEPTH = 2;

function stop(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

function NavLink(props: {
  class: string;
  target: NavigateTarget;
  href: string;
  from: number;
  to: number;
  onNavigate?: Navigate;
  onShelfOpen?: Navigate;
  children: unknown;
}) {
  return (
    <a
      href={props.href}
      class={props.class}
      data-from={props.from}
      data-to={props.to}
      onClick={(e) => {
        // Shift first, and `stop` before anything else runs: the enclosing block row treats a
        // Shift+click of its own as "shelve this block", so without halting propagation here you
        // would get the link's page AND the block it was written in.
        if (e.shiftKey && props.onShelfOpen) {
          stop(e);
          props.onShelfOpen(props.target);
          return;
        }
        if (!props.onNavigate) return;
        stop(e);
        props.onNavigate(props.target);
      }}
    >
      {props.children as never}
    </a>
  );
}

function BlockRefView(props: {
  id: string;
  label: Tok[] | undefined;
  from: number;
  to: number;
  ctx: RenderCtx;
}) {
  const depth = () => props.ctx.refDepth ?? 0;
  const resolved = (): { content: string } | undefined =>
    depth() < MAX_REF_DEPTH ? props.ctx.resolveBlockRef?.(props.id) : undefined;
  const navigate = (e: { preventDefault(): void; stopPropagation(): void }): void => {
    if (!props.ctx.onNavigate) return;
    e.preventDefault();
    e.stopPropagation();
    props.ctx.onNavigate({ kind: "block", id: props.id });
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: not a real hyperlink (no href/browser navigation) — a rendered ((block-ref)) preview inline in running text, whose content model doesn't fit `<a>`.
    <span
      class="vr-block-ref"
      data-from={props.from}
      data-to={props.to}
      role="link"
      tabIndex={props.ctx.onNavigate ? 0 : undefined}
      onClick={navigate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") navigate(e);
      }}
    >
      <Show
        when={props.label}
        fallback={
          <Show when={resolved()} fallback={`((${props.id}))`}>
            {(r) => <RefPreview content={r().content} ctx={props.ctx} depth={depth() + 1} />}
          </Show>
        }
      >
        <InlineTokens tokens={props.label as Tok[]} ctx={props.ctx} />
      </Show>
    </span>
  );
}

/** Renders a plain content string as a fresh, independently-tokenized inline run (the "target
 * block's own tokens" the rendering contract asks a `blockRef` preview to show). */
function RefPreview(props: { content: string; ctx: RenderCtx; depth: number }) {
  const tokens = () => tokenizeContent(props.content);
  return (
    <InlineTokens
      tokens={tokens()}
      ctx={{ ...props.ctx, source: props.content, refDepth: props.depth }}
    />
  );
}

function EmbedView(props: {
  target: { kind: "page"; name: string } | { kind: "block"; id: string } | null;
  from: number;
  to: number;
}) {
  if (props.target === null) {
    return (
      <div class="vr-embed vr-embed-error" data-from={props.from} data-to={props.to}>
        {"{{embed}}"}
      </div>
    );
  }
  if (props.target.kind === "page") {
    return (
      <div class="vr-embed vr-embed-page" data-from={props.from} data-to={props.to}>
        Embed: [[{props.target.name}]]
      </div>
    );
  }
  return (
    <div class="vr-embed vr-embed-block" data-from={props.from} data-to={props.to}>
      Embed: (({props.target.id}))
    </div>
  );
}

/** One inline token -> JSX. Recurses (via `InlineTokens`) for nested-token kinds. */
function InlineTokenView(props: { tok: Tok; ctx: RenderCtx }) {
  return (
    <>
      {(() => {
        const tok = props.tok;
        const ctx = props.ctx;
        switch (tok.kind) {
          case "text":
            return (
              <span data-from={tok.start} data-to={tok.end}>
                {ctx.source.slice(tok.start, tok.end)}
              </span>
            );
          case "br":
            return <br data-from={tok.start} data-to={tok.end} />;
          case "escape":
            return (
              <span data-from={tok.start} data-to={tok.end}>
                {tok.char}
              </span>
            );
          case "wikilink":
            return (
              <NavLink
                class="vr-page-ref"
                target={{ kind: "page", name: tok.target }}
                href={`/page/${encodeURIComponent(tok.target)}`}
                from={tok.start}
                to={tok.end}
                onNavigate={ctx.onNavigate}
                onShelfOpen={ctx.onShelfOpen}
              >
                {tok.alias ?? tok.target}
              </NavLink>
            );
          case "tag":
            return (
              <NavLink
                class="vr-tag"
                target={{ kind: "page", name: tok.name }}
                href={`/page/${encodeURIComponent(tok.name)}`}
                from={tok.start}
                to={tok.end}
                onNavigate={ctx.onNavigate}
                onShelfOpen={ctx.onShelfOpen}
              >
                {tok.multiWord ? `#[[${tok.name}]]` : `#${tok.name}`}
              </NavLink>
            );
          case "blockRef":
            return (
              <BlockRefView id={tok.id} label={undefined} from={tok.start} to={tok.end} ctx={ctx} />
            );
          case "linkToBlock":
            return (
              <BlockRefView id={tok.id} label={tok.label} from={tok.start} to={tok.end} ctx={ctx} />
            );
          case "embed":
            return <EmbedView target={tok.target} from={tok.start} to={tok.end} />;
          case "macro":
            return (
              <span class="vr-macro-unknown" data-from={tok.start} data-to={tok.end}>
                {`{{${tok.name} ${tok.args}}}`}
              </span>
            );
          case "linkToPage":
            return (
              <NavLink
                class="vr-page-ref"
                target={{ kind: "page", name: tok.target }}
                href={`/page/${encodeURIComponent(tok.target)}`}
                from={tok.start}
                to={tok.end}
                onNavigate={ctx.onNavigate}
                onShelfOpen={ctx.onShelfOpen}
              >
                <InlineTokens tokens={tok.label} ctx={ctx} />
              </NavLink>
            );
          case "link":
            return (
              <a
                class="vr-link"
                href={assetUrl(tok.href)}
                target="_blank"
                rel="noopener"
                data-from={tok.start}
                data-to={tok.end}
              >
                <InlineTokens tokens={tok.label} ctx={ctx} />
              </a>
            );
          case "autolink":
            return (
              <a
                class="vr-link vr-autolink"
                href={tok.href}
                target="_blank"
                rel="noopener"
                data-from={tok.start}
                data-to={tok.end}
              >
                {tok.href}
              </a>
            );
          case "image":
            return (
              <img
                class="vr-image"
                alt={tok.alt}
                src={assetUrl(tok.src)}
                loading="lazy"
                data-from={tok.start}
                data-to={tok.end}
              />
            );
          case "strong":
            return (
              <strong data-from={tok.start} data-to={tok.end}>
                <InlineTokens tokens={tok.children} ctx={ctx} />
              </strong>
            );
          case "em":
            return (
              <em data-from={tok.start} data-to={tok.end}>
                <InlineTokens tokens={tok.children} ctx={ctx} />
              </em>
            );
          case "strike":
            return (
              <s data-from={tok.start} data-to={tok.end}>
                <InlineTokens tokens={tok.children} ctx={ctx} />
              </s>
            );
          case "highlight":
            return (
              <mark class="vr-highlight" data-from={tok.start} data-to={tok.end}>
                <InlineTokens tokens={tok.children} ctx={ctx} />
              </mark>
            );
          case "code":
            return (
              <code class="vr-inline-code" data-from={tok.start} data-to={tok.end}>
                {tok.code}
              </code>
            );
          case "math":
            return (
              <span class="vr-math" data-from={tok.start} data-to={tok.end}>
                {`$${tok.tex}$`}
              </span>
            );
          case "checkbox":
            return (
              <input
                type="checkbox"
                class="vr-checkbox"
                disabled
                checked={tok.checked}
                data-from={tok.start}
                data-to={tok.end}
              />
            );
          default:
            return null;
        }
      })()}
    </>
  );
}

/** A run of inline tokens sharing one `RenderCtx.source`. */
export function InlineTokens(props: { tokens: Tok[]; ctx: RenderCtx }) {
  return <For each={props.tokens}>{(tok) => <InlineTokenView tok={tok} ctx={props.ctx} />}</For>;
}

function alignStyle(a: Align): string | undefined {
  return a ? `text-align: ${a}` : undefined;
}

/** A block's classified content (`classifyBlockContent`) -> HTML, per the rendering contract. */
export function BlockContentView(props: { content: BlockContent; ctx: RenderCtx }) {
  return (
    <>
      {(() => {
        const c = props.content;
        const ctx = props.ctx;
        switch (c.kind) {
          case "paragraph":
            return (
              <p class="vr-paragraph">
                <For each={c.lines}>{(line) => <InlineTokens tokens={line} ctx={ctx} />}</For>
              </p>
            );
          case "heading": {
            const level = c.level;
            return (
              <>
                <Show when={level === 1}>
                  <h1 class="vr-heading">
                    <InlineTokens tokens={c.title} ctx={ctx} />
                  </h1>
                </Show>
                <Show when={level === 2}>
                  <h2 class="vr-heading">
                    <InlineTokens tokens={c.title} ctx={ctx} />
                  </h2>
                </Show>
                <Show when={level === 3}>
                  <h3 class="vr-heading">
                    <InlineTokens tokens={c.title} ctx={ctx} />
                  </h3>
                </Show>
                <Show when={level === 4}>
                  <h4 class="vr-heading">
                    <InlineTokens tokens={c.title} ctx={ctx} />
                  </h4>
                </Show>
                <Show when={level === 5}>
                  <h5 class="vr-heading">
                    <InlineTokens tokens={c.title} ctx={ctx} />
                  </h5>
                </Show>
                <Show when={level === 6}>
                  <h6 class="vr-heading">
                    <InlineTokens tokens={c.title} ctx={ctx} />
                  </h6>
                </Show>
                <Show when={c.trailing}>
                  <For each={c.trailing}>
                    {(line) => (
                      <p class="vr-paragraph">
                        <InlineTokens tokens={line} ctx={ctx} />
                      </p>
                    )}
                  </For>
                </Show>
              </>
            );
          }
          case "fence": {
            const highlighted = () => ctx.highlightCode?.(c.code, c.lang) ?? null;
            return (
              <pre class="vr-fence" data-lang={c.lang}>
                <Show
                  when={highlighted()}
                  fallback={<code class={`language-${c.lang}`}>{c.code}</code>}
                >
                  {(html) => (
                    // Highlighter output only (never raw user HTML) — see `RenderCtx.highlightCode`'s doc.
                    <code class={`language-${c.lang}`} innerHTML={html()} />
                  )}
                </Show>
              </pre>
            );
          }
          case "quote":
            return (
              <blockquote class="vr-quote">
                <For each={c.lines}>{(line) => <InlineTokens tokens={line} ctx={ctx} />}</For>
              </blockquote>
            );
          case "table":
            return (
              <table class="vr-table">
                <thead>
                  <tr>
                    <For each={c.header}>
                      {(cell, i) => (
                        <th style={alignStyle(c.align[i()] ?? null)}>
                          <InlineTokens tokens={cell} ctx={ctx} />
                        </th>
                      )}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  <For each={c.rows}>
                    {(row) => (
                      <tr>
                        <For each={row}>
                          {(cell, i) => (
                            <td style={alignStyle(c.align[i()] ?? null)}>
                              <InlineTokens tokens={cell} ctx={ctx} />
                            </td>
                          )}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            );
          case "hr":
            return <hr class="vr-hr" />;
          default:
            return null;
        }
      })()}
    </>
  );
}
