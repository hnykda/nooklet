/**
 * Linked and unlinked references (BUILD item 2; PLAN.md §4: "Linked references of page P = blocks
 * whose path refs include P ... grouped by page, most recent page first. Unlinked references =
 * full-text hits for the page name ... in blocks that do not already reference P."). Data comes
 * from `page.backlinks` over HTTP (`../data/store.ts#useLinkedReferences`, since the client-only
 * schema has no `ref`/`path_ref`/FTS tables); grouping, sorting and filtering are
 * `views/referenceGrouping.ts`, pure and separately tested; what is remembered between visits is
 * `views/referenceFilters.ts` (per device — ADR 021 says why not a page property).
 *
 * Three rules the panel follows, all learned from it getting them wrong:
 *
 * - **Nothing to show means show nothing.** Two headed sections reading "No linked references
 *   yet" and "No unlinked mentions found" on every page is noise; the panel disappears instead.
 * - **Both halves collapse**, and each remembers its state for the session. Linked references
 *   open by default because that is the half people read.
 * - **A failure says so.** This is a network call to `/api/v1/page.backlinks`; when it fails the
 *   panel used to sit on "Loading…" forever, which is indistinguishable from a page that simply
 *   has no backlinks.
 *
 * M7 (research/13 §4.2 items 5 and 10) adds, on the linked half, Logseq's filter popover — the
 * other pages the referencing blocks mention, click to include, again to exclude, again to clear
 * — and a recent/by-name sort; and on the unlinked half a "Link all" button that runs
 * `mentions.link` (one batch) and offers `batch.undo` on the result. The count on each heading is
 * the count of what is under it, filter applied — a "12" over three visible rows is a lie.
 *
 * "What is under it" means every reference, not the first page of them (B-253): the panel used to
 * hold the first 200 linked and 50 unlinked rows and count, filter and Link-all over that slice.
 * It now holds them all (up to `MAX_LINKED_REFERENCES`, the heading saying so beyond that) and
 * RENDERS a window of `REFERENCE_ROWS_STEP` rows with a "Show more" button
 * (`./referenceWindow.ts` says why rendering is windowed but counting is not).
 */
import { normalizePageName } from "@nooklet/core";
import { ArrowDownUp, Filter, Link2, Undo2, X } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { callOp, describeError } from "../data/api-client.js";
import { displayRefName } from "../data/page-title.js";
import { useLinkedReferences } from "../data/store.js";
import type { NavigateTarget } from "../data/types.js";
import { InlineContent } from "../editor/InlineContent.js";
import {
  loadReferenceFilter,
  loadReferenceSort,
  saveReferenceFilter,
  saveReferenceSort,
} from "./referenceFilters.js";
import {
  applyReferenceFilter,
  cycleFilterKey,
  EMPTY_FILTER,
  filterCandidates,
  groupLinkedReferences,
  groupUnlinkedReferences,
  isFilterEmpty,
  type ReferenceFilter,
  type ReferenceSort,
} from "./referenceGrouping.js";
import { countLabel, firstRows, REFERENCE_ROWS_STEP } from "./referenceWindow.js";
import "./references.css";

export interface ReferencesPanelProps {
  /** The page name/date passed to `page.backlinks`'s `target`. */
  target: string;
  onNavigate: (t: NavigateTarget) => void;
}

interface Group {
  page: string;
  refs: ReadonlyArray<{ id: string; text: string }>;
}

function ReferenceGroups(props: {
  groups: Group[];
  onNavigate: (t: NavigateTarget) => void;
}): JSX.Element {
  return (
    <For each={props.groups}>
      {(group) => (
        <div class="reference-group">
          <button
            type="button"
            class="reference-group-page"
            onClick={() => props.onNavigate({ kind: "page", name: group.page })}
          >
            {displayRefName(group.page)}
          </button>
          <ul>
            <For each={group.refs}>
              {(ref) => (
                <li class="reference-item">
                  <button
                    type="button"
                    class="reference-item-jump"
                    onClick={() => props.onNavigate({ kind: "block", id: ref.id })}
                  >
                    <InlineContent content={ref.text} onNavigate={props.onNavigate} />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      )}
    </For>
  );
}

/** "Show N more" under a windowed list; nothing when every row is already shown. */
function ShowMore(props: { shown: number; total: number; onMore: () => void }): JSX.Element {
  const next = () => Math.min(REFERENCE_ROWS_STEP, props.total - props.shown);
  return (
    <Show when={props.shown < props.total}>
      <button type="button" class="references-retry references-more" onClick={props.onMore}>
        Show {next()} more ({props.total - props.shown} not shown)
      </button>
    </Show>
  );
}

/**
 * The filter popover: every page the linked blocks also mention, with counts. One button per
 * page cycles it off → included → excluded → off, which is the whole Logseq gesture and needs no
 * second control. Closes on Escape or a click anywhere else.
 */
function FilterPopover(props: {
  candidates: ReadonlyArray<{ key: string; name: string; count: number }>;
  filter: ReferenceFilter;
  onCycle: (key: string) => void;
  onClear: () => void;
  onClose: () => void;
}): JSX.Element {
  let root: HTMLDivElement | undefined;
  const onDocClick = (e: MouseEvent): void => {
    if (root && !root.contains(e.target as Node)) props.onClose();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") props.onClose();
  };
  // Deferred a tick so the click that opened the popover does not immediately close it.
  const t = setTimeout(() => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
  }, 0);
  onCleanup(() => {
    clearTimeout(t);
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  });

  const state = (key: string): "include" | "exclude" | "off" =>
    props.filter.include.includes(key)
      ? "include"
      : props.filter.exclude.includes(key)
        ? "exclude"
        : "off";

  return (
    <div
      ref={root}
      class="references-filter-popover"
      role="dialog"
      aria-label="Filter linked references"
    >
      <p class="references-filter-hint">
        Click a page to show only blocks that also mention it; click again to hide those blocks;
        once more to clear.
      </p>
      <Show
        when={props.candidates.length > 0}
        fallback={<p class="references-empty">These blocks mention no other pages.</p>}
      >
        <ul class="references-filter-list">
          <For each={props.candidates}>
            {(c) => (
              <li>
                <button
                  type="button"
                  class="references-filter-option"
                  data-state={state(c.key)}
                  onClick={() => props.onCycle(c.key)}
                >
                  <span class="references-filter-mark" aria-hidden="true">
                    {state(c.key) === "include" ? "+" : state(c.key) === "exclude" ? "−" : ""}
                  </span>
                  <span class="references-filter-name">{displayRefName(c.name)}</span>
                  <span class="reference-count">{c.count}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={!isFilterEmpty(props.filter)}>
        <button type="button" class="references-retry" onClick={props.onClear}>
          Clear filter
        </button>
      </Show>
    </div>
  );
}

export function ReferencesPanel(props: ReferencesPanelProps): JSX.Element {
  const [backlinks, { refetch }] = useLinkedReferences(() => props.target);
  const [linkedOpen, setLinkedOpen] = createSignal(true);
  const [unlinkedOpen, setUnlinkedOpen] = createSignal(false);
  const [filterOpen, setFilterOpen] = createSignal(false);
  const [sort, setSortState] = createSignal<ReferenceSort>(loadReferenceSort());

  // The filter belongs to the page being viewed: reload it whenever the target changes, and
  // write every change straight back so it is there on the next visit.
  const pageKey = createMemo(() => normalizePageName(props.target));
  const [filter, setFilterState] = createSignal<ReferenceFilter>(EMPTY_FILTER);
  // How many rows of each list are rendered; a new page starts from one step again.
  const [linkedRows, setLinkedRows] = createSignal(REFERENCE_ROWS_STEP);
  const [unlinkedRows, setUnlinkedRows] = createSignal(REFERENCE_ROWS_STEP);
  createEffect(() => {
    setFilterState(loadReferenceFilter(pageKey()));
    setFilterOpen(false);
    setLinkedRows(REFERENCE_ROWS_STEP);
    setUnlinkedRows(REFERENCE_ROWS_STEP);
  });
  const setFilter = (next: ReferenceFilter): void => {
    setFilterState(next);
    saveReferenceFilter(pageKey(), next);
  };
  const setSort = (next: ReferenceSort): void => {
    setSortState(next);
    saveReferenceSort(next);
  };

  // Reading a Solid resource that has errored RE-THROWS the error, so every read below goes
  // through here. Without it the first `backlinks()` call threw during render and took the whole
  // panel down — including the error message it was supposed to be showing.
  const data = createMemo(() => (backlinks.error !== undefined ? undefined : backlinks()));

  const allLinked = createMemo(() => data()?.linked ?? []);
  const candidates = createMemo(() => filterCandidates(allLinked(), pageKey()));
  const filteredLinked = createMemo(() => applyReferenceFilter(allLinked(), filter()));
  const linkedGroups = createMemo(() => groupLinkedReferences(filteredLinked(), sort()));
  const unlinkedGroups = createMemo(() => groupUnlinkedReferences(data()?.unlinked ?? []));
  const linkedCount = createMemo(() => filteredLinked().length);
  const unlinkedCount = createMemo(() => data()?.unlinked.length ?? 0);
  /** The client stopped short of every linked reference (`MAX_LINKED_REFERENCES`). */
  const linkedPartial = createMemo(() => allLinked().length < (data()?.linkedTotal ?? 0));
  // Unfiltered, the heading can give the server's true total even past the fetch cap; filtered,
  // it can only count what was fetched, and says "+" when that is not everything.
  const linkedCountText = createMemo(() =>
    isFilterEmpty(filter())
      ? String(Math.max(data()?.linkedTotal ?? 0, linkedCount()))
      : countLabel(linkedCount(), linkedPartial()),
  );
  const unlinkedCountText = createMemo(() =>
    countLabel(unlinkedCount(), data()?.unlinkedTruncated ?? false),
  );
  const linkedWindow = createMemo(() => firstRows(linkedGroups(), linkedRows()));
  const unlinkedWindow = createMemo(() => firstRows(unlinkedGroups(), unlinkedRows()));
  const activeFilterCount = createMemo(() => filter().include.length + filter().exclude.length);
  /** Display name for a key in a chip: the candidate's spelling if it is still around, else the
   * key itself (a stale filter must still be removable). */
  const nameForKey = (key: string): string =>
    displayRefName(candidates().find((c) => c.key === key)?.name ?? key);

  // `loading` is also true on every refetch (the panel re-asks whenever the graph changes), so a
  // spinner keyed on it alone would flash on every edit. Only show one when there is nothing yet.
  const firstLoad = createMemo(() => backlinks.loading && data() === undefined);
  const failed = createMemo(() => !backlinks.loading && backlinks.error !== undefined);

  // "Link all": one `mentions.link` call, then the result stays on screen with its undo until
  // the next page. The status line lives OUTSIDE the unlinked section because a successful link
  // empties that section — and takes the undo with it if it were inside.
  const [linkBusy, setLinkBusy] = createSignal(false);
  const [linkError, setLinkError] = createSignal<string | null>(null);
  const [linkResult, setLinkResult] = createSignal<{
    linked: number;
    skipped: number;
    batchId: string | undefined;
    undone: boolean;
  } | null>(null);
  createEffect(() => {
    // A new page: forget the previous page's result.
    pageKey();
    setLinkResult(null);
    setLinkError(null);
  });

  const linkAll = async (): Promise<void> => {
    setLinkBusy(true);
    setLinkError(null);
    try {
      const res = await callOp<{
        updated: string[];
        skipped: Array<{ id: string; reason: string }>;
        batch_id?: string;
      }>("mentions.link", { page: props.target });
      setLinkResult({
        linked: res.updated.length,
        skipped: res.skipped.length,
        batchId: res.batch_id,
        undone: false,
      });
      refetch();
    } catch (err) {
      setLinkError(describeError(err));
    } finally {
      setLinkBusy(false);
    }
  };

  const undoLinkAll = async (): Promise<void> => {
    const result = linkResult();
    if (!result?.batchId) return;
    setLinkBusy(true);
    setLinkError(null);
    try {
      await callOp("batch.undo", { batch_id: result.batchId });
      setLinkResult({ ...result, undone: true });
      refetch();
    } catch (err) {
      setLinkError(describeError(err));
    } finally {
      setLinkBusy(false);
    }
  };

  const hasAnything = createMemo(
    () => allLinked().length > 0 || unlinkedCount() > 0 || linkResult() !== null,
  );

  return (
    <Show when={firstLoad() || failed() || hasAnything()}>
      <div class="references-panel">
        <Show when={firstLoad()}>
          <p class="references-loading">Loading references…</p>
        </Show>

        <Show when={failed()}>
          <p class="references-error" role="alert">
            Couldn't load references.{" "}
            <button type="button" class="references-retry" onClick={() => refetch()}>
              Retry
            </button>
          </p>
        </Show>

        <Show when={allLinked().length > 0}>
          <section class="linked-references" aria-label="Linked references">
            <div class="references-head">
              <button
                type="button"
                class="references-toggle"
                aria-expanded={linkedOpen()}
                onClick={() => setLinkedOpen((v) => !v)}
              >
                <span class="references-caret" aria-hidden="true">
                  {linkedOpen() ? "▾" : "▸"}
                </span>
                Linked references
                <span class="reference-count">{linkedCountText()}</span>
              </button>
              <div class="references-tools">
                <button
                  type="button"
                  class="references-tool"
                  aria-label={
                    sort() === "recent"
                      ? "Sorted by most recent; switch to page name"
                      : "Sorted by page name; switch to most recent"
                  }
                  title="Sort"
                  onClick={() => setSort(sort() === "recent" ? "name" : "recent")}
                >
                  <ArrowDownUp size={13} aria-hidden="true" />
                  <span class="references-tool-label">
                    {sort() === "recent" ? "Recent" : "A–Z"}
                  </span>
                </button>
                <button
                  type="button"
                  class="references-tool"
                  aria-label="Filter linked references"
                  aria-pressed={activeFilterCount() > 0}
                  aria-expanded={filterOpen()}
                  title="Filter"
                  onClick={() => setFilterOpen((v) => !v)}
                >
                  <Filter size={13} aria-hidden="true" />
                  <span class="references-tool-label">Filter</span>
                  <Show when={activeFilterCount() > 0}>
                    <span class="reference-count">{activeFilterCount()}</span>
                  </Show>
                </button>
              </div>
              <Show when={filterOpen()}>
                <FilterPopover
                  candidates={candidates()}
                  filter={filter()}
                  onCycle={(key) => setFilter(cycleFilterKey(filter(), key))}
                  onClear={() => setFilter(EMPTY_FILTER)}
                  onClose={() => setFilterOpen(false)}
                />
              </Show>
            </div>

            <Show when={activeFilterCount() > 0}>
              <div class="references-chips">
                <For each={filter().include}>
                  {(key) => (
                    <button
                      type="button"
                      class="references-chip"
                      data-state="include"
                      title="Remove this filter"
                      onClick={() =>
                        setFilter({
                          include: filter().include.filter((k) => k !== key),
                          exclude: filter().exclude,
                        })
                      }
                    >
                      <span aria-hidden="true">+</span> {nameForKey(key)}
                      <X size={11} aria-hidden="true" />
                    </button>
                  )}
                </For>
                <For each={filter().exclude}>
                  {(key) => (
                    <button
                      type="button"
                      class="references-chip"
                      data-state="exclude"
                      title="Remove this filter"
                      onClick={() =>
                        setFilter({
                          include: filter().include,
                          exclude: filter().exclude.filter((k) => k !== key),
                        })
                      }
                    >
                      <span aria-hidden="true">−</span> {nameForKey(key)}
                      <X size={11} aria-hidden="true" />
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <Show when={linkedOpen()}>
              <Show
                when={linkedCount() > 0}
                fallback={<p class="references-empty">No references match this filter.</p>}
              >
                <ReferenceGroups groups={linkedWindow().groups} onNavigate={props.onNavigate} />
                <ShowMore
                  shown={linkedWindow().shown}
                  total={linkedWindow().total}
                  onMore={() => setLinkedRows((n) => n + REFERENCE_ROWS_STEP)}
                />
                <Show when={linkedPartial()}>
                  <p class="references-empty">
                    Only the {allLinked().length} most recent of {data()?.linkedTotal} references
                    are listed and filtered here.
                  </p>
                </Show>
              </Show>
            </Show>
          </section>
        </Show>

        <Show when={unlinkedCount() > 0}>
          <section class="unlinked-references" aria-label="Unlinked references">
            <div class="references-head">
              <button
                type="button"
                class="references-toggle"
                aria-expanded={unlinkedOpen()}
                onClick={() => setUnlinkedOpen((v) => !v)}
              >
                <span class="references-caret" aria-hidden="true">
                  {unlinkedOpen() ? "▾" : "▸"}
                </span>
                Unlinked references
                <span class="reference-count">{unlinkedCountText()}</span>
              </button>
              <div class="references-tools">
                <button
                  type="button"
                  class="references-tool references-link-all"
                  title="Turn every plain mention into a [[link]]"
                  disabled={linkBusy()}
                  onClick={() => void linkAll()}
                >
                  <Link2 size={13} aria-hidden="true" />
                  <span class="references-tool-label">{linkBusy() ? "Linking…" : "Link all"}</span>
                </button>
              </div>
            </div>
            <Show when={unlinkedOpen()}>
              <ReferenceGroups groups={unlinkedWindow().groups} onNavigate={props.onNavigate} />
              <ShowMore
                shown={unlinkedWindow().shown}
                total={unlinkedWindow().total}
                onMore={() => setUnlinkedRows((n) => n + REFERENCE_ROWS_STEP)}
              />
            </Show>
          </section>
        </Show>

        <Show when={linkResult()}>
          {(result) => (
            <p class="references-status" role="status">
              <Show
                when={!result().undone}
                fallback={<>Put {result().linked} mention(s) back the way they were.</>}
              >
                Linked {result().linked} mention(s)
                {result().skipped > 0
                  ? `; left ${result().skipped} alone (inside code, a link, a tag or a URL)`
                  : ""}
                .{" "}
                <Show when={result().batchId}>
                  <button
                    type="button"
                    class="references-retry references-undo"
                    disabled={linkBusy()}
                    onClick={() => void undoLinkAll()}
                  >
                    <Undo2 size={12} aria-hidden="true" /> Undo
                  </button>
                </Show>
              </Show>
            </p>
          )}
        </Show>
        <Show when={linkError()}>
          {(message) => (
            <p class="references-error" role="alert">
              Couldn't link the mentions: {message()}
            </p>
          )}
        </Show>
      </div>
    </Show>
  );
}
