/**
 * `/history/*name` — a page's timeline (M7 item 8, ADR 022): every batch that touched the page,
 * newest first, what it did in words, and a word diff of any block text that changed. Two actions
 * per batch, both confirmed:
 *
 *  - **Undo** reverses just that batch (`batch.undo`).
 *  - **Restore this version** puts the page back as it was right after that batch. The op log has
 *    no snapshot to jump to; what it has is every batch's before-image, so "this version" is
 *    reached by undoing every NEWER batch, newest first, one `batch.undo` each. The walk is not
 *    atomic — if a step fails the page is left part-way and the message says how far it got — and
 *    a batch that also touched another page is undone there too. Each undo is its own audited
 *    batch, so the walk itself shows up in the timeline and can be undone again.
 *
 * The route is `/history/*name` rather than `/page/*name/history`: the page route is a splat, so
 * the latter would resolve as a page called "name/history".
 */

import { A, useParams } from "@solidjs/router";
import { type Accessor, createSignal, For, type JSX, Show } from "solid-js";
import { describeError } from "../data/api-client.js";
import {
  type HistoryBatch,
  type HistoryEntry,
  type HistorySnapshot,
  undoBatch,
  usePageHistory,
} from "../data/history.js";
import { displayRefName } from "../data/page-title.js";
import { diffProperties, diffWords, formatWhen } from "./historyText.js";
import { pageRoutePath, pathToPageName } from "./navigateTarget.js";
import "./history.css";

export function HistoryRoute(): JSX.Element {
  const params = useParams<{ name: string }>();
  return <HistoryView name={() => pathToPageName(params.name)} />;
}

const KIND_LABEL: Record<HistoryEntry["kind"], string> = {
  created: "added",
  edited: "edited",
  moved: "moved",
  deleted: "deleted",
  restored: "restored",
  renamed: "renamed",
  updated: "updated",
};

function markerOf(s: HistorySnapshot | null): string {
  return s?.marker ? `${s.marker} ` : "";
}

/** The text a block entry is about: the diff for an edit, the whole text otherwise. */
function BlockText(props: { entry: HistoryEntry }): JSX.Element {
  const before = () => props.entry.before;
  const after = () => props.entry.after;
  return (
    <Show
      when={props.entry.kind === "edited"}
      fallback={
        <span
          class={props.entry.kind === "deleted" ? "history-text history-text-del" : "history-text"}
        >
          {markerOf(after() ?? before())}
          {(after() ?? before())?.content ?? ""}
        </span>
      }
    >
      <span class="history-text">
        <Show when={markerOf(before()) !== markerOf(after())}>
          <del class="history-del">{markerOf(before())}</del>
          <ins class="history-add">{markerOf(after())}</ins>
        </Show>
        <For each={diffWords(before()?.content ?? "", after()?.content ?? "")}>
          {(part) =>
            part.kind === "same" ? (
              <span>{part.text}</span>
            ) : part.kind === "add" ? (
              <ins class="history-add">{part.text}</ins>
            ) : (
              <del class="history-del">{part.text}</del>
            )
          }
        </For>
      </span>
    </Show>
  );
}

function PropertyChanges(props: { entry: HistoryEntry }): JSX.Element {
  const changes = () =>
    diffProperties(props.entry.before?.properties, props.entry.after?.properties);
  return (
    <Show when={changes().length > 0}>
      <ul class="history-props">
        <For each={changes()}>
          {(c) => (
            <li>
              <span class="history-prop-key">{c.key}::</span>{" "}
              <Show when={c.before !== undefined}>
                <del class="history-del">{c.before}</del>{" "}
              </Show>
              <Show when={c.after !== undefined}>
                <ins class="history-add">{c.after}</ins>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

function Entry(props: { entry: HistoryEntry }): JSX.Element {
  const e = () => props.entry;
  return (
    <li class={`history-entry history-entry-${e().kind}`}>
      <span class="history-entry-kind">
        {e().entityType === "page" ? "page " : ""}
        {KIND_LABEL[e().kind]}
      </span>
      <div class="history-entry-body">
        <Show when={e().entityType === "page"}>
          <Show when={e().kind === "renamed"}>
            <span class="history-text">
              <del class="history-del">{e().before?.name}</del>{" "}
              <ins class="history-add">{e().after?.name}</ins>
            </span>
          </Show>
          <Show when={e().kind !== "renamed" && e().kind !== "updated"}>
            <span class="history-text">{e().after?.name ?? e().before?.name}</span>
          </Show>
        </Show>
        <Show when={e().entityType === "block"}>
          <BlockText entry={e()} />
        </Show>
        <PropertyChanges entry={e()} />
      </div>
    </li>
  );
}

export function HistoryView(props: { name: Accessor<string> }): JSX.Element {
  const history = usePageHistory(props.name);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const title = () => displayRefName(props.name());

  async function undoOne(batch: HistoryBatch): Promise<void> {
    if (!window.confirm(`Undo this change to "${title()}"?\n\n${batch.summary}`)) return;
    setBusy(batch.batchId);
    setError(null);
    setStatus(null);
    try {
      await undoBatch(batch.batchId);
      setStatus("Undone.");
      history.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  /** Undo every batch newer than `index` (all of them lie above it in the list), newest first. */
  async function restoreVersion(index: number): Promise<void> {
    const newer = history.batches().slice(0, index);
    if (newer.length === 0) return;
    const n = newer.length;
    const ok = window.confirm(
      `Restore "${title()}" as it was after this change?\n\n` +
        `This undoes the ${n} newer change${n === 1 ? "" : "s"} above it, newest first. ` +
        "A change that also touched another page is undone there too. " +
        "The undos are themselves recorded, so you can undo them in turn.",
    );
    if (!ok) return;
    setBusy(history.batches()[index]?.batchId ?? "restore");
    setError(null);
    let done = 0;
    try {
      for (const batch of newer) {
        setStatus(`Undoing ${done + 1} of ${n}…`);
        await undoBatch(batch.batchId);
        done++;
      }
      setStatus(`Restored: ${n} change${n === 1 ? "" : "s"} undone.`);
    } catch (err) {
      setStatus(null);
      setError(
        `Stopped after undoing ${done} of ${n}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(null);
      history.refetch();
    }
  }

  /** A failed older page used to re-enable the button with no word and an unhandled rejection, so
   * a failure looked like "nothing older" (B-131). */
  async function loadOlder(): Promise<void> {
    setError(null);
    try {
      await history.loadMore();
    } catch (err) {
      setError(`Could not load older changes: ${describeError(err)}`);
    }
  }

  return (
    <div class="history-view">
      <header class="history-header">
        <A href={pageRoutePath(props.name())} class="history-back">
          ← {title()}
        </A>
        <h1>History</h1>
        <p class="history-note">
          Every change to this page, newest first. Undo reverses one change; Restore puts the page
          back as it was right after a change by undoing everything newer.
        </p>
      </header>

      <Show when={status()}>
        {(s) => (
          <p class="history-status" role="status">
            {s()}
          </p>
        )}
      </Show>
      <Show when={error()}>
        {(e) => (
          <p class="history-error" role="alert">
            {e()}
          </p>
        )}
      </Show>
      <Show when={history.first.error}>
        <p class="history-error" role="alert">
          Could not load the history: {describeError(history.first.error)}{" "}
          <button type="button" class="history-retry" onClick={() => history.refetch()}>
            Retry
          </button>
        </p>
      </Show>

      <Show when={history.first.loading && history.firstPage() === undefined}>
        <p class="history-empty">Loading…</p>
      </Show>
      <Show when={history.firstPage() && history.batches().length === 0}>
        <p class="history-empty">No recorded changes.</p>
      </Show>

      <ol class="history-timeline">
        <For each={history.batches()}>
          {(batch, index) => (
            <li class="history-batch" data-batch-id={batch.batchId}>
              <div class="history-batch-head">
                <time class="history-when" dateTime={batch.at} title={batch.at}>
                  {formatWhen(batch.at)}
                </time>
                <span class="history-actor">{batch.actor}</span>
                <span class="history-origin">{batch.origin}</span>
                <span class="history-summary">{batch.summary}</span>
                <span class="history-actions">
                  <button
                    type="button"
                    class="history-undo"
                    disabled={busy() !== null}
                    onClick={() => void undoOne(batch)}
                  >
                    Undo
                  </button>
                  <Show when={index() > 0}>
                    <button
                      type="button"
                      class="history-restore"
                      disabled={busy() !== null}
                      onClick={() => void restoreVersion(index())}
                    >
                      Restore this version
                    </button>
                  </Show>
                </span>
              </div>
              <ul class="history-entries">
                <For each={batch.entries}>{(entry) => <Entry entry={entry} />}</For>
              </ul>
            </li>
          )}
        </For>
      </ol>

      <Show when={history.hasMore()}>
        <button
          type="button"
          class="history-more"
          disabled={history.loadingMore()}
          onClick={() => void loadOlder()}
        >
          {history.loadingMore() ? "Loading…" : "Older changes"}
        </button>
      </Show>
    </div>
  );
}
