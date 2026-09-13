/**
 * The rendered (non-editing) view of a ```` ```query ```` fence: live results from the local
 * replica as a read-only outline grouped by page, with a count, every block clickable to
 * navigate. Loaded lazily by `tokens.tsx` on the first query fence rendered, so a page without
 * one never pulls the evaluator in; the raw fence is what the editing surface shows (the fence
 * body is never inline-tokenized, so the live preview has nothing to hide there).
 *
 * States are words, not blanks: a parse error names what is wrong and marks where; an empty
 * result says "No blocks match."; a failed evaluation says so. The count line doubles as the
 * place to admit truncation (`QUERY_CANDIDATE_CAP`) or a `limit:`.
 */
import { classifyBlockContent, parseQuery } from "@nooklet/core";
import { createMemo, For, Show } from "solid-js";
import { describeError } from "../../data/api-client.js";
import { displayPageName } from "../../data/page-title.js";
import {
  type QueryPageGroup,
  type QueryResultBlock,
  type QueryResults,
  useQueryResults,
} from "../../data/queries.js";
import { sameJson } from "../../data/same-json.js";
import { pageRoutePath } from "../../routes/page-path.js";
import { MARKER_GLYPH } from "../BlockRowView.js";
import { BlockContentView, type RenderCtx } from "./tokens.js";
import "./query.css";

function stop(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}

export function describeCount(r: QueryResults): string {
  const blocks = r.matched === 1 ? "1 block" : `${r.matched} blocks`;
  const pages = r.groups.length === 1 ? "1 page" : `${r.groups.length} pages`;
  const limited = r.shown < r.matched ? `, first ${r.shown} shown` : "";
  const truncated = r.truncated ? " — search stopped early, narrow the query" : "";
  if (r.matched === 0) return "0 blocks";
  return `${blocks}${limited} on ${pages}${truncated}`;
}

function HitView(props: { block: QueryResultBlock; ctx: RenderCtx; depth: number }) {
  const go = (e: Event): void => {
    // Stop before the enclosing `.vr-block-view` sees the click, or navigating to a result would
    // also drop the query block into edit mode.
    stop(e);
    props.ctx.onNavigate?.({ kind: "block", id: props.block.id });
  };
  const content = createMemo(() => classifyBlockContent(props.block.content));
  return (
    // `data-query-hit-id`, never `data-block-id`: that attribute is how the shelf's reveal and the
    // agent flash find a block's outliner ROW (`document.querySelector`, first match wins), and a
    // query above its own results on the same page made them land on the result (B-211).
    <li class="vr-query-hit" data-query-hit-id={props.block.id} style={{ "--depth": props.depth }}>
      {/* biome-ignore lint/a11y/useSemanticElements: a result row navigates to its block on click but hosts rendered rich content (links, checkboxes) that cannot live inside an <a>. */}
      <div
        class="vr-query-hit-row"
        role="link"
        tabIndex={props.ctx.onNavigate ? 0 : undefined}
        onClick={go}
        onKeyDown={(e) => {
          if (e.key === "Enter") go(e);
        }}
      >
        <span class="vr-query-bullet" aria-hidden="true" />
        <Show when={props.block.marker}>
          {(m) => (
            <span class={`vr-marker vr-marker-${m()}`} role="img" aria-label={`Task: ${m()}`}>
              {MARKER_GLYPH[m()] ?? "☐"}
            </span>
          )}
        </Show>
        <Show when={props.block.priority}>
          {(p) => <span class={`vr-priority vr-priority-${p()}`}>{p()}</span>}
        </Show>
        <div class="vr-query-hit-content" dir="auto">
          <BlockContentView
            content={content()}
            ctx={{
              source: props.block.content,
              onNavigate: props.ctx.onNavigate,
              onShelfOpen: props.ctx.onShelfOpen,
              resolveBlockRef: props.ctx.resolveBlockRef,
              // A result that is itself a query fence renders as a plain fence (tokens.tsx only
              // evaluates at depth 0) — otherwise two queries matching each other would recurse.
              refDepth: (props.ctx.refDepth ?? 0) + 1,
            }}
          />
        </div>
      </div>
      <Show when={props.block.children.length > 0}>
        <ul class="vr-query-children">
          <For each={props.block.children}>
            {(c) => <HitView block={c} ctx={props.ctx} depth={props.depth + 1} />}
          </For>
        </ul>
      </Show>
    </li>
  );
}

function GroupView(props: { group: QueryPageGroup; ctx: RenderCtx }) {
  const title = (): string =>
    displayPageName({ name: props.group.pageName, journalDay: props.group.pageJournalDay });
  return (
    <section class="vr-query-group" data-page-id={props.group.pageId}>
      <h4 class="vr-query-page">
        <a
          href={pageRoutePath(props.group.pageName)}
          class="vr-page-ref"
          onClick={(e) => {
            if (!props.ctx.onNavigate) return;
            stop(e);
            props.ctx.onNavigate({ kind: "page", name: props.group.pageName });
          }}
        >
          {title()}
        </a>
      </h4>
      <ul class="vr-query-hits">
        <For each={props.group.hits}>{(b) => <HitView block={b} ctx={props.ctx} depth={0} />}</For>
      </ul>
    </section>
  );
}

function ErrorSource(props: { code: string; start: number; end: number }) {
  const before = (): string => props.code.slice(0, props.start);
  const bad = (): string => props.code.slice(props.start, props.end);
  const after = (): string => props.code.slice(props.end);
  return (
    <pre class="vr-query-source">
      <code>
        {before()}
        <Show
          when={bad() !== ""}
          fallback={<mark class="vr-query-error-mark vr-query-error-mark-empty" />}
        >
          <mark class="vr-query-error-mark">{bad()}</mark>
        </Show>
        {after()}
      </code>
    </pre>
  );
}

export default function QueryFenceView(props: { code: string; ctx: RenderCtx }) {
  const parsed = createMemo(() => parseQuery(props.code));
  const results = useQueryResults(() => {
    const p = parsed();
    return p.ok ? p.query : undefined;
  });
  // `results.latest` re-throws while the resource is errored, exactly like calling it: an
  // unguarded read in the head's `when` threw before "Query failed" could render, and the fence
  // sat on "Running query…" forever (B-131). Every read goes through this.
  //
  // A memo compared by value: the query re-runs on every change to the graph and answers with new
  // objects even when the results are the same, and `<For>` rebuilt every hit from them — each
  // `((ref))` inside one back to its placeholder, until B-500 (B-511).
  const latest = createMemo(
    (): QueryResults | undefined => (results.error !== undefined ? undefined : results.latest),
    undefined,
    { equals: sameJson },
  );
  return (
    <div class="vr-query" data-lang="query">
      <Show
        when={parsed().ok}
        fallback={
          <div class="vr-query-error" role="status">
            <div>
              <span class="vr-query-error-label">Query error:</span>{" "}
              {parsed().ok
                ? ""
                : (parsed() as { ok: false; error: { message: string } }).error.message}
            </div>
            <Show when={!parsed().ok}>
              {(() => {
                const p = parsed();
                return p.ok ? null : (
                  <ErrorSource code={props.code} start={p.error.start} end={p.error.end} />
                );
              })()}
            </Show>
          </div>
        }
      >
        <div class="vr-query-head">
          <code class="vr-query-text">{props.code.trim()}</code>
          <Show
            when={latest()}
            fallback={
              <Show when={results.error === undefined}>
                <span class="vr-query-count">Running query…</span>
              </Show>
            }
          >
            {(r) => <span class="vr-query-count">{describeCount(r())}</span>}
          </Show>
        </div>
        <Show when={results.error !== undefined}>
          <div class="vr-query-error" role="status">
            <span class="vr-query-error-label">Query failed:</span> {describeError(results.error)}
          </div>
        </Show>
        <Show when={latest()}>
          {(r) => (
            <Show
              when={r().groups.length > 0}
              fallback={<div class="vr-query-empty">No blocks match.</div>}
            >
              <For each={r().groups}>{(g) => <GroupView group={g} ctx={props.ctx} />}</For>
            </Show>
          )}
        </Show>
      </Show>
    </div>
  );
}
